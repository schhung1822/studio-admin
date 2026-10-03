// Exposes the small, typed bridge the web app uses when running inside the Windows app
// (see app/_lib/desktop.ts for the TypeScript shape). Runs sandboxed: only `electron` is available.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("studioDesktop", {
  platform: process.platform,
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  ffmpeg: {
    exec: (jobId, args) => ipcRenderer.invoke("ffmpeg:exec", jobId, args),
    probe: (args) => ipcRenderer.invoke("ffmpeg:probe", args),
    readFile: (path) => ipcRenderer.invoke("ffmpeg:readFile", path),
    writeFile: (path, data) => ipcRenderer.invoke("ffmpeg:writeFile", path, data),
    deleteFile: (path) => ipcRenderer.invoke("ffmpeg:deleteFile", path),
    killAll: () => ipcRenderer.invoke("ffmpeg:killAll"),
    onEvent: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on("ffmpeg:event", handler);
      return () => ipcRenderer.removeListener("ffmpeg:event", handler);
    },
  },
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  writeFolder: (parent, folderName, files) => ipcRenderer.invoke("fs:writeFolder", parent, folderName, files),
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
});
