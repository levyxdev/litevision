import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import { promisify } from "node:util";
import type { Platform } from "./catalog.ts";

/**
 * The machine as `local install` sees it, read only to choose a quantisation and to warn; `--force` installs anyway
 * (ADR 0010). `memoryGb` is unified memory on a Mac and VRAM on Windows: 0 when no NVIDIA GPU answers.
 */
export type Hardware = { platform: Platform; memoryGb: number } | { platform: undefined; name: string };

/** The largest NVIDIA GPU's VRAM in GB, as `nvidia-smi` reports it, or 0 without one. */
async function nvidiaVramGb(): Promise<number> {
  try {
    const { stdout } = await promisify(execFile)("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
    const mib = stdout.split("\n").map(Number).filter((value) => value > 0);
    return mib.length === 0 ? 0 : Math.round(Math.max(...mib) / 1024);
  } catch {
    return 0;
  }
}

export async function detectHardware(): Promise<Hardware> {
  if (process.platform === "darwin" && process.arch === "arm64") return { platform: "macos-arm64", memoryGb: Math.round(totalmem() / 2 ** 30) };
  if (process.platform === "win32" && process.arch === "x64") return { platform: "windows-cuda12", memoryGb: await nvidiaVramGb() };
  return { platform: undefined, name: `${process.platform}-${process.arch}` };
}
