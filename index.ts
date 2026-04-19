import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  copyFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, extname, resolve, join } from "node:path";
import { posix } from "node:path";

import { log } from "./src/log.ts";
import {
  magickAvailable,
  resizeImage,
  identifyImage,
  readImageSize,
} from "./src/image.ts";
import {
  removeColorDeclaration,
  removeImageFullHeightRule,
  appendIndentParagraphRule,
} from "./src/css.ts";
import { applyIndentDisable } from "./src/xhtml.ts";
import { relocateImages, RelocError } from "./src/relocate.ts";
import {
  loadEpub,
  readText,
  rebuildEpub,
  findOpfPath,
  exists as zipExists,
} from "./src/zip.ts";
import {
  parseOpf,
  serializeOpf,
  inspectOpf,
  resolveSpineHrefs,
  updateOpf,
  readMetadataEntries,
  type AddItem,
  type UpdatePlan,
} from "./src/opf.ts";

const DEFAULT_INDENT_SKIP_CHARS = "「『〈《【〔（(？！・";
const DEFAULT_INDENT_CLASS_NAME = "本文-自動字下げ";
const DEFAULT_IMAGE_CLASS_NAME = "全画面挿絵";
const CSS_TARGET_PATH = "OEBPS/css/idGeneratedStyles.css";
const CSS_COLOR_TARGET = "#231815";
const IMAGE_DIR = "OEBPS/image";

interface Config {
  epub: string;
  pre?: string[];
  post?: string[];
  resize?: number | null;
  quality: number;
  indentSkipChars?: string;
  indentClassName?: string;
  imageClassName?: string;
  magick?: string;
}

function loadConfig(path: string): Config {
  const text = readFileSync(path, "utf-8");
  const cfg = JSON.parse(text) as Config;
  if (!cfg.epub) throw new Error('config: "epub" is required');
  if (
    cfg.resize !== undefined &&
    cfg.resize !== null &&
    typeof cfg.resize !== "number"
  )
    throw new Error('config: "resize" must be a number, null, or omitted');
  if (typeof cfg.quality !== "number")
    throw new Error('config: "quality" must be an integer');
  return cfg;
}

function extToMime(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  switch (e) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function uniqueNameInDir(
  desired: string,
  dir: string,
  taken: Set<string>,
): string {
  const full = `${dir}/${desired}`;
  if (!taken.has(full)) return desired;
  const ext = extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!taken.has(`${dir}/${cand}`)) return cand;
  }
  throw new Error(`could not find unique name for ${desired}`);
}

function uniqueId(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  for (let i = 1; i < 1000; i++) {
    const cand = `${desired}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  throw new Error(`could not find unique id for ${desired}`);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const str = i === 0 ? String(bytes) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${str} ${units[i]} (${bytes.toLocaleString()} bytes)`;
}

function utcNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(
    d.getUTCSeconds(),
  )}Z`;
}

function svgWrapper(imageHref: string, width: number, height: number, title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="UTF-8"/>
  <title>${title}</title>
  <style>html,body{margin:0;padding:0;height:100%}svg{display:block;width:100%;height:100%}</style>
</head>
<body>
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
       version="1.1" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
    <image width="${width}" height="${height}" xlink:href="${imageHref}"/>
  </svg>
</body>
</html>
`;
}

function xhtmlRefersTo(
  xhtmlContent: string,
  xhtmlPathInZip: string,
  targetAbsPath: string,
): boolean {
  const dir = posix.dirname(xhtmlPathInZip);
  const re = /(?:src|xlink:href|href)\s*=\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xhtmlContent)) !== null) {
    const ref = m[1]!;
    if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("data:"))
      continue;
    const resolved = posix.normalize(posix.join(dir, ref));
    if (resolved === targetAbsPath) return true;
  }
  return false;
}

