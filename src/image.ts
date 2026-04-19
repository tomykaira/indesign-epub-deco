import { openSync, readSync, closeSync, statSync } from "node:fs";

import { log } from "./log.ts";

const DEFAULT_CANDIDATES = ["magick", "magick.exe"];
let resolvedMagick: string | null = null;

async function tryRun(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([cmd, "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export async function magickAvailable(
  explicitPath?: string,
): Promise<boolean> {
  if (resolvedMagick) return true;
  const candidates = explicitPath ? [explicitPath] : DEFAULT_CANDIDATES;
  for (const c of candidates) {
    if (await tryRun(c)) {
      resolvedMagick = c;
      return true;
    }
  }
  return false;
}

function magick(): string {
  if (!resolvedMagick) {
    throw new Error("magick not resolved; call magickAvailable() first");
  }
  return resolvedMagick;
}

export async function resizeImage(
  filePath: string,
  resize: number,
  quality: number,
): Promise<void> {
  const args = [
    "mogrify",
    "-resize",
    `${resize}@`,
    "-quality",
    String(quality),
    filePath,
  ];
  const proc = Bun.spawn([magick(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    log.error(`magick mogrify failed: ${err.trim()}`);
    throw new Error(`magick mogrify exited ${code}`);
  }
}

export function readImageSize(
  filePath: string,
): { width: number; height: number } {
  const size = statSync(filePath).size;
  const len = Math.min(size, 65536);
  const buf = Buffer.alloc(len);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  // PNG: \x89PNG\r\n\x1a\n, IHDR at byte 16
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: scan SOF markers
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) break;
      let marker = buf[off + 1]!;
      off += 2;
      while (marker === 0xff && off < buf.length) marker = buf[off++]!;
      if (marker === 0xd8 || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const segLen = buf.readUInt16BE(off);
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof) {
        return {
          height: buf.readUInt16BE(off + 3),
          width: buf.readUInt16BE(off + 5),
        };
      }
      off += segLen;
    }
  }
  // WebP (RIFF....WEBP)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    const fourCC = buf.toString("ascii", 12, 16);
    if (fourCC === "VP8 ") {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (fourCC === "VP8L") {
      const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (fourCC === "VP8X") {
      return {
        width: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)),
        height: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)),
      };
    }
  }
  throw new Error(`unsupported image format: ${filePath}`);
}

export async function identifyImage(
  filePath: string,
): Promise<{ width: number; height: number }> {
  const proc = Bun.spawn(
    [magick(), "identify", "-format", "%w %h", filePath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  const out = (await new Response(proc.stdout).text()).trim();
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`magick identify failed: ${err.trim()}`);
  }
  const [w, h] = out.split(/\s+/).map((s) => parseInt(s, 10));
  if (!w || !h) throw new Error(`magick identify parse failed: "${out}"`);
  return { width: w, height: h };
}
