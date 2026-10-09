import { cp, copyFile, mkdir, rm, writeFile } from "node:fs/promises";

await rm("pages/dist", { recursive: true, force: true });
await mkdir("pages/dist", { recursive: true });
await cp("public", "pages/dist", { recursive: true });
await copyFile("src/pages-worker.js", "pages/dist/_worker.js");
await writeFile("pages/dist/_routes.json", JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }));
