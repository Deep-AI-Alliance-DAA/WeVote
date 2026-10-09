#!/usr/bin/env node
// Integration tests use disposable local KV/Durable Objects and Cloudflare's
// public Turnstile test keys. Voting checks need outbound HTTPS to Siteverify;
// no Cloudflare account, deployment credential, or production data is used.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const suites = ["smoke-events.mjs", "smoke-admin.mjs", "smoke-drafts.mjs"];
const abort = new AbortController();
const generatedSecrets = [0, 1, 2].map(() => randomBytes(32).toString("hex"));
let workspace;
let worker;
let activeSuite;
let workerLog = "";
let interruptCode;

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
  await Promise.all([
    cp(join(root, "src"), join(workspace, "src"), { recursive: true }),
    cp(join(root, "public"), join(workspace, "public"), { recursive: true }),
    cp(join(root, "wrangler.worker.jsonc"), join(workspace, "wrangler.worker.jsonc")),
    ...suites.map((filename) => cp(join(root, "scripts", filename), join(workspace, "scripts", filename))),
  ]);
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
