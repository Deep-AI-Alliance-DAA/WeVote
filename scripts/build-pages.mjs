import { cp, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "pages", "dist");
const args = process.argv.slice(2);

function validRaster(bytes, name) {
  if (/\.jpe?g$/i.test(name)) return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (/\.png$/i.test(name)) return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (/\.webp$/i.test(name)) return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

async function privateAssets() {
  const directory = join(root, "private-assets");
  if (!(await lstat(directory)).isDirectory()) throw new Error("private-assets must be a directory, not a symlink.");
  const manifestPath = join(directory, "manifest.json");
  if (!(await lstat(manifestPath)).isFile()) throw new Error("The private asset manifest must be a regular file, not a symlink.");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { throw new Error("Invalid private asset manifest JSON."); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(",") !== "files,version" || manifest.version !== 1 ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100 ||
      new Set(manifest.files).size !== manifest.files.length) {
    throw new Error("Private asset manifest must contain version: 1 and a nonempty unique files allowlist.");
  }
  const assets = [];
  let totalSize = 0;
  for (const name of manifest.files) {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,119}\.(?:jpg|jpeg|png|webp)$/i.test(name)) {
      throw new Error("Private assets require safe raster basenames; paths, hidden files and nonimages are rejected.");
    }
    const source = join(directory, name);
    const info = await lstat(source);
    if (!info.isFile()) throw new Error(`Private asset ${name} must be a regular file, not a symlink.`);
    totalSize += info.size;
    if (info.size > 25 * 1024 * 1024 || totalSize > 100 * 1024 * 1024) throw new Error("Private raster assets exceed the build size limit.");
    const bytes = await readFile(source);
    if (!validRaster(bytes, name)) throw new Error(`Private asset ${name} has an invalid raster signature.`);
    // Keep the validated bytes: a later copy cannot follow a replaced symlink.
    assets.push({ name, bytes });
  }
  return assets;
}

try {
  if (args.length && (args.length !== 1 || args[0] !== "--with-private-assets")) {
    throw new Error("Usage: node scripts/build-pages.mjs [--with-private-assets]");
  }
  // The public build never reads private-assets. Validate the complete explicit
  // overlay before clearing any existing output, including all required files.
  const assets = args.length ? await privateAssets() : [];
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(join(root, "public"), output, { recursive: true });
  await copyFile(join(root, "src", "pages-worker.js"), join(output, "_worker.js"));
  await writeFile(join(output, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }));
  if (assets.length) {
    await mkdir(join(output, "assets"), { recursive: true });
    for (const { name, bytes } of assets) await writeFile(join(output, "assets", name), bytes);
  }
  console.log(`Built Pages bundle${assets.length ? ` with ${assets.length} private raster asset(s)` : ""}.`);
} catch (error) {
  console.error(error.code === "ENOENT" ? "A required build file is missing; check the source files and private asset manifest." : error.message);
  process.exitCode = 1;
}
