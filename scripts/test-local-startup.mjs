#!/usr/bin/env node
// Offline regression gate for the runner's startup retry boundary. A temporary
// Wrangler stand-in creates real local bind collisions; no Worker tests run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(fileURLToPath(import.meta.url));
const fixture = await realpath(await mkdtemp(join(tmpdir(), "wevote-startup-test-")));
const trace = join(fixture, "trace.jsonl");
const suites = ["smoke-events.mjs", "smoke-admin.mjs", "smoke-drafts.mjs"];

const wranglerStub = `
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
const trace = process.env.WEVOTE_STARTUP_TRACE;
const mode = process.env.WEVOTE_STARTUP_MODE;
const prior = (await readFile(trace, "utf8")).trim().split("\\n").filter(Boolean).map(JSON.parse);
const attempt = prior.filter(entry => entry.start).length + 1;
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const inspector = Number(process.argv[process.argv.indexOf("--inspector-port") + 1]);
const state = join(process.cwd(), "state");
const previousState = await stat(state).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error));
await appendFile(trace, JSON.stringify({start:attempt, port, inspector, workspace:process.cwd(), previousState}) + "\\n");
await mkdir(state, {recursive:true});
await writeFile(join(state, "startup-marker"), "disposable");
if (mode === "config-error") {
  console.error("Invalid Wrangler configuration");
  process.exit(1);
}
if (mode === "always-bind" || attempt === 1) {
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(port, "127.0.0.1", resolve));
  const colliding = createServer();
  colliding.once("error", error => {
    if (error.code !== "EADDRINUSE") throw error;
    console.error("bind(): Address already in use (os error 98)");
    blocker.close(() => process.exit(1));
  });
  colliding.listen(port, "127.0.0.1");
} else {
  const server = createHttpServer((request, response) => {
    response.writeHead(401, {"Content-Type":"application/json"});
    response.end(JSON.stringify({error:"Unauthorized"}));
  });
  server.listen(port, "127.0.0.1");
}
`;

async function run(mode) {
  await writeFile(trace, "");
  const child = spawn(process.execPath, [join(fixture, "scripts", "test-local.mjs")], {
    cwd: fixture,
    env: { ...process.env, WEVOTE_STARTUP_TRACE: trace, WEVOTE_STARTUP_MODE: mode },
    stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const entries = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const starts = entries.filter(entry => entry.start);
  const ranSuites = entries.filter(entry => entry.suite);
  const ports = starts.flatMap(entry => [entry.port, entry.inspector]);
  assert.equal(new Set(ports).size, ports.length, "Every startup must use distinct fresh HTTP/inspector ports.");
  assert.ok(starts.every(entry => !entry.previousState), "Startup retry must remove prior state before tests begin.");
  for (const { workspace } of starts) {
    await assert.rejects(stat(workspace), error => error.code === "ENOENT", "Temporary workspace must be removed on success and failure.");
  }
  for (const { port } of starts) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/admin/me`, { signal: AbortSignal.timeout(1000) }), "Every started local server must stop.");
  }
  return { code, output, starts, ranSuites };
}

try {
  for (const directory of ["src", "public", "scripts", "node_modules/wrangler/bin"]) {
    await mkdir(join(fixture, directory), { recursive: true });
  }
  await writeFile(join(fixture, "package.json"), '{"type":"module"}\n');
  await writeFile(join(fixture, "wrangler.worker.jsonc"), "{}\n");
  await copyFile(join(source, "test-local.mjs"), join(fixture, "scripts", "test-local.mjs"));
  await writeFile(join(fixture, "node_modules/wrangler/bin/wrangler.js"), wranglerStub);
  for (const suite of suites) {
    await writeFile(join(fixture, "scripts", suite), `
import assert from "node:assert/strict";
import {appendFile, readFile} from "node:fs/promises";
const vars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
assert.equal(/^PUBLIC_BASE_URL="([^"]+)"/m.exec(vars)[1], process.argv[2]);
await appendFile(process.env.WEVOTE_STARTUP_TRACE, JSON.stringify({suite:${JSON.stringify(suite)}}) + "\\n");
if (process.env.WEVOTE_STARTUP_MODE === "suite-error") process.exit(17);
`);
  }
  const recovery = await run("recover");
  assert.equal(recovery.code, 0);
  assert.equal(recovery.starts.length, 2);
  assert.equal((recovery.output.match(/retrying startup/g) || []).length, 1);
  assert.deepEqual(recovery.ranSuites.map(entry => entry.suite), suites);

  const configuration = await run("config-error");
  assert.equal(configuration.code, 1);
  assert.equal(configuration.starts.length, 1);
  assert.equal(configuration.ranSuites.length, 0);
  assert.ok(!configuration.output.includes("retrying startup"));

  const exhausted = await run("always-bind");
  assert.equal(exhausted.code, 1);
  assert.equal(exhausted.starts.length, 3);
  assert.equal(exhausted.ranSuites.length, 0);
  assert.equal((exhausted.output.match(/retrying startup/g) || []).length, 2);

  const failure = await run("suite-error");
  assert.equal(failure.code, 1);
  assert.equal(failure.starts.length, 2);
  assert.deepEqual(failure.ranSuites.map(entry => entry.suite), [suites[0]]);
  assert.equal((failure.output.match(/retrying startup/g) || []).length, 1);
  console.log("Local startup regression passed: bind recovery, fresh ports/state, bounded attempts, no config/test retries, and cleanup.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
