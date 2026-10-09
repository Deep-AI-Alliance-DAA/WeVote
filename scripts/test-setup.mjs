#!/usr/bin/env node
// Run only temporary helper copies and an offline Wrangler stub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await realpath(await mkdtemp(join(tmpdir(), "wevote-setup-test-")));
const traceFile = join(fixture, "offline-trace.jsonl");
let checks = 0;
const check = (condition, label) => { checks++; assert.ok(condition, label); };
const setupArgs = [
  "--account-id", "a".repeat(32), "--kv-id", "b".repeat(32),
  "--worker", "fixture-wevote-api", "--pages", "fixture-wevote",
  "--url", "https://fixture-wevote.invalid", "--site-key", "fixture_public_turnstile_key_2026",
];
const generated = ["wrangler.worker.local.jsonc", ".cloudflare/pages/wrangler.jsonc", ".env.production.json"];
const json = async (path) => JSON.parse(await readFile(join(fixture, path), "utf8"));
const writeJson = (path, data) => writeFile(join(fixture, path), `${JSON.stringify(data)}\n`, { mode: 0o600 });
const run = (script, args = []) => spawnSync(process.execPath, [join(fixture, "scripts", script), ...args], {
  cwd: fixture, encoding: "utf8", timeout: 10_000,
  env: { PATH: "", WEVOTE_TEST_LOG: traceFile, CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) },
});
const changedArgs = (flag, value) => {
  const args = [...setupArgs];
  args[args.indexOf(flag) + 1] = value;
  return args;
};
const readTrace = async () => {
  try { return (await readFile(traceFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const rejectDeploy = async (args, label) => {
  const before = (await readTrace()).length;
  check(run("deploy-cloudflare.mjs", args).status !== 0, label);
  check((await readTrace()).length === before, `${label}: no child command ran`);
};

try {
  await mkdir(join(fixture, "scripts"));
  for (const path of ["wrangler.jsonc", "wrangler.worker.jsonc", "scripts/setup-cloudflare.mjs", "scripts/deploy-cloudflare.mjs"]) {
    await copyFile(join(sourceRoot, path), join(fixture, path));
  }

  check(run("setup-cloudflare.mjs", ["--help"]).status === 0, "Setup help is available without configuration");
  check(run("setup-cloudflare.mjs").status !== 0, "Missing setup arguments are rejected");
  for (const [flag, value] of [
    ["--account-id", "0".repeat(32)], ["--kv-id", "invalid"],
    ["--worker", "Bad_Name"], ["--pages", "x"],
    ["--url", "http://fixture-wevote.invalid"], ["--url", "https://localhost"],
    ["--url", "https://user:password@fixture-wevote.invalid"],
    ["--url", "https://fixture-wevote.invalid/path"], ["--url", "https://fixture-wevote.invalid/?query=yes"],
    ["--site-key", `1x${"0".repeat(25)}`],
  ]) {
    check(run("setup-cloudflare.mjs", changedArgs(flag, value)).status !== 0, `Invalid setup ${flag} is rejected`);
  }
  for (const path of generated) {
    let exists = true;
    try { await stat(join(fixture, path)); } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
    check(!exists, "Invalid setup leaves no generated files");
  }

  const setup = run("setup-cloudflare.mjs", setupArgs);
  check(setup.status === 0, "Valid setup succeeds offline");
  const worker = await json(generated[0]);
  const pages = await json(generated[1]);
  const secrets = await json(generated[2]);
  check(worker.account_id === "a".repeat(32) && pages.account_id === worker.account_id, "Worker and Pages use the same account");
  check(worker.kv_namespaces.length === 1 && worker.kv_namespaces[0].binding === "EVENTS" && worker.kv_namespaces[0].id === "b".repeat(32), "KV binding uses the requested namespace");
  check(pages.services.length === 1 && pages.services[0].binding === "WEVOTE_API" && pages.services[0].service === worker.name, "Pages service targets the generated Worker");
  check(worker.workers_dev === false && worker.preview_urls === false, "Direct Worker and preview URLs are disabled");
  check(worker.vars.PUBLIC_BASE_URL === "https://fixture-wevote.invalid", "Public origin is preserved");
  check(resolve(fixture, ".cloudflare/pages", pages.pages_build_output_dir) === join(fixture, "pages/dist"), "Pages output path resolves to the project build directory");
  check(resolve(fixture, ".cloudflare/pages", pages.$schema) === join(fixture, "node_modules/wrangler/config-schema.json"), "Pages schema path resolves to project dependencies");
  const bindingClasses = { VOTE_SHARD: "VoteShard", EVENT_COORDINATOR: "EventCoordinator", ADMIN_DIRECTORY: "AdminDirectory" };
  check(worker.durable_objects.bindings.length === 3 && worker.durable_objects.bindings.every((entry) => bindingClasses[entry.name] === entry.class_name), "Durable Object bindings are retained");
  check(worker.migrations.flatMap((entry) => entry.new_sqlite_classes).join("|") === Object.values(bindingClasses).join("|"), "SQLite migrations retain all three Durable Object classes");
  const privateKeys = [secrets.VOTE_SIGNING_KEY, secrets.ADMIN_DASHBOARD_KEY, secrets.ADMIN_EXPORT_KEY];
  check(privateKeys.every((value) => /^[a-f0-9]{64}$/.test(value)) && new Set(privateKeys).size === 3, "Setup generates independent 256-bit private keys");
  check(secrets.TURNSTILE_SITE_KEY === "fixture_public_turnstile_key_2026" && secrets.TURNSTILE_SECRET_KEY === "", "Setup requires the operator to add the Turnstile secret");
  check(privateKeys.every((value) => !`${setup.stdout}${setup.stderr}`.includes(value)), "Setup output never prints private keys");
  for (const path of generated) {
    if (process.platform !== "win32") check(((await stat(join(fixture, path))).mode & 0o777) === 0o600, "Generated files have private permissions");
  }
  if (process.platform !== "win32") check(((await stat(join(fixture, ".cloudflare/pages"))).mode & 0o777) === 0o700, "Generated Pages directory has private permissions");
  const beforeRetry = await Promise.all(generated.map((path) => readFile(join(fixture, path))));
  check(run("setup-cloudflare.mjs", setupArgs).status !== 0, "Setup refuses to overwrite existing files");
  const afterRetry = await Promise.all(generated.map((path) => readFile(join(fixture, path))));
  check(beforeRetry.every((value, index) => value.equals(afterRetry[index])), "A refused setup preserves every existing file");
  // An existing secret file alone must reject setup before creating config files.
  for (const path of generated.slice(0, 2)) await rm(join(fixture, path));
  check(run("setup-cloudflare.mjs", setupArgs).status !== 0, "An existing secret file blocks setup");
  check((await readFile(join(fixture, generated[2]))).equals(beforeRetry[2]), "An existing secret file remains unchanged");
  for (const [index, path] of generated.slice(0, 2).entries()) {
    let exists = true;
    try { await stat(join(fixture, path)); } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
    check(!exists, "Secret-file preflight creates no partial config files");
    await writeFile(join(fixture, path), beforeRetry[index], { mode: 0o600 });
  }

  // An empty generated Turnstile secret must fail before invoking Wrangler.
  const emptySecret = run("deploy-cloudflare.mjs", ["api", "--dry-run"]);
  check(emptySecret.status !== 0 && emptySecret.stderr.includes("TURNSTILE_SECRET_KEY"), "Deployment rejects the generated empty Turnstile secret");
  check((await readTrace()).length === 0, "Missing-secret rejection invokes no child command");

  // These are the only child programs available to the copied deploy helper.
  await mkdir(join(fixture, "node_modules/wrangler/bin"), { recursive: true });
  await writeJson("node_modules/wrangler/package.json", { type: "module" });
  await writeFile(join(fixture, "node_modules/wrangler/bin/wrangler.js"), `
import { appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "pages" && !existsSync("wrangler.jsonc")) process.exit(2);
appendFileSync(process.env.WEVOTE_TEST_LOG, JSON.stringify({ kind: "wrangler", cwd: process.cwd(), args, metrics: process.env.WRANGLER_SEND_METRICS, account: process.env.CLOUDFLARE_ACCOUNT_ID }) + "\\n");
`);
  await writeFile(join(fixture, "scripts/build-pages.mjs"), `
import { appendFileSync, mkdirSync } from "node:fs";
mkdirSync("pages/dist", { recursive: true });
appendFileSync(process.env.WEVOTE_TEST_LOG, JSON.stringify({ kind: "build", cwd: process.cwd() }) + "\\n");
`);
  const productionSecrets = { ...secrets, TURNSTILE_SECRET_KEY: "fixture_secret_turnstile_key_2026" };
  const malformedMarker = "sensitive_fixture_value_not_for_error_output";
  await writeFile(join(fixture, generated[2]), `{"TURNSTILE_SECRET_KEY":"${malformedMarker}", invalid}`, { mode: 0o600 });
  const malformed = run("deploy-cloudflare.mjs", ["api", "--dry-run"]);
  check(malformed.status !== 0 && malformed.stderr.includes("Invalid JSON in .env.production.json"), "Malformed secret JSON produces a filename-only error");
  check(!`${malformed.stdout}${malformed.stderr}`.includes(malformedMarker), "Malformed secret JSON is not quoted in error output");
  check((await readTrace()).length === 0, "Malformed secret JSON invokes no child command");
  await writeJson(generated[2], productionSecrets);
  for (const args of [["unknown"], ["pages", "--dry-run"], ["api", "--force"]]) await rejectDeploy(args, "Invalid deployment arguments are rejected");
  for (const badSecrets of [
    { ...productionSecrets, VOTE_SIGNING_KEY: "short" },
    { ...productionSecrets, ADMIN_EXPORT_KEY: productionSecrets.ADMIN_DASHBOARD_KEY },
    { ...productionSecrets, TURNSTILE_SITE_KEY: `1x${"0".repeat(25)}` },
    { ...productionSecrets, TURNSTILE_SECRET_KEY: `2x${"0".repeat(25)}` },
  ]) {
    await writeJson(generated[2], badSecrets);
    await rejectDeploy(["api", "--dry-run"], "Invalid or reused deployment credentials are rejected");
  }
  await writeJson(generated[2], productionSecrets);
  for (const badPages of [
    { ...pages, account_id: "c".repeat(32) },
    { ...pages, services: [{ binding: "WEVOTE_API", service: "wrong-api" }] },
    { ...pages, pages_build_output_dir: "../../another-directory" },
  ]) {
    await writeJson(generated[1], badPages);
    await rejectDeploy(["api", "--dry-run"], "Inconsistent account or service configuration is rejected");
  }
  await writeJson(generated[1], pages);
  for (const badWorker of [
    { ...worker, workers_dev: true }, { ...worker, preview_urls: true },
    { ...worker, kv_namespaces: [{ binding: "EVENTS", id: "0".repeat(32) }] },
    ...[
      "http://fixture-wevote.invalid", "https://localhost", "https://127.0.0.1", "https://[::1]",
      "https://user:password@fixture-wevote.invalid", "https://fixture-wevote.invalid/path",
      "https://fixture-wevote.invalid/?query=yes", "https://fixture-wevote.invalid/#fragment",
    ].map((url) => ({ ...worker, vars: { ...worker.vars, PUBLIC_BASE_URL: url } })),
  ]) {
    await writeJson(generated[0], badWorker);
    await rejectDeploy(["api", "--dry-run"], "Unsafe or incomplete Worker configuration is rejected");
  }
  await writeJson(generated[0], worker);

  check(run("deploy-cloudflare.mjs", ["api", "--dry-run"]).status === 0, "API dry run reaches only the offline Wrangler stub");
  check(run("deploy-cloudflare.mjs", ["pages"]).status === 0, "Pages deployment reaches only offline build/Wrangler stubs");
  const trace = await readTrace();
  check(trace.length === 3 && trace[0].kind === "wrangler" && trace[1].kind === "build" && trace[2].kind === "wrangler", "Pages build runs before Pages deploy");
  check(trace[0].cwd === fixture && trace[1].cwd === fixture && trace[2].cwd === join(fixture, ".cloudflare/pages"), "Children run beside their correct configuration files");
  check(trace[0].args.join("|") === "deploy|--config|wrangler.worker.local.jsonc|--secrets-file|.env.production.json|--dry-run|--outdir|.cloudflare/dry-run", "API deploy passes the secret file path and dry-run flags");
  check(trace[2].args.join("|") === "pages|deploy|--project-name|fixture-wevote|--branch|main", "Pages deploy uses its generated project configuration");
  check(trace[0].account === worker.account_id, "API deployment overrides an inherited account with the configured account");
  check(trace[2].account === worker.account_id, "Pages deployment overrides an inherited account with the configured account");
  check(trace.filter((entry) => entry.kind === "wrangler").every((entry) => entry.metrics === "false"), "Wrangler telemetry is disabled");
  const invocationLog = JSON.stringify(trace);
  check([...privateKeys, productionSecrets.TURNSTILE_SECRET_KEY].every((value) => !invocationLog.includes(value)), "Private credentials never appear in command arguments");
  console.log(`Offline Cloudflare helper checks passed (${checks} assertions).`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
