// Electron main process for the Windows build.
// - Starts the bundled Next.js server (.next/standalone) on a private localhost port.
// - Runs native ffmpeg.exe / ffprobe.exe for the renderer (see app/_lib/ffmpeg.ts NativeEngine).
// - Stores user settings (Groq API key) in %APPDATA%/<app>/settings.json.
// - Keeps downloaded AI models (text-to-speech) in %APPDATA%/<app>/models.
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const isDev = !app.isPackaged;
const projectRoot = path.join(__dirname, "..");
const resourcesRoot = isDev ? null : process.resourcesPath;
const webDir = isDev ? path.join(projectRoot, ".next", "standalone") : path.join(resourcesRoot, "web");
const binDir = isDev ? path.join(__dirname, "bin") : path.join(resourcesRoot, "bin");
const FFMPEG = path.join(binDir, "ffmpeg.exe");
const FFPROBE = path.join(binDir, "ffprobe.exe");

// Fixes the %APPDATA% folder name (otherwise derived from package.json "name").
app.setName("Studio Edit");
// Lets tests (or portable setups) keep settings out of %APPDATA%.
if (process.env.STUDIO_USER_DATA) app.setPath("userData", process.env.STUDIO_USER_DATA);

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const modelsDir = () => path.join(app.getPath("userData"), "models");
/** Resolves a model key ("supertonic-3-xxxx/onnx/vocoder.onnx") inside modelsDir. */
function modelPath(key) {
  const root = modelsDir();
  const target = path.resolve(root, String(key));
  if (!target.startsWith(root + path.sep)) throw new Error(`Invalid model path: ${key}`);
  return target;
}
// Scratch space for FFmpeg outputs; wiped on start and quit.
const scratchDir = path.join(os.tmpdir(), `studio-edit-${process.pid}`);

let serverProcess = null;
let mainWindow = null;
/** Running ffmpeg/ffprobe processes per window, so "Hủy" only kills that window's jobs. */
const jobs = new Map();

// ---------------------------------------------------------------- settings

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { groqApiKey: typeof parsed.groqApiKey === "string" ? parsed.groqApiKey : "" };
  } catch {
    return { groqApiKey: "" };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------- Next.js server

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() > deadline) reject(new Error("Next.js server did not start in time."));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

