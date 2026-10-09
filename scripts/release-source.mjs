import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
try {
  if (git("status", "--porcelain", "--untracked-files=no").toString().trim()) throw new Error("Commit all tracked source changes before creating a release snapshot.");
  const files = git("ls-tree", "-r", "--name-only", "-z", "HEAD").toString().split("\0").filter(Boolean);
  const forbidden = files.filter((file) =>
    /(^|\/)(node_modules|\.git|\.wrangler|\.cloudflare|private-assets)(\/|$)/.test(file) ||
    /^(pages\/dist\/|dist\/|releases\/)/.test(file) ||
    /(^|\/)\.env/.test(file) && file !== ".env.example" ||
    /(^|\/)\.dev.*\.vars/.test(file) && file !== ".dev.vars.example" ||
    /(^|\/)(tickets|votes).*\.csv$/i.test(file) ||
    /^wrangler(?:\..*)?\.local\.jsonc$/.test(file) ||
    /^wrangler \d+\.jsonc$/.test(file) ||
    file === "public/assets/ai-song-2026-poster.jpg"
  );
  if (forbidden.length) throw new Error(`Exclude private/deployment files from the release commit: ${forbidden.join(", ")}`);
  const { version } = JSON.parse(git("show", "HEAD:package.json").toString());
  const sha = git("rev-parse", "--short=12", "HEAD").toString().trim();
  const filename = `wevote-source-${version}-${sha}.zip`;
  const archive = git("archive", "--format=zip", "--prefix=wevote/", "HEAD");
  const digest = createHash("sha256").update(archive).digest("hex");
  await mkdir(resolve(root, "releases"), { recursive: true });
  await writeFile(resolve(root, "releases", filename), archive, { flag: "wx" });
  await writeFile(resolve(root, "releases", `${filename}.sha256`), `${digest}  ${filename}\n`, { flag: "wx" });
  console.log(`Created releases/${filename} (${files.length} committed files; no Git history).`);
  console.log(`SHA-256: ${digest}`);
  console.log("Review docs/OPEN_SOURCE_RELEASE.md before publishing the existing repository.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
