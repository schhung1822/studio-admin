// electron-builder afterPack hook: copies the Next.js standalone server into resources/web.
// (extraResources silently drops `node_modules` and dot-folders like `.next`, which the
// standalone server needs, so it is copied here verbatim instead.)
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const source = path.join(__dirname, "..", "..", ".next", "standalone");
  const target = path.join(context.appOutDir, "resources", "web");
  for (const required of ["server.js", path.join(".next", "BUILD_ID"), "node_modules"]) {
    if (!fs.existsSync(path.join(source, required))) {
      throw new Error(`Standalone build is incomplete (missing ${required}). Run "npm run desktop:build-web".`);
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  console.log(`  • copied standalone server → ${target}`);
};
