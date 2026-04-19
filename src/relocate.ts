export class RelocError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RelocError";
  }
}

export interface RelocateOptions {
  imageClassName: string;
}

export interface RelocateResult {
  output: string;
  moves: Array<{ index: number; page: number }>;
  changed: boolean;
}

type TokKind =
  | "open"
  | "close"
  | "selfclose"
  | "text"
  | "comment"
  | "doctype"
  | "pi"
  | "cdata";

interface Tok {
  kind: TokKind;
  name?: string;
  attrs?: Record<string, string>;
  start: number;
  end: number;
}

interface Elem {
  name: string;
  attrs: Record<string, string>;
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  selfClose: boolean;
  parent: Elem | null;
  children: Elem[];
  docIdx: number;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re =
    /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[1]!;
    let value = "";
    if (m[2] !== undefined) value = m[2]!;
    else if (m[3] !== undefined) value = m[3]!;
    else if (m[4] !== undefined) value = m[4]!;
    attrs[name] = value;
  }
  return attrs;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] !== "<") {
      const start = i;
      while (i < n && src[i] !== "<") i++;
      if (i > start) toks.push({ kind: "text", start, end: i });
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) throw new Error(`unterminated comment at ${i}`);
      toks.push({ kind: "comment", start: i, end: end + 3 });
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) throw new Error(`unterminated CDATA at ${i}`);
      toks.push({ kind: "cdata", start: i, end: end + 3 });
      i = end + 3;
      continue;
    }
    if (
      src.startsWith("<!DOCTYPE", i) ||
      src.startsWith("<!doctype", i) ||
      src.startsWith("<!Doctype", i)
    ) {
      let j = i + 9;
      let depth = 0;
      while (j < n) {
        const c = src[j]!;
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) {
          j++;
          break;
        }
        j++;
      }
      toks.push({ kind: "doctype", start: i, end: j });
      i = j;
      continue;
    }
    if (src[i + 1] === "?") {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) throw new Error(`unterminated PI at ${i}`);
      toks.push({ kind: "pi", start: i, end: end + 2 });
      i = end + 2;
      continue;
    }
    if (src[i + 1] === "/") {
      const end = src.indexOf(">", i);
      if (end < 0) throw new Error(`unterminated end tag at ${i}`);
      const inner = src.slice(i + 2, end).trim();
      toks.push({ kind: "close", name: inner, start: i, end: end + 1 });
      i = end + 1;
      continue;
    }
    let j = i + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = src[j]!;
      if (quote) {
        if (c === quote) quote = null;
      } else {
        if (c === `"` || c === `'`) quote = c;
        else if (c === ">") break;
      }
      j++;
    }
    if (j >= n) throw new Error(`unterminated start tag at ${i}`);
    const endOfTag = j + 1;
    let inner = src.slice(i + 1, j);
    const selfClose = inner.endsWith("/");
    if (selfClose) inner = inner.slice(0, -1);
    const nmMatch = inner.match(/^\s*([^\s>]+)/);
    const name = nmMatch ? nmMatch[1]! : "";
    const attrsText = inner.slice(nmMatch ? nmMatch[0].length : 0);
    const attrs = parseAttrs(attrsText);
    toks.push({
      kind: selfClose ? "selfclose" : "open",
      name,
      attrs,
      start: i,
      end: endOfTag,
    });
    i = endOfTag;
  }
  return toks;
}

function buildTree(toks: Tok[]): Elem {
  const root: Elem = {
    name: "#root",
    attrs: {},
    openStart: 0,
    openEnd: 0,
    closeStart: 0,
    closeEnd: 0,
    selfClose: false,
    parent: null,
    children: [],
    docIdx: -1,
  };
  const stack: Elem[] = [root];
  let docCounter = 0;
  for (const tok of toks) {
    const top = stack[stack.length - 1]!;
    if (tok.kind === "open") {
      const elem: Elem = {
        name: tok.name!,
        attrs: tok.attrs ?? {},
        openStart: tok.start,
        openEnd: tok.end,
        closeStart: tok.start,
        closeEnd: tok.end,
        selfClose: false,
        parent: top,
        children: [],
        docIdx: docCounter++,
      };
      top.children.push(elem);
      stack.push(elem);
    } else if (tok.kind === "selfclose") {
      const elem: Elem = {
        name: tok.name!,
        attrs: tok.attrs ?? {},
        openStart: tok.start,
        openEnd: tok.end,
        closeStart: tok.start,
        closeEnd: tok.end,
        selfClose: true,
        parent: top,
        children: [],
        docIdx: docCounter++,
      };
      top.children.push(elem);
    } else if (tok.kind === "close") {
      if (stack.length <= 1) {
        throw new Error(`unexpected close </${tok.name}> at ${tok.start}`);
      }
      const popped = stack.pop()!;
      if (popped.name !== tok.name) {
        throw new Error(
          `mismatched close </${tok.name}>, expected </${popped.name}> at ${tok.start}`,
        );
      }
      popped.closeStart = tok.start;
      popped.closeEnd = tok.end;
    }
  }
  if (stack.length !== 1) {
    throw new Error(`unclosed tags at end of document`);
  }
  return root;
}

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "blockquote",
  "body",
  "html",
  "figure",
  "ol",
  "ul",
  "nav",
  "header",
  "footer",
  "aside",
  "main",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "dl",
  "dt",
  "dd",
  "pre",
  "form",
  "fieldset",
  "address",
  "hr",
]);

