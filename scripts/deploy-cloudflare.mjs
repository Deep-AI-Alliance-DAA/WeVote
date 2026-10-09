import { spawn } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [target, ...options] = process.argv.slice(2);
const allowedOption = target === "api" ? "--dry-run" : "--with-private-assets";
if (!["api", "pages"].includes(target) || options.length > 1 || (options.length && options[0] !== allowedOption)) {
  console.error("Usage: node scripts/deploy-cloudflare.mjs api [--dry-run] | pages [--with-private-assets]");
  process.exit(1);
}
const dryRun = options.includes("--dry-run");
const withPrivateAssets = options.includes("--with-private-assets");

async function run(args, cwd = root, accountId) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit", env: {
    ...process.env, WRANGLER_SEND_METRICS: "false",
    ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
  } });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : code));
  });
  if (code !== 0) throw new Error(`Command failed (exit ${code}).`);
}

async function readJson(filename) {
  const data = await readFile(resolve(root, filename), "utf8");
  try { return JSON.parse(data); }
  catch { throw new Error(`Invalid JSON in ${filename}. Fix it in a local editor; do not share its contents.`); }
}

try {
  const worker = await readJson("wrangler.worker.local.jsonc");
  const pages = await readJson(".cloudflare/pages/wrangler.jsonc");
  const isId = (value) => typeof value === "string" && /^(?!0{32}$)[a-f0-9]{32}$/i.test(value);
  const publicUrl = new URL(worker.vars?.PUBLIC_BASE_URL);
  const originOnly = publicUrl.protocol === "https:" && !publicUrl.username && !publicUrl.password &&
    publicUrl.pathname === "/" && !publicUrl.search && !publicUrl.hash &&
    !["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  // Pages rejects account_id in its config. Pin both CLI invocations through
  // CLOUDFLARE_ACCOUNT_ID using the validated Worker configuration instead.
  if (!isId(worker.account_id) || pages.account_id !== undefined ||
      !isId(worker.kv_namespaces?.find((entry) => entry.binding === "EVENTS")?.id) ||
      !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(worker.name || "") || worker.name === "wevote-local-api" ||
      !/^[a-z][a-z0-9-]{1,56}[a-z0-9]$/.test(pages.name || "") ||
      pages.services?.find((entry) => entry.binding === "WEVOTE_API")?.service !== worker.name ||
      pages.pages_build_output_dir !== "../../pages/dist" ||
      worker.workers_dev !== false || worker.preview_urls !== false ||
      !originOnly) {
    throw new Error("Deployment configuration is incomplete or inconsistent. Run setup:cloudflare for your own account.");
  }
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  console.log(`${dryRun ? "Checking" : "Deploying"} ${target}: ${target === "api" ? worker.name : pages.name} in account ${worker.account_id}.`);
  if (target === "api") {
    const secrets = await readJson(".env.production.json");
    for (const name of ["VOTE_SIGNING_KEY", "ADMIN_DASHBOARD_KEY", "ADMIN_EXPORT_KEY"]) {
      if (typeof secrets[name] !== "string" || secrets[name].length < 32 || /replace|example|change.?me/i.test(secrets[name])) throw new Error(`${name} needs a private random key of at least 32 characters.`);
    }
    if (new Set([secrets.VOTE_SIGNING_KEY, secrets.ADMIN_DASHBOARD_KEY, secrets.ADMIN_EXPORT_KEY]).size !== 3) throw new Error("Use different signing and administrator keys.");
    for (const name of ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]) {
      if (typeof secrets[name] !== "string" || !/^[a-zA-Z0-9_-]{20,100}$/.test(secrets[name]) || /^[123]x/.test(secrets[name]) || /replace|example|change.?me/i.test(secrets[name])) {
        throw new Error(`${name} needs a real production Turnstile key. Testing keys are not accepted for deployment.`);
      }
    }
    // Providers are optional. Reject partial groups instead of silently
    // deploying a registration button whose backend cannot authenticate.
    for (const names of [
      ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      ["APPLE_SERVICE_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
    ]) {
      if (!names.some((name) => secrets[name] !== undefined && secrets[name] !== "")) continue;
      for (const name of names) {
        const maximum = { APPLE_PRIVATE_KEY: 16_384, APPLE_SERVICE_ID: 256, APPLE_TEAM_ID: 64, APPLE_KEY_ID: 64, GOOGLE_CLIENT_SECRET: 4096, GOOGLE_CLIENT_ID: 1024 }[name];
        if (typeof secrets[name] !== "string" || !secrets[name].trim() || secrets[name].length > maximum || /replace|example|change.?me/i.test(secrets[name])) {
          throw new Error(`${name} is missing or invalid. Supply the complete provider group, or omit it to keep that provider disabled.`);
        }
      }
      if (names[0] === "APPLE_SERVICE_ID") {
        let key;
        try { key = createPrivateKey(secrets.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n")); } catch { /* Filename-only error below. */ }
        if (key?.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
          throw new Error("APPLE_PRIVATE_KEY must be the Sign in with Apple P-256 private key; its contents are never included in errors.");
        }
      }
    }
    await run([wrangler, "deploy", "--config", "wrangler.worker.local.jsonc", "--secrets-file", ".env.production.json", ...(dryRun ? ["--dry-run", "--outdir", ".cloudflare/dry-run"] : [])], root, worker.account_id);
  } else {
    await run([resolve(root, "scripts/build-pages.mjs"), ...(withPrivateAssets ? ["--with-private-assets"] : [])]);
    // Pages deploy has no --config flag. Run beside our ignored Pages config.
    await run([wrangler, "pages", "deploy", "--project-name", pages.name, "--branch", "main"], resolve(root, ".cloudflare/pages"), worker.account_id);
  }
} catch (error) {
  console.error(error.code === "ENOENT" ? "Missing local setup files. Run npm run setup:cloudflare first (see docs/DEPLOYMENT.md)." : error.message);
  process.exitCode = 1;
}
