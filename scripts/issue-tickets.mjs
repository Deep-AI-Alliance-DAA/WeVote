import { createHmac, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1];
}

const count = Number(argument("count"));
const baseUrl = argument("url");
const pollId = argument("poll-id");
const expires = Date.parse(argument("expires") || "");
const output = argument("output");
const secret = process.env.VOTE_SIGNING_KEY;

if (!Number.isInteger(count) || count < 1 || count > 100_000 || !baseUrl || !pollId || !output || !Number.isFinite(expires) || expires <= Date.now() || !secret || secret.length < 32) {
  console.error("Usage: VOTE_SIGNING_KEY=<secret> npm run tickets -- --count 50000 --url https://your-domain.example/ --poll-id poll-1 --expires 2026-12-31T23:59:59Z --output tickets.csv");
  process.exit(1);
}
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pollId)) throw new Error("Invalid poll ID.");
const target = new URL(baseUrl);
if (target.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Ticket URL must use HTTPS.");
if (target.search || target.hash) throw new Error("Ticket URL must not contain a query or fragment.");

const lines = ["ticket_url"];
for (let i = 0; i < count; i++) {
  const claims = { p: pollId, v: randomBytes(16).toString("hex"), exp: Math.floor(expires / 1000) };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  const url = new URL(baseUrl);
  // A fragment is never sent to the server in the initial page request or Referer.
  url.hash = `ticket=${payload}.${signature}`;
  lines.push(url.toString());
}
await writeFile(output, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
console.log(`Created ${count} unique links in ${output}. Keep this file private.`);
