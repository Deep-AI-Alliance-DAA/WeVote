#!/usr/bin/env node
// Integration tests use disposable local KV/Durable Objects and Cloudflare's
// public Turnstile test keys. Voting checks need outbound HTTPS to Siteverify;
// no Cloudflare account, deployment credential, or production data is used.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const allSuites = ["smoke-events.mjs", "smoke-admin.mjs", "smoke-drafts.mjs", "smoke-signup.mjs"];
const argumentsList = process.argv.slice(2);
if (argumentsList.length && (argumentsList.length !== 2 || argumentsList[0] !== "--suite" || !allSuites.includes(`smoke-${argumentsList[1]}.mjs`))) {
  throw new Error("Usage: node scripts/test-local.mjs [--suite events|admin|drafts|signup]");
}
const suites = argumentsList.length ? [`smoke-${argumentsList[1]}.mjs`] : allSuites;
const abort = new AbortController();
const generatedSecrets = [0, 1, 2].map(() => randomBytes(32).toString("hex"));
let workspace;
let worker;
let activeSuite;
let workerLog = "";
let interruptCode;

// This source is written only inside the disposable test workspace. Production
// src/worker.js, build output and deployment entry points never import it.
const fixtureWorker = String.raw`
import application from "./worker.js";
export { VoteShard, EventCoordinator, AdminDirectory } from "./worker.js";
function json(body, status = 200) { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function sorted(value) { return Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value; }
async function fingerprint(value) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted(value))))), byte => byte.toString(16).padStart(2, "0")).join(""); }
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/__local_test__/")) return application.fetch(request, env, context);
    if (env.LOCAL_TEST_FIXTURES !== "disposable-only" || request.method !== "POST" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" ||
        request.headers.get("Origin") !== url.origin || request.headers.get("Authorization") !== "Bearer " + env.ADMIN_DASHBOARD_KEY) return json({ error: "Local fixture access denied" }, 403);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 8192) return json({ error: "Fixture too large" }, 413);
    let input;
    try { input = JSON.parse(body); } catch { return json({ error: "Invalid fixture" }, 400); }
    const directory = env.ADMIN_DIRECTORY.getByName("global");
    if (url.pathname === "/api/__local_test__/seed-account") {
      const principal = await directory.resolveOAuthAccount(input);
      if (!principal) return json({ error: "Fixture account unavailable" }, 403);
      const token = await directory.createSession(principal);
      return json({ principal, cookie: "wv_admin=" + token }, 201);
    }
    if (url.pathname === "/api/__local_test__/reserve-intent") {
      const result = await directory.reserveSelfRegisteredEvent(input.accountId, {
        requestId: input.requestId, payloadHash: await fingerprint(input.input), eventId: input.event.id, event: input.event,
      });
      return json(result);
    }
    if (url.pathname === "/api/__local_test__/inspect-storage") {
      if (!/^[a-f0-9]{24}$/.test(input.eventId) || !Array.isArray(input.shardIndexes) || input.shardIndexes.length > 2 ||
          input.shardIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= 128)) return json({ error: "Invalid storage query" }, 400);
      const object = env.EVENT_COORDINATOR.getByName(input.eventId);
      const config = await object.getConfig();
      const totals = await Promise.all(input.shardIndexes.map(async index => {
        const shard = env.VOTE_SHARD.get(env.VOTE_SHARD.idFromName(input.eventId + ":" + index));
        return (await (await shard.fetch("https://shard.internal/count")).json()).turnout;
      }));
      return json({ coordinatorExists: Boolean(config), coordinatorTurnout: config?.trial ? (await object.snapshot()).turnout : null, shardTurnouts: totals });
    }
    return json({ error: "Unknown local fixture" }, 404);
  },
};
`;

// Isolate Wrangler's config/cache as well as its CLI environment, so existing
// login sessions and process-level deployment credentials are not consulted.
function localEnvironment(directory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE_|CF_|WRANGLER_)/i.test(key)));
  return {
    ...env,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
  };
}

