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
