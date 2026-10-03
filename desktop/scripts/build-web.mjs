// Builds the Next.js app as a standalone server for the Windows app and copies the static
// assets next to it (Next leaves those to a CDN by default).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const standalone = join(root, ".next", "standalone");

rmSync(standalone, { recursive: true, force: true });
const build = spawnSync("npx", ["next", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, STUDIO_DESKTOP: "1" },
});
if (build.status !== 0) process.exit(build.status ?? 1);

if (!existsSync(join(standalone, "server.js"))) {
  throw new Error(`Expected ${join(standalone, "server.js")} – is output: "standalone" enabled?`);
}
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });

// The installer is handed to other people: never ship local .env files or the developer's
// own API key. Each user enters their key in the app's Settings page instead.
const secrets = [];
for (const envFile of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  const full = join(root, envFile);
  if (!existsSync(full)) continue;
  for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
    const value = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
    if (value.length >= 16) secrets.push(value);
  }
}
const leaks = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules") walk(full);
    } else if (/^\.env/.test(name)) {
      rmSync(full, { force: true });
      console.log(`Removed ${full} from the bundle.`);
    } else if (/\.(js|json|txt|html|map)$/.test(name)) {
      const text = readFileSync(full, "utf8");
      if (secrets.some((secret) => text.includes(secret))) leaks.push(full);
    }
  }
};
walk(standalone);
if (leaks.length) {
  console.error(`A secret from your .env files was compiled into:\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}

console.log(`Standalone server ready in ${standalone}`);