function managedProcess(command, args, options) {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32" });
  let finished = false;
  const done = new Promise((resolve) => {
    child.once("error", (error) => { finished = true; resolve({ error }); });
    child.once("close", (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  return { child, done, get finished() { return finished; } };
}

async function terminate(processHandle) {
  if (!processHandle) return;
  const { child, done } = processHandle;
  if (!child.pid || processHandle.finished) return;
  if (process.platform === "win32") {
    if (!processHandle.finished) {
      const killer = managedProcess("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      await Promise.race([killer.done, delay(3000)]);
    }
    return;
  }
  // Kill the process group too: Wrangler starts a separate workerd process.
  try { process.kill(-child.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  await Promise.race([done, delay(3000, undefined, { ref: false })]);
  if (processHandle.finished) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  await Promise.race([done, delay(1000, undefined, { ref: false })]);
}

async function reservePort(excluded = new Set()) {
  for (let pick = 0; pick < 10; pick++) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const release = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (excluded.has(port)) {
      await release();
      continue;
    }
    excluded.add(port);
    return {
      port,
      release,
    };
  }
  throw new Error("Could not reserve a fresh local test port.");
}

function ensureNotInterrupted() {
  if (abort.signal.aborted) throw new Error("Local tests interrupted.");
}

async function waitUntilReady(baseUrl) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    ensureNotInterrupted();
    if (worker.finished) {
      const result = await worker.done;
      throw new Error(result.error?.message || `Local Worker exited before readiness (${result.code ?? result.signal}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/admin/me`, {
        redirect: "manual", signal: AbortSignal.timeout(1500),
      });
      const body = await response.json();
      if (response.status === 401 && body && typeof body === "object") return;
    } catch {
      // The port opens only after Wrangler has bundled and started workerd.
    }
    await delay(200, undefined, { signal: abort.signal });
  }
  throw new Error("Local Worker did not become ready within 60 seconds.");
}

async function runSuite(filename, baseUrl, env) {
  ensureNotInterrupted();
  console.log(`Running ${filename}…`);
  activeSuite = managedProcess(process.execPath, [join(workspace, "scripts", filename), baseUrl], {
    cwd: workspace, env, stdio: "inherit",
  });
  let timer;
  let onAbort;
  try {
    const result = await Promise.race([
      activeSuite.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${filename} exceeded 180 seconds.`)), 180_000);
        onAbort = () => reject(new Error("Local tests interrupted."));
        abort.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${filename} failed (${result.code ?? result.signal}).`);
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", onAbort);
    await terminate(activeSuite);
    activeSuite = undefined;
  }
}

function captureLog(chunk) {
  workerLog = `${workerLog}${chunk}`.slice(-32_000);
}

function safeLog() {
  let log = workerLog;
  for (const secret of generatedSecrets) log = log.replaceAll(secret, "[redacted local key]");
  return log.trim();
}

function interrupt(signal) {
  interruptCode ??= signal === "SIGINT" ? 130 : 143;
  abort.abort();
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

try {
  workspace = await mkdtemp(join(tmpdir(), "wevote-local-tests-"));
  await mkdir(join(workspace, "scripts"));
  await mkdir(join(workspace, "node_modules"));
  await Promise.all([
    cp(join(root, "src"), join(workspace, "src"), { recursive: true }),
    cp(join(root, "public"), join(workspace, "public"), { recursive: true }),
    cp(join(root, "wrangler.worker.jsonc"), join(workspace, "wrangler.worker.jsonc")),
    cp(join(root, "node_modules", "jose"), join(workspace, "node_modules", "jose"), { recursive: true }),
    ...suites.map((filename) => cp(join(root, "scripts", filename), join(workspace, "scripts", filename))),
  ]);
  const configPath = join(workspace, "wrangler.worker.jsonc");
  const originalConfig = await readFile(configPath, "utf8");
  if (!/"main"\s*:\s*"src\/worker\.js"/.test(originalConfig)) throw new Error("Local test template must use the original Worker entry point.");
  await writeFile(configPath, originalConfig.replace(/("main"\s*:\s*)"src\/worker\.js"/, '$1"src/local-fixture-worker.js"'));
  await writeFile(join(workspace, "src", "local-fixture-worker.js"), fixtureWorker, { flag: "wx", mode: 0o600 });
  await writeFile(join(workspace, ".local-fixture.json"), JSON.stringify({ kind: "disposable-wevote-integration", version: 1 }), { flag: "wx", mode: 0o600 });
  ensureNotInterrupted();
  const env = localEnvironment(workspace);
  const usedPorts = new Set();
  let baseUrl;
  for (let attempt = 1; attempt <= 3; attempt++) {
    workerLog = "";
    const http = await reservePort(usedPorts);
    let inspector;
    try {
      inspector = await reservePort(usedPorts);
      baseUrl = `http://127.0.0.1:${http.port}`;
      const now = Date.now();
      const vars = [
        `PUBLIC_BASE_URL="${baseUrl}"`,
        'LOCAL_TEST_FIXTURES="disposable-only"',
        'POLL_ID="demo-local"',
        'POLL_QUESTION="Choose a local test option"',
        `POLL_OPTIONS_JSON='${JSON.stringify([{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }])}'`,
        `POLL_OPENS_AT="${new Date(now - 60_000).toISOString()}"`,
        `POLL_CLOSES_AT="${new Date(now + 2 * 60 * 60_000).toISOString()}"`,
        `VOTE_SIGNING_KEY="${generatedSecrets[0]}"`,
        'TURNSTILE_SITE_KEY="1x00000000000000000000AA"',
        'TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"',
        `ADMIN_DASHBOARD_KEY="${generatedSecrets[1]}"`,
        `ADMIN_EXPORT_KEY="${generatedSecrets[2]}"`,
      ];
      await writeFile(join(workspace, ".dev.vars"), `${vars.join("\n")}\n`, { flag: attempt === 1 ? "wx" : "w", mode: 0o600 });
      await http.release();
      await inspector.release();
      ensureNotInterrupted();
      console.log("Starting a disposable local Worker (no Cloudflare login required)…");
      worker = managedProcess(process.execPath, [
        join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
        "dev", "--config", join(workspace, "wrangler.worker.jsonc"),
        "--local", "--ip", "127.0.0.1", "--port", String(http.port),
        "--inspector-port", String(inspector.port), "--persist-to", join(workspace, "state"),
        "--show-interactive-dev-session", "false", "--log-level", "error",
      ], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
      worker.child.stdout.on("data", captureLog);
      worker.child.stderr.on("data", captureLog);
      await waitUntilReady(baseUrl);
      break;
    } catch (error) {
      // Miniflare opens internal ephemeral listeners before workerd binds our
      // released HTTP/inspector ports. Retry only an explicit startup collision.
      const collision = /\bEADDRINUSE\b|bind\(\): Address already in use \(os error (?:48|98)\)/.test(`${error.message}\n${workerLog}`);
      if (abort.signal.aborted || !collision || attempt === 3) throw error;
      await terminate(worker);
      worker = undefined;
      await rm(join(workspace, "state"), { recursive: true, force: true });
      console.warn(`Local port collision before readiness; retrying startup (${attempt + 1}/3).`);
      await delay(200, undefined, { signal: abort.signal });
    } finally {
      // Reservations must also close if setup fails before spawning Wrangler.
      await http.release().catch(() => {});
      if (inspector) await inspector.release().catch(() => {});
    }
  }
  // Test failures are final: only the pre-readiness startup can be retried.
  for (const filename of suites) await runSuite(filename, baseUrl, env);
  console.log("All local integration suites passed.");
} catch (error) {
  process.exitCode = interruptCode || 1;
  console.error(error.message);
  if (!interruptCode && safeLog()) console.error(`Local Worker log:\n${safeLog()}`);
} finally {
  const cleanup = await Promise.allSettled([terminate(activeSuite), terminate(worker)]);
  if (workspace) await rm(workspace, { recursive: true, force: true });
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (interruptCode) process.exitCode = interruptCode;
  for (const result of cleanup) {
    if (result.status === "rejected") {
      console.error(`Local process cleanup failed: ${result.reason.message}`);
      process.exitCode ||= 1;
    }
  }
  console.log("Local Worker stopped; temporary keys and test state removed.");
}
