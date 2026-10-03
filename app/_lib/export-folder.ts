"use client";

import { zipSync, type Zippable } from "fflate";
import { getDesktop, isDesktop } from "./desktop";
import { downloadBlob } from "./format";

export interface ExportFile {
  /** Path inside the exported folder, e.g. "001.jpg". */
  path: string;
  data: Blob;
  /** Already-compressed files (JPEG, MP4…) are stored as-is in the ZIP. */
  compress?: boolean;
}

declare global {
  interface Window {
    // File System Access API (Chrome/Edge); not yet in TypeScript's DOM typings.
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

export function canPickDirectory() {
  return isDesktop() || (typeof window !== "undefined" && typeof window.showDirectoryPicker === "function");
}

export function isUserCancel(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** "name", then "name (2)", "name (3)"… so an earlier export is never overwritten. */
async function uniqueFolderName(parent: FileSystemDirectoryHandle, name: string) {
  for (let attempt = 1; attempt < 1000; attempt++) {
    const candidate = attempt === 1 ? name : `${name} (${attempt})`;
    try {
      await parent.getDirectoryHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return candidate;
      if (error instanceof DOMException && error.name === "TypeMismatchError") continue; // a file has that name
      throw error;
    }
  }
  throw new Error("Không tìm được tên thư mục trống.");
}

/**
 * Asks the user for a location and writes `files` into a new sub-folder there.
 * Returns the created folder's name. Throws an AbortError if the user cancels the picker.
 */
export async function saveToPickedDirectory(
  folderName: string,
  files: ExportFile[],
  onProgress?: (written: number, total: number) => void,
) {
  const desktop = getDesktop();
  if (desktop) {
    // Windows app: native folder dialog, files written by the main process.
    const parent = await desktop.pickDirectory();
    if (!parent) throw new DOMException("Đã hủy chọn thư mục.", "AbortError");
    const payload = await Promise.all(
      files.map(async (file) => ({ path: file.path, data: new Uint8Array(await file.data.arrayBuffer()) })),
    );
    const name = await desktop.writeFolder(parent, folderName, payload);
    onProgress?.(files.length, files.length);
    return name;
  }
  if (!window.showDirectoryPicker) throw new Error("Trình duyệt này không hỗ trợ chọn thư mục.");
  const parent = await window.showDirectoryPicker({ id: "tool-export", mode: "readwrite" });
  const name = await uniqueFolderName(parent, folderName);
  const folder = await parent.getDirectoryHandle(name, { create: true });
  for (const [index, file] of files.entries()) {
    const handle = await folder.getFileHandle(file.path, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(file.data);
    } finally {
      await writable.close();
    }
    onProgress?.(index + 1, files.length);
  }
  return name;
}

/** Packs `files` into `<folderName>.zip` (with the folder inside) and downloads it. */
export async function downloadAsZip(folderName: string, files: ExportFile[]) {
  const entries: Zippable = {};
  for (const file of files) {
    entries[`${folderName}/${file.path}`] = [new Uint8Array(await file.data.arrayBuffer()), { level: file.compress ? 6 : 0 }];
  }
  const zipped = zipSync(entries);
  downloadBlob(new Blob([zipped.slice()], { type: "application/zip" }), `${folderName}.zip`);
}