function visitAll(
  root: Elem,
  fn: (e: Elem, ancestors: Elem[]) => void,
): void {
  function visit(elem: Elem, ancestors: Elem[]): void {
    fn(elem, ancestors);
    const next = [...ancestors, elem];
    for (const c of elem.children) visit(c, next);
  }
  for (const c of root.children) visit(c, []);
}

interface PbInfo {
  elem: Elem;
  label: number;
  ancestors: Elem[];
}

const BASIC_GRID_CLASS = "基本グリッド";
const TOC_TYPE = "toc";

function hasClass(e: Elem, name: string): boolean {
  return (e.attrs["class"] ?? "").split(/\s+/).includes(name);
}

function isBasicGrid(e: Elem): boolean {
  return e.name === "div" && hasClass(e, BASIC_GRID_CLASS);
}

function hasEpubType(e: Elem, t: string): boolean {
  return (e.attrs["epub:type"] ?? "").split(/\s+/).includes(t);
}

export function relocateImages(
  xhtml: string,
  filename: string,
  opts: RelocateOptions,
): RelocateResult {
  const toks = tokenize(xhtml);
  const root = buildTree(toks);

  const pbs: PbInfo[] = [];
  const allImages: Elem[] = [];
  const basicGrids: Elem[] = [];
  let tocElem: Elem | null = null;

  const isImageDiv = (e: Elem) =>
    e.name === "div" && hasClass(e, opts.imageClassName);

  visitAll(root, (e, ancestors) => {
    const role = e.attrs["role"];
    const epubType = e.attrs["epub:type"];
    const isPb =
      (role === "doc-pagebreak" || epubType === "pagebreak") &&
      (e.name === "div" || e.name === "span");
    if (isPb) {
      const lbl = e.attrs["aria-label"] ?? "";
      const label = /^-?\d+$/.test(lbl) ? parseInt(lbl, 10) : NaN;
      pbs.push({ elem: e, label, ancestors });
      return;
    }
    if (isImageDiv(e)) allImages.push(e);
    if (isBasicGrid(e)) basicGrids.push(e);
    if (!tocElem && hasEpubType(e, TOC_TYPE)) tocElem = e;
  });

  const tailWrappers: Elem[] = [];
  const tailWrapperSet = new Set<Elem>();
  for (const bg of basicGrids) {
    const parent = bg.parent;
    if (!parent) continue;
    const idx = parent.children.indexOf(bg);
    for (let i = idx + 1; i < parent.children.length; i++) {
      const s = parent.children[i]!;
      if (s.name !== "div") break;
      const hasImg = s.children.some((c) => isImageDiv(c));
      if (!hasImg) break;
      tailWrappers.push(s);
      tailWrapperSet.add(s);
    }
  }

  for (const pb of pbs) {
    if (Number.isNaN(pb.label)) {
      throw new RelocError(
        `${filename}: aria-label が整数ではありません (${pb.elem.name}, aria-label="${pb.elem.attrs["aria-label"] ?? ""}")`,
      );
    }
  }

  if (pbs.length === 0) {
    return { output: xhtml, moves: [], changed: false };
  }

  for (let i = 1; i < pbs.length; i++) {
    if (pbs[i - 1]!.label >= pbs[i]!.label) {
      throw new RelocError(
        `${filename}: aria-label が document 順で逆転/重複: ${pbs[i - 1]!.label} → ${pbs[i]!.label}`,
      );
    }
  }
  const labelSet = new Set<number>();
  for (const pb of pbs) {
    if (labelSet.has(pb.label)) {
      throw new RelocError(
        `${filename}: aria-label が重複: ${pb.label}`,
      );
    }
    labelSet.add(pb.label);
  }

  if (allImages.length === 0) {
    return { output: xhtml, moves: [], changed: false };
  }

  const inBody: Elem[] = [];
  for (const img of allImages) {
    let inside = false;
    let e: Elem | null = img.parent;
    while (e) {
      if (tailWrapperSet.has(e)) {
        inside = true;
        break;
      }
      e = e.parent;
    }
    if (!inside) inBody.push(img);
  }

  let tocThresholdLabel: number | null = null;
  if (tocElem) {
    const tocDocIdx = (tocElem as Elem).docIdx;
    const firstAfterToc = pbs.find((p) => p.elem.docIdx > tocDocIdx);
    if (firstAfterToc) tocThresholdLabel = firstAfterToc.label;
  }

  const gapCandidates: number[] = [];
  for (let i = 0; i < pbs.length - 1; i++) {
    const a = pbs[i]!;
    const b = pbs[i + 1]!;
    const holes: number[] = [];
    for (let p = a.label + 1; p < b.label; p++) {
      if (tocThresholdLabel !== null && p < tocThresholdLabel) continue;
      holes.push(p);
    }
    const k = inBody.filter(
      (im) => im.docIdx > a.elem.docIdx && im.docIdx < b.elem.docIdx,
    ).length;
    gapCandidates.push(...holes.slice(k));
  }

  if (tailWrappers.length !== gapCandidates.length) {
    throw new RelocError(
      `${filename}: tail 画像数 ${tailWrappers.length} と候補ギャップ数 ${gapCandidates.length} が一致しません。候補=[${gapCandidates.join(", ")}]`,
    );
  }

  if (tailWrappers.length === 0) {
    return { output: xhtml, moves: [], changed: false };
  }

  interface Plan {
    wrapper: Elem;
    page: number;
    insertOffset: number;
  }

  const plans: Plan[] = [];
  for (let k = 0; k < tailWrappers.length; k++) {
    const page = gapCandidates[k]!;
    let pbNext: PbInfo | null = null;
    for (const pb of pbs) {
      if (pb.label >= page + 1) {
        pbNext = pb;
        break;
      }
    }
    if (!pbNext) {
      throw new RelocError(
        `${filename}: 内部エラー: page ${page} の後に続くページブレークが見つかりません`,
      );
    }

    let insertOffset: number;
    if (pbNext.elem.name === "div") {
      insertOffset = pbNext.elem.openStart;
    } else {
      let found: Elem | null = null;
      for (let i = pbNext.ancestors.length - 1; i >= 0; i--) {
        const a = pbNext.ancestors[i]!;
        if (BLOCK_TAGS.has(a.name)) {
          if (a.name === "p") {
            found = a;
          }
          break;
        }
      }
      if (!found) {
        throw new RelocError(
          `${filename}: span 型ページブレーク (aria-label=${pbNext.label}) の祖先に <p> がありません`,
        );
      }
      insertOffset = found.openStart;
    }

    plans.push({ wrapper: tailWrappers[k]!, page, insertOffset });
  }

  interface Edit {
    start: number;
    end: number;
    replacement: string;
  }
  const edits: Edit[] = [];

  function collectImageDivs(e: Elem, out: Elem[]): void {
    if (isImageDiv(e)) out.push(e);
    for (const c of e.children) collectImageDivs(c, out);
  }

  for (const p of plans) {
    let imgText = xhtml.slice(p.wrapper.openStart, p.wrapper.closeEnd);

    const inner: Elem[] = [];
    collectImageDivs(p.wrapper, inner);
    const localEdits: Array<{
      start: number;
      end: number;
      replacement: string;
    }> = [];
    for (const d of inner) {
      const relStart = d.openStart - p.wrapper.openStart;
      const relEnd = d.openEnd - p.wrapper.openStart;
      const orig = imgText.slice(relStart, relEnd);
      const modified = orig.replace(
        /\s+id\s*=\s*(?:"_idContainer\d+"|'_idContainer\d+')/,
        "",
      );
      if (modified !== orig) {
        localEdits.push({ start: relStart, end: relEnd, replacement: modified });
      }
    }
    localEdits.sort((a, b) => b.start - a.start);
    for (const e of localEdits) {
      imgText = imgText.slice(0, e.start) + e.replacement + imgText.slice(e.end);
    }

    edits.push({
      start: p.insertOffset,
      end: p.insertOffset,
      replacement: imgText,
    });
    edits.push({
      start: p.wrapper.openStart,
      end: p.wrapper.closeEnd,
      replacement: "",
    });
  }

  edits.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return 0;
  });

  const pieces: string[] = [];
  let cur = 0;
  for (const e of edits) {
    if (e.start < cur) {
      throw new Error(
        `internal: overlapping edits at ${e.start} < cur ${cur}`,
      );
    }
    pieces.push(xhtml.slice(cur, e.start));
    pieces.push(e.replacement);
    cur = e.end;
  }
  pieces.push(xhtml.slice(cur));
  const output = pieces.join("");

  return {
    output,
    moves: plans.map((p, i) => ({ index: i + 1, page: p.page })),
    changed: true,
  };
}
