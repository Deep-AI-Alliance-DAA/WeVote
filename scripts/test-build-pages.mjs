#!/usr/bin/env node
// Offline fixture test: never reads the repository's private poster or secrets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = await mkdtemp(join(tmpdir(), "wevote-build-test-"));
const output = join(fixture, "pages", "dist");
const privateDirectory = join(fixture, "private-assets");
const poster = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = Buffer.from("RIFF0000WEBP");
const secret = "private-fixture-secret-must-not-be-copied";
let checks = 0;
function check(condition, message) { checks++; assert.ok(condition, message); }
const run = (args = []) => spawnSync(process.execPath, [join(fixture, "scripts", "build-pages.mjs"), ...args], {
  cwd: tmpdir(), env: { PATH: "" }, encoding: "utf8", timeout: 10_000,
});
const manifest = (files) => writeFile(join(privateDirectory, "manifest.json"), JSON.stringify({ version: 1, files }));
async function missing(path) {
  try { await stat(path); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
async function rejected(label) {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "previous-build"), "preserve-this-build");
  const result = run(["--with-private-assets"]);
  check(result.status !== 0, label);
  check(await readFile(join(output, "previous-build"), "utf8") === "preserve-this-build", `${label}: output was preserved`);
  check(!`${result.stdout}${result.stderr}`.includes(secret), `${label}: secret content was not printed`);
}

try {
  for (const directory of ["scripts", "src", "public/assets", "private-assets"]) await mkdir(join(fixture, directory), { recursive: true });
  await copyFile(join(dirname(fileURLToPath(import.meta.url)), "build-pages.mjs"), join(fixture, "scripts", "build-pages.mjs"));
  await writeFile(join(fixture, "src", "pages-worker.js"), "export default {fetch() {return new Response('fixture')}};\n");
  await writeFile(join(fixture, "public", "index.html"), "Public fixture");
  await writeFile(join(fixture, "public", "assets", "ballot-hero.webp"), webp);
  await writeFile(join(privateDirectory, "ai-song-2026-poster.jpg"), poster);
  await writeFile(join(privateDirectory, "badge.png"), png);
  await writeFile(join(privateDirectory, "private-hero.webp"), webp);
  await writeFile(join(privateDirectory, ".env"), secret);
  await writeFile(join(privateDirectory, "unlisted.jpg"), poster);

  // A directory in place of the manifest proves default builds do not read it.
  await mkdir(join(privateDirectory, "manifest.json"));
  check(run().status === 0, "Default build ignores even an unreadable private manifest");
  check(await missing(join(output, "assets", "ai-song-2026-poster.jpg")), "Default output excludes private poster");
  check(await missing(join(output, "assets", ".env")), "Default output excludes private .env");
  check(await readFile(join(output, "assets", "ballot-hero.webp"), "utf8") === webp.toString(), "Public artwork is preserved");
  check(JSON.parse(await readFile(join(output, "_routes.json"), "utf8")).include[0] === "/api/*", "API routing remains present");
  check((await readFile(join(output, "_worker.js"), "utf8")).includes("fixture"), "Pages Worker remains present");
  await rm(join(privateDirectory, "manifest.json"), { recursive: true });

  await manifest(["ai-song-2026-poster.jpg", "badge.png", "private-hero.webp"]);
  check(run(["--with-private-assets"]).status === 0, "Explicit private raster overlay succeeds");
  for (const [name, bytes] of [["ai-song-2026-poster.jpg", poster], ["badge.png", png], ["private-hero.webp", webp]]) {
    check((await readFile(join(output, "assets", name))).equals(bytes), `Validated ${name} bytes are copied exactly`);
  }
  check(await missing(join(output, "assets", ".env")), "Overlay does not copy unlisted secrets");
  check(await missing(join(output, "assets", "unlisted.jpg")), "Overlay copies only the allowlist");
  check(await missing(join(output, "assets", "manifest.json")), "Private manifest is not published");

  await manifest(["missing.jpg"]);
  await rejected("Missing required poster is rejected");
  for (const name of ["../.env", "sub/poster.jpg", "sub\\poster.jpg", "/poster.jpg", ".env", ".hidden.jpg", "poster.svg", "poster.jpg?query=yes"]) {
    await manifest([name]);
    await rejected(`Unsafe name ${name} is rejected`);
  }
  await writeFile(join(privateDirectory, "pretend.jpg"), secret);
  await manifest(["pretend.jpg"]);
  await rejected("A renamed nonimage is rejected by magic bytes");
  await manifest(["ai-song-2026-poster.jpg", "ai-song-2026-poster.jpg"]);
  await rejected("Duplicate manifest entries are rejected");
  await manifest([]);
  await rejected("Empty private allowlist is rejected");
  await writeFile(join(privateDirectory, "manifest.json"), secret);
  await rejected("Invalid manifest JSON is rejected without leaking content");

  if (process.platform !== "win32") {
    await symlink(join(privateDirectory, "ai-song-2026-poster.jpg"), join(privateDirectory, "linked.jpg"));
    await manifest(["linked.jpg"]);
    await rejected("Symlink image is rejected");
    await manifest(["ai-song-2026-poster.jpg"]);
    await copyFile(join(privateDirectory, "manifest.json"), join(fixture, "outside-manifest.json"));
    await rm(join(privateDirectory, "manifest.json"));
    await symlink(join(fixture, "outside-manifest.json"), join(privateDirectory, "manifest.json"));
    await rejected("Symlink manifest is rejected");
    await rm(privateDirectory, { recursive: true });
    await mkdir(join(fixture, "outside-assets"));
    await symlink(join(fixture, "outside-assets"), privateDirectory);
    await rejected("Symlink private directory is rejected");
  }
  check(run().status === 0, "Public build remains independent of rejected private overlay");
  check(await missing(join(output, "assets", "ai-song-2026-poster.jpg")), "Later public build removes prior private overlay");
  console.log(`Passed ${checks} offline Pages build checks: explicit overlay, signatures, allowlist, paths, secrets, symlinks and preserved output.`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