async function startServer() {
  const port = await freePort();
  const serverJs = path.join(webDir, "server.js");
  if (!fs.existsSync(serverJs)) {
    throw new Error(`Missing ${serverJs}. Run "npm run desktop:build-web" first.`);
  }
  // If the app is killed (crash, Task Manager) Windows does not end child processes, so the
  // server polls for its parent and exits on its own.
  const bootstrap = [
    `const parent = ${process.pid};`,
    "setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 2000).unref();",
    `require(${JSON.stringify(serverJs)});`,
  ].join("\n");
  serverProcess = spawn(process.execPath, ["-e", bootstrap], {
    cwd: webDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      // The transcribe route reads the user's Groq key from here (see resolveApiKey).
      STUDIO_SETTINGS_FILE: settingsFile(),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.on("data", (chunk) => isDev && process.stdout.write(`[next] ${chunk}`));
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
  serverProcess.on("exit", (code) => {
    serverProcess = null;
    if (!app.isQuitting) dialog.showErrorBox("Studio Edit", `Máy chủ nội bộ đã dừng (mã ${code}). Hãy mở lại ứng dụng.`);
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url, 30_000);
  return url;
}

// ---------------------------------------------------------------- FFmpeg bridge

/** Renderer scratch paths ("/out.mp4") live in scratchDir; real Windows paths pass through. */
function resolvePath(arg) {
  if (typeof arg !== "string" || !arg.startsWith("/") || arg.startsWith("//")) return arg;
  const resolved = path.join(scratchDir, arg.replace(/^\/+/, ""));
  if (!resolved.startsWith(scratchDir)) throw new Error(`Path escapes scratch dir: ${arg}`);
  return resolved;
}

function jobsFor(webContents) {
  if (!jobs.has(webContents.id)) jobs.set(webContents.id, new Set());
  return jobs.get(webContents.id);
}

function parseTimestamp(value) {
  const match = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function runProcess(webContents, binary, args, { jobId, collectStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const running = jobsFor(webContents);
    running.add(child);
    let stdout = "";
    let stderrTail = "";
    let partial = "";

    child.stdout.on("data", (chunk) => {
      if (collectStdout) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-4000);
      if (!jobId || webContents.isDestroyed()) return;
      // ffmpeg rewrites its stats line with \r; treat \r and \n both as line ends.
      const lines = (partial + text).split(/\r\n|\r|\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        webContents.send("ffmpeg:event", { jobId, type: "log", message: line });
        if (line.includes("time=")) {
          const time = parseTimestamp(line.slice(line.indexOf("time=")));
          if (time !== null) webContents.send("ffmpeg:event", { jobId, type: "progress", time });
        }
      }
    });
    child.on("error", (error) => {
      running.delete(child);
      reject(new Error(`Không chạy được ${path.basename(binary)}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      running.delete(child);
      if (child.killedByUser) return reject(new Error("called FFmpeg.terminate()"));
      if (jobId && partial.trim() && !webContents.isDestroyed()) {
        webContents.send("ffmpeg:event", { jobId, type: "log", message: partial });
      }
      if (collectStdout) {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderrTail.trim().split(/\r?\n/).slice(-3).join(" ") || `ffprobe exited with ${code ?? signal}`));
        return;
      }
      resolve(code ?? -1);
    });
  });
}

function registerIpc() {
  ipcMain.handle("ffmpeg:exec", async (event, jobId, args) => {
    await fsp.mkdir(scratchDir, { recursive: true });
    const resolved = ["-hide_banner", "-nostdin", ...args.map(resolvePath)];
    return runProcess(event.sender, FFMPEG, resolved, { jobId });
  });

  ipcMain.handle("ffmpeg:probe", (event, args) => runProcess(event.sender, FFPROBE, args.map(resolvePath), { collectStdout: true }));

  ipcMain.handle("ffmpeg:readFile", async (_event, file) => new Uint8Array(await fsp.readFile(resolvePath(file))));

  ipcMain.handle("ffmpeg:writeFile", async (_event, file, data) => {
    await fsp.mkdir(scratchDir, { recursive: true });
    await fsp.writeFile(resolvePath(file), data);
  });

  ipcMain.handle("ffmpeg:deleteFile", async (_event, file) => {
    await fsp.rm(resolvePath(file), { force: true });
  });

  ipcMain.handle("ffmpeg:killAll", (event) => {
    for (const child of jobsFor(event.sender)) {
      child.killedByUser = true;
      child.kill();
    }
  });

  ipcMain.handle("dialog:pickDirectory", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Chọn nơi lưu",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("fs:writeFolder", async (_event, parent, folderName, files) => {
    const safeName = String(folderName).replace(/[<>:"/\\|?*]+/g, "_") || "export";
    let name = safeName;
    for (let attempt = 2; fs.existsSync(path.join(parent, name)); attempt++) name = `${safeName} (${attempt})`;
    const folder = path.join(parent, name);
    await fsp.mkdir(folder, { recursive: true });
    for (const file of files) {
      const target = path.join(folder, file.path);
      if (!target.startsWith(folder + path.sep)) throw new Error(`Invalid file name: ${file.path}`);
      await fsp.writeFile(target, file.data);
    }
    return name;
  });

  // Downloaded model files (text-to-speech). The renderer's own caches are useless here: the
  // UI is served from a new localhost port on every launch, i.e. a new origin.
  ipcMain.handle("models:read", async (_event, key) => {
    try {
      return new Uint8Array(await fsp.readFile(modelPath(key)));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  ipcMain.handle("models:write", async (_event, key, data) => {
    const target = modelPath(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    // Write then rename, so an interrupted download never leaves a truncated model behind.
    await fsp.writeFile(`${target}.part`, data);
    await fsp.rename(`${target}.part`, target);
  });
  ipcMain.handle("models:has", (_event, keys) => keys.every((key) => fs.existsSync(modelPath(key))));
  ipcMain.handle("models:clear", async () => {
    await fsp.rm(modelsDir(), { recursive: true, force: true });
  });

  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:set", (_event, patch) => {
    const allowed = {};
    if (typeof patch?.groqApiKey === "string") allowed.groqApiKey = patch.groqApiKey.trim();
    return writeSettings(allowed);
  });
}

// ---------------------------------------------------------------- window

async function createWindow() {
  const url = await startServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Studio Edit",
    backgroundColor: "#f1f1f1",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Links to the web open in the user's browser; blob previews ("Xem") open in a new app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("blob:") || target.startsWith(url)) return { action: "allow" };
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  const webContentsId = mainWindow.webContents.id;
  mainWindow.webContents.on("destroyed", () => jobs.delete(webContentsId));

  await mainWindow.loadURL(url);
}

function cleanup() {
  for (const running of jobs.values()) for (const child of running) child.kill();
  serverProcess?.kill();
  fs.rmSync(scratchDir, { recursive: true, force: true });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    registerIpc();
    try {
      await createWindow();
    } catch (error) {
      dialog.showErrorBox("Studio Edit", `Không khởi động được ứng dụng:\n${error.message}`);
      app.quit();
    }
  });
  app.on("before-quit", () => {
    app.isQuitting = true;
    cleanup();
  });
  app.on("window-all-closed", () => app.quit());
}
