import JSZip from "jszip";

export interface EpubZip {
  zip: JSZip;
  names: string[];
}

export async function loadEpub(buf: Uint8Array): Promise<EpubZip> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  return { zip, names };
}

export async function readText(zip: JSZip, name: string): Promise<string> {
  const f = zip.file(name);
  if (!f) throw new Error(`zip entry not found: ${name}`);
  return await f.async("string");
}

export async function readBytes(
  zip: JSZip,
  name: string,
): Promise<Uint8Array> {
  const f = zip.file(name);
  if (!f) throw new Error(`zip entry not found: ${name}`);
  return await f.async("uint8array");
}

export function exists(zip: JSZip, name: string): boolean {
  return !!zip.file(name);
}

export interface WriteEntry {
  name: string;
  data: string | Uint8Array;
}

export async function rebuildEpub(
  original: EpubZip,
  modifiedEntries: Map<string, string | Uint8Array>,
  newEntries: WriteEntry[],
): Promise<Uint8Array> {
  const out = new JSZip();
  out.file("mimetype", "application/epub+zip", { compression: "STORE" });

  for (const name of original.names) {
    if (name === "mimetype") continue;
    const entry = original.zip.files[name]!;
    if (entry.dir) {
      out.folder(name);
      continue;
    }
    if (modifiedEntries.has(name)) {
      out.file(name, modifiedEntries.get(name)!, { compression: "DEFLATE" });
    } else {
      const data = await entry.async("uint8array");
      out.file(name, data, { compression: "DEFLATE" });
    }
  }

  const origSet = new Set(original.names);
  for (const e of newEntries) {
    if (origSet.has(e.name)) continue;
    out.file(e.name, e.data, { compression: "DEFLATE" });
  }

  return await out.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export async function findOpfPath(zip: JSZip): Promise<string> {
  const containerXml = await readText(zip, "META-INF/container.xml");
  const m = containerXml.match(/full-path\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("META-INF/container.xml: full-path not found");
  return m[1]!;
}
