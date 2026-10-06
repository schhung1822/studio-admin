/**
 * Bridge exposed by the Windows desktop app (desktop/preload.cjs). It is undefined in a
 * normal browser, so every caller must fall back to the web implementation.
 */
export interface DesktopSettings {
  groqApiKey: string;
}

export interface DesktopFFmpegEvent {
  jobId: string;
  type: "log" | "progress";
  message?: string;
  /** Output timestamp in seconds (progress events). */
  time?: number;
}

export interface DesktopBridge {
  platform: string;
  /** Absolute path of a File picked or dropped in the window ("" for in-memory files). */
  pathForFile(file: File): string;
  ffmpeg: {
    /**
     * Runs ffmpeg.exe. Arguments starting with "/" are scratch paths inside the app's temp
     * folder; absolute Windows paths are passed through. Resolves with the exit code.
     */
    exec(jobId: string, args: string[]): Promise<number>;
    /** Runs ffprobe.exe and resolves with its stdout. */
    probe(args: string[]): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    deleteFile(path: string): Promise<void>;
    /** Kills every running ffmpeg/ffprobe process started by this window. */
    killAll(): Promise<void>;
    onEvent(listener: (event: DesktopFFmpegEvent) => void): () => void;
  };
  /** Shows a native folder picker; resolves with the chosen path or null if cancelled. */
  pickDirectory(): Promise<string | null>;
  /** Creates `folderName` (made unique) inside `parent` and writes the files; returns its name. */
  writeFolder(parent: string, folderName: string, files: { path: string; data: Uint8Array }[]): Promise<string>;
  settings: {
    get(): Promise<DesktopSettings>;
    set(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  };
  /**
   * Downloaded AI model files, kept in %APPDATA%/Studio Edit/models. Keys are relative paths
   * such as "supertonic-3-xxxx/onnx/vocoder.onnx". Missing in installers built before this existed.
   */
  models?: {
    read(key: string): Promise<Uint8Array | null>;
    write(key: string, data: Uint8Array): Promise<void>;
    has(keys: string[]): Promise<boolean>;
    clear(): Promise<void>;
  };
}

declare global {
  interface Window {
    studioDesktop?: DesktopBridge;
  }
}

export function getDesktop(): DesktopBridge | null {
  return typeof window !== "undefined" ? (window.studioDesktop ?? null) : null;
}

export function isDesktop() {
  return getDesktop() !== null;
}
