// Launches the desktop app from the project (after desktop:build-web).
// Editors built on Electron (VS Code, Cursor…) export ELECTRON_RUN_AS_NODE=1 to child
// processes, which would make Electron start as plain Node; drop it first.
import { spawn } from "node:child_process";
import { join } from "node:path";
import electronPath from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [join(import.meta.dirname, "..", ".."), ...process.argv.slice(2)], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
