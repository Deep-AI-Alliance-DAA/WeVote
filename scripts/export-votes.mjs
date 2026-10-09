import { writeFile } from "node:fs/promises";

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1];
}

const baseUrl = argument("url");
const output = argument("output");
const key = process.env.ADMIN_EXPORT_KEY;
if (!baseUrl || !output || !key || key.length < 32) {
  console.error("Usage: ADMIN_EXPORT_KEY=<secret> node scripts/export-votes.mjs --url https://your-domain.example/ --output votes.csv");
  process.exit(1);
}
const target = new URL(baseUrl);
if (target.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Export URL must use HTTPS.");

// Keep the original columns and append the complete selection set as JSON.
// Each row still represents one ballot, even when it selected several options.
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportedChoices(row) {
  const options = row.option_ids === undefined ? [row.option_id] : row.option_ids;
  if (!Array.isArray(options) || options.length < 1 || options.length > 20 || options.some((option) => typeof option !== "string" || !option) || new Set(options).size !== options.length) {
    throw new Error("Export stopped: a ballot contains an invalid selection set.");
  }
  return options;
}

const lines = ["voter_hash,option_id,created_at,option_ids_json"];
for (let shard = 0; shard < 128; shard++) {
  let after = "";
  do {
    const url = new URL("/api/admin/export", baseUrl);
    url.searchParams.set("shard", String(shard));
    if (after) url.searchParams.set("after", after);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`Export stopped at shard ${shard}: HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.rows)) throw new Error(`Export stopped at shard ${shard}: invalid ballot data`);
    for (const row of data.rows) {
      const options = exportedChoices(row);
      const optionId = options.length === 1 ? options[0] : "";
      lines.push([row.voter_hash, optionId, row.created_at, JSON.stringify(options)].map(csvCell).join(","));
    }
    after = data.next || "";
  } while (after);
}
await writeFile(output, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
console.log(`Exported ${lines.length - 1} votes to ${output}. Keep this file private.`);
