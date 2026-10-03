// Downloads native ffmpeg.exe + ffprobe.exe (gyan.dev "essentials" release build: x264, x265,
// libvpx, opus, NVENC/QSV/AMF…) into desktop/bin for the Windows app. Skips if present.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";

// gyan.dev publishes the same builds on GitHub, which is much faster; gyan.dev is the fallback.
const GITHUB_RELEASE_API = "https://api.github.com/repos/GyanD/codexffmpeg/releases/latest";
const FALLBACK_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

async function resolveBuildUrl() {
  try {
    const release = await (await fetch(GITHUB_RELEASE_API, { headers: { "User-Agent": "studio-edit-build" } })).json();
    const asset = release.assets?.find((item) => /-essentials_build\.zip$/.test(item.name));
    if (asset) return asset.browser_download_url;
  } catch {
    // fall through to gyan.dev
  }
  return FALLBACK_URL;
}
const binDir = join(import.meta.dirname, "..", "bin");
const wanted = ["ffmpeg.exe", "ffprobe.exe"];

if (wanted.every((name) => existsSync(join(binDir, name))) && !process.argv.includes("--force")) {
  console.log(`FFmpeg already present in ${binDir} (use --force to re-download).`);
  process.exit(0);
}

const buildUrl = await resolveBuildUrl();
console.log(`Downloading ${buildUrl} …`);
const response = await fetch(buildUrl);
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
const zip = new Uint8Array(await response.arrayBuffer());

// Only inflate the two executables; the archive also holds docs and ffplay.
const files = unzipSync(zip, { filter: (entry) => wanted.some((name) => entry.name.endsWith(`/bin/${name}`)) });
mkdirSync(binDir, { recursive: true });
for (const name of wanted) {
  const entry = Object.keys(files).find((path) => path.endsWith(`/bin/${name}`));
  if (!entry) throw new Error(`${name} not found in archive`);
  writeFileSync(join(binDir, name), files[entry]);
  console.log(`  ${name}  ${(files[entry].length / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`FFmpeg ready in ${binDir}`);
