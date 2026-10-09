import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  "account-id": { type: "string" }, "kv-id": { type: "string" },
  worker: { type: "string" }, pages: { type: "string" },
  url: { type: "string" }, "site-key": { type: "string" },
  help: { type: "boolean", short: "h" },
} });

if (values.help) {
  console.log("Usage: npm run setup:cloudflare -- --account-id ID --kv-id ID --worker my-wevote-api --pages my-wevote --url https://my-wevote.pages.dev --site-key PUBLIC_SITE_KEY\nCreates local configuration files only. Read docs/DEPLOYMENT.md first.");
  process.exit(0);
}

function requireValue(name, pattern) {
  const value = values[name];
  if (!value || !pattern.test(value)) throw new Error(`Missing or invalid --${name}. See --help.`);
  return value;
}

try {
  const accountId = requireValue("account-id", /^(?!0{32}$)[a-f0-9]{32}$/i);
  const kvId = requireValue("kv-id", /^(?!0{32}$)[a-f0-9]{32}$/i);
  const workerName = requireValue("worker", /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/);
  const pagesName = requireValue("pages", /^[a-z][a-z0-9-]{1,56}[a-z0-9]$/);
  const siteKey = requireValue("site-key", /^[a-zA-Z0-9_-]{20,100}$/);
  if (/^[123]x/.test(siteKey)) throw new Error("Use a real production Turnstile site key, not a testing key.");
  const url = new URL(values.url);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("--url must be your public HTTPS origin without a path, query or credentials.");
  }

  // The checked-in templates use full-line JSONC comments only.
  const template = await readFile(resolve(root, "wrangler.worker.jsonc"), "utf8");
  const worker = JSON.parse(template.replace(/^\s*\/\/.*$/gm, ""));
  Object.assign(worker, { name: workerName, account_id: accountId, workers_dev: false, preview_urls: false });
  worker.vars.PUBLIC_BASE_URL = url.origin;
  worker.kv_namespaces = [{ binding: "EVENTS", id: kvId }];
  const pages = {
    $schema: "../../node_modules/wrangler/config-schema.json",
    // Pages configuration rejects account_id; deployment pins the CLI account
    // through CLOUDFLARE_ACCOUNT_ID from the validated Worker configuration.
    name: pagesName,
    pages_build_output_dir: "../../pages/dist",
    compatibility_date: worker.compatibility_date,
    services: [{ binding: "WEVOTE_API", service: workerName }],
  };
  const secrets = {
    VOTE_SIGNING_KEY: randomBytes(32).toString("hex"),
    ADMIN_DASHBOARD_KEY: randomBytes(32).toString("hex"),
    ADMIN_EXPORT_KEY: randomBytes(32).toString("hex"),
    TURNSTILE_SITE_KEY: siteKey,
    TURNSTILE_SECRET_KEY: "",
  };
  const files = [
    ["wrangler.worker.local.jsonc", worker],
    [".cloudflare/pages/wrangler.jsonc", pages],
    [".env.production.json", secrets],
  ];
  for (const [file] of files) {
    try {
      await access(resolve(root, file));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`${file} already exists. No files were replaced.`);
  }
  await mkdir(resolve(root, ".cloudflare/pages"), { recursive: true, mode: 0o700 });
  const created = [];
  try {
    for (const [file, data] of files) {
      await writeFile(resolve(root, file), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      created.push(file);
    }
  } catch (error) {
    await Promise.all(created.map((file) => unlink(resolve(root, file))));
    throw error;
  }
  console.log("Created your ignored Worker/Pages configurations and .env.production.json (private file permissions).");
  console.log("Add your real TURNSTILE_SECRET_KEY to .env.production.json in a local editor. Keep the admin key private.");
  console.log("Next: npm run deploy:api -- --dry-run, then follow docs/DEPLOYMENT.md.");
} catch (error) {
  console.error(error instanceof TypeError ? "Missing or invalid --url. See --help." : error.message);
  process.exitCode = 1;
}
