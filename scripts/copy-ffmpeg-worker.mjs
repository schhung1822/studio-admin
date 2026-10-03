// Copies @ffmpeg/ffmpeg's worker into public/ so it is served as-is. If the bundler
// compiles the worker, it rewrites the worker's dynamic `import(coreURL)` and loading
// the FFmpeg core fails with "Cannot find module as expression is too dynamic".
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const sourceDir = join(root, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");
const targetDir = join(root, "public", "ffmpeg");

mkdirSync(targetDir, { recursive: true });
for (const file of ["worker.js", "const.js", "errors.js"]) {
  copyFileSync(join(sourceDir, file), join(targetDir, file));
}
console.log(`Copied FFmpeg worker to ${targetDir}`);