async function run(): Promise<void> {
  const configArg = process.argv[2];
  if (!configArg) {
    log.error("usage: bun run index.ts <config.json>");
    process.exit(1);
  }
  const configPath = resolve(configArg);
  if (!existsSync(configPath)) {
    log.error(`config not found: ${configPath}`);
    process.exit(1);
  }
  const configDir = dirname(configPath);
  const config = loadConfig(configPath);

  const epubPath = resolve(configDir, config.epub);
  const prePaths = (config.pre ?? []).map((p) => resolve(configDir, p));
  const postPaths = (config.post ?? []).map((p) => resolve(configDir, p));
  const indentSkipChars = config.indentSkipChars ?? DEFAULT_INDENT_SKIP_CHARS;
  const indentClassName = config.indentClassName ?? DEFAULT_INDENT_CLASS_NAME;
  const imageClassName = config.imageClassName ?? DEFAULT_IMAGE_CLASS_NAME;

  const missing: string[] = [];
  if (!existsSync(epubPath)) missing.push(epubPath);
  for (const p of [...prePaths, ...postPaths]) {
    if (!existsSync(p)) missing.push(p);
  }
  const resizeEnabled =
    config.resize !== undefined && config.resize !== null;
  const magickPath = config.magick;
  if (resizeEnabled) {
    const hasMagick = await magickAvailable(magickPath);
    if (!hasMagick) {
      missing.push(
        magickPath
          ? `magick (path not runnable: ${magickPath})`
          : "magick (not on PATH)",
      );
    }
  }
  if (missing.length > 0) {
    for (const m of missing) log.error(`missing: ${m}`);
    process.exit(1);
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "epub-deco-"));
  log.info(`tmp dir: ${tmpRoot}`);

  let cleanup = () => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  };

  try {
    log.info(`loading: ${epubPath}`);
    const epubBytes = readFileSync(epubPath);
    const epub = await loadEpub(new Uint8Array(epubBytes));

    const opfPath = await findOpfPath(epub.zip);
    log.info(`opf: ${opfPath}`);
    const opfXml = await readText(epub.zip, opfPath);
    const opfTree = parseOpf(opfXml);
    const opfInfo = inspectOpf(opfTree);

    const spineHrefs = resolveSpineHrefs(opfInfo);
    if (spineHrefs.length === 0) {
      log.error("spine has no resolvable xhtml entries");
      process.exit(1);
    }
    const opfDir = posix.dirname(opfPath);
    const spinePathsInZip = spineHrefs.map((h) =>
      posix.normalize(posix.join(opfDir, h)),
    );
    const xhtmlWrapperDir = posix.dirname(spinePathsInZip[0]!);

    let coverSpineIdref: string | null = null;
    if (opfInfo.coverImageHref) {
      const coverImageAbs = posix.normalize(
        posix.join(opfDir, opfInfo.coverImageHref),
      );
      for (let i = 0; i < spinePathsInZip.length; i++) {
        const pathIn = spinePathsInZip[i]!;
        if (!zipExists(epub.zip, pathIn)) continue;
        const content = await readText(epub.zip, pathIn);
        if (xhtmlRefersTo(content, pathIn, coverImageAbs)) {
          coverSpineIdref = opfInfo.spineIdrefs[i]!;
          log.info(`cover page detected: ${pathIn}`);
          break;
        }
      }
    }

    const modifiedEntries = new Map<string, string | Uint8Array>();
    const newEntries: { name: string; data: string | Uint8Array }[] = [];

    // §1 CSS
    if (zipExists(epub.zip, CSS_TARGET_PATH)) {
      const cssIn = await readText(epub.zip, CSS_TARGET_PATH);
      let cssOut = removeColorDeclaration(cssIn, CSS_COLOR_TARGET);
      if (cssOut !== cssIn) {
        log.info(`css: removed "color: ${CSS_COLOR_TARGET}" declarations`);
      } else {
        log.info("css: no matching color declarations");
      }
      const cssOut2 = removeImageFullHeightRule(cssOut);
      if (cssOut2 !== cssOut) {
        log.info("css: removed img._idGenObjectAttribute-N height:100% rules");
        cssOut = cssOut2;
      }
      const cssOut3 = appendIndentParagraphRule(cssOut, indentClassName);
      if (cssOut3 !== cssOut) {
        log.info(`css: appended p.${indentClassName} rule`);
        cssOut = cssOut3;
      }
      if (cssOut !== cssIn) {
        modifiedEntries.set(CSS_TARGET_PATH, cssOut);
      }
    } else {
      log.warn(`css not found: ${CSS_TARGET_PATH} (skipped)`);
    }

    // §画像の自動再配置 + §2 Indent disable
    let totalIndentChanged = 0;
    const relocSummary: Array<{
      file: string;
      moves: Array<{ index: number; page: number }>;
    }> = [];
    for (const pathIn of spinePathsInZip) {
      if (!zipExists(epub.zip, pathIn)) {
        log.warn(`spine xhtml missing in zip: ${pathIn} (skipped)`);
        continue;
      }
      let src = await readText(epub.zip, pathIn);
      const rel = relocateImages(src, pathIn, { imageClassName });
      if (rel.changed) {
        for (const mv of rel.moves) {
          log.info(
            `relocate: 画像 #${mv.index} を page${mv.page} に挿入 (file=${pathIn})`,
          );
        }
        relocSummary.push({ file: pathIn, moves: rel.moves });
        src = rel.output;
      }
      const { output, changed } = applyIndentDisable(src, {
        className: indentClassName,
        skipChars: indentSkipChars,
      });
      if (changed > 0) {
        totalIndentChanged += changed;
        src = output;
      }
      if (rel.changed || changed > 0) {
        modifiedEntries.set(pathIn, src);
      }
    }
    log.info(`indent: updated ${totalIndentChanged} paragraphs`);

    // §3 Image pages
    const existingNames = new Set(epub.names);
    const existingManifestIds = new Set(opfInfo.manifestItems.map((i) => i.id));
    const addedManifest: AddItem[] = [];
    const preIdrefs: string[] = [];
    const postIdrefs: string[] = [];

    async function addImagePage(
      sourcePath: string,
      kind: "pre" | "post",
      index: number,
    ): Promise<void> {
      const indexStr = String(index + 1).padStart(2, "0");
      const origExt = extname(sourcePath) || ".jpg";
      const imageBase = uniqueNameInDir(
        `${kind}-${indexStr}${origExt}`,
        IMAGE_DIR,
        existingNames,
      );
      const imageZipPath = `${IMAGE_DIR}/${imageBase}`;
      existingNames.add(imageZipPath);

      const xhtmlBase = uniqueNameInDir(
        `${kind}-${indexStr}.xhtml`,
        xhtmlWrapperDir,
        existingNames,
      );
      const xhtmlZipPath = `${xhtmlWrapperDir}/${xhtmlBase}`;
      existingNames.add(xhtmlZipPath);

      const tmpFile = join(tmpRoot, imageBase);
      copyFileSync(sourcePath, tmpFile);
      let dim: { width: number; height: number };
      if (resizeEnabled) {
        log.info(`resize: ${imageBase}`);
        await resizeImage(tmpFile, config.resize as number, config.quality);
        dim = await identifyImage(tmpFile);
      } else {
        log.info(`copy (no resize): ${imageBase}`);
        dim = readImageSize(tmpFile);
      }

      const imageBytes = new Uint8Array(readFileSync(tmpFile));
      newEntries.push({ name: imageZipPath, data: imageBytes });

      const imageHrefFromXhtml = posix.relative(
        posix.dirname(xhtmlZipPath),
        imageZipPath,
      );
      const svg = svgWrapper(imageHrefFromXhtml, dim.width, dim.height, xhtmlBase);
      newEntries.push({ name: xhtmlZipPath, data: svg });

      const imageId = uniqueId(`${kind}-${indexStr}-img`, existingManifestIds);
      existingManifestIds.add(imageId);
      const pageId = uniqueId(`${kind}-${indexStr}`, existingManifestIds);
      existingManifestIds.add(pageId);

      const imageHref = posix.relative(opfDir, imageZipPath);
      const xhtmlHref = posix.relative(opfDir, xhtmlZipPath);

      addedManifest.push({
        id: imageId,
        href: imageHref,
        mediaType: extToMime(origExt),
      });
      addedManifest.push({
        id: pageId,
        href: xhtmlHref,
        mediaType: "application/xhtml+xml",
        properties: "svg",
      });
      (kind === "pre" ? preIdrefs : postIdrefs).push(pageId);
    }

    for (let i = 0; i < prePaths.length; i++) await addImagePage(prePaths[i]!, "pre", i);
    for (let i = 0; i < postPaths.length; i++) await addImagePage(postPaths[i]!, "post", i);

    // §4 / OPF update
    const plan: UpdatePlan = {
      addManifest: addedManifest,
      insertSpineAfterIdref: coverSpineIdref,
      insertSpineItems: preIdrefs,
      appendSpineItems: postIdrefs,
      dctermsModifiedUtc: utcNow(),
    };
    updateOpf(opfTree, plan);
    let opfOut = serializeOpf(opfTree);
    if (!opfOut.trimStart().startsWith("<?xml")) {
      opfOut = `<?xml version="1.0" encoding="UTF-8"?>\n${opfOut}`;
    }
    modifiedEntries.set(opfPath, opfOut);

    // rebuild zip
    log.info("building output zip");
    const outBytes = await rebuildEpub(epub, modifiedEntries, newEntries);

    // atomic rename
    const epubBase = basename(epubPath, extname(epubPath));
    const outName = `${epubBase}-concat.epub`;
    const outPath = join(configDir, outName);
    const tmpOut = `${outPath}.tmp`;
    writeFileSync(tmpOut, outBytes);
    try {
      renameSync(tmpOut, outPath);
    } catch (e) {
      try {
        rmSync(tmpOut, { force: true });
      } catch {}
      throw e;
    }
    log.info(`wrote: ${outPath}`);

    // report
    const entries = readMetadataEntries(opfTree);
    log.info("--- metadata ---");
    for (const e of entries) {
      const attrStr = Object.entries(e.attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      const tag = attrStr ? `${e.tag} ${attrStr}` : e.tag;
      log.info(`  <${tag}>${e.text}</${e.tag}>`);
    }
    const addedFiles = newEntries.length;
    const size = statSync(outPath).size;
    log.info(`added files: ${addedFiles}`);
    log.info(`output size: ${formatBytes(size)}`);

    printRelocateSummary(relocSummary);
  } finally {
    cleanup();
  }
}

function printRelocateSummary(
  summary: Array<{ file: string; moves: Array<{ index: number; page: number }> }>,
): void {
  const rows = summary.filter((s) => s.moves.length > 0);
  if (rows.length === 0) {
    log.info("画像再配置: 対象なし");
    return;
  }
  log.info("画像再配置の結果:");
  let total = 0;
  for (const r of rows) {
    const pages = r.moves.map((m) => m.page).join(", ");
    log.info(`  ${r.file}: ${r.moves.length}件 (${pages})`);
    total += r.moves.length;
  }
  log.info(`  合計: ${total}件`);
}

run().catch((e) => {
  if (e instanceof RelocError) {
    log.error(String(e.message));
    process.exit(1);
  }
  log.error(String(e?.stack ?? e));
  process.exit(1);
});
