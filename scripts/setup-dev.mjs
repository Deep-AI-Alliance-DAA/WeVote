import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const now = Date.now();
const lines = [
  'POLL_ID="demo-local"',
  'POLL_QUESTION="你支持邊個方案？"',
  `POLL_OPTIONS_JSON='${JSON.stringify([{ id: "a", label: "方案 A" }, { id: "b", label: "方案 B" }])}'`,
  `POLL_OPENS_AT="${new Date(now - 60_000).toISOString()}"`,
  `POLL_CLOSES_AT="${new Date(now + 2 * 60 * 60_000).toISOString()}"`,
  `VOTE_SIGNING_KEY="${randomBytes(32).toString("hex")}"`,
  'TURNSTILE_SITE_KEY="1x00000000000000000000AA"',
  'TURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"',
  `ADMIN_EXPORT_KEY="${randomBytes(32).toString("hex")}"`,
];

try {
  await writeFile(".dev.vars", `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  console.log("Created .dev.vars with a two-hour local poll and private test keys.");
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(".dev.vars already exists; leaving it unchanged.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}
