const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeFirstEntity(s: string): { ch: string; rest: string } | null {
  const m = s.match(/^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/);
  if (!m) return null;
  const ent = m[1];
  let ch: string;
  if (ent.startsWith("#x") || ent.startsWith("#X")) {
    ch = String.fromCodePoint(parseInt(ent.slice(2), 16));
  } else if (ent.startsWith("#")) {
    ch = String.fromCodePoint(parseInt(ent.slice(1), 10));
  } else {
    ch = ENTITY_MAP[ent] ?? s[0];
  }
  return { ch, rest: s.slice(m[0].length) };
}

export function firstRealChar(innerHtml: string): string | null {
  let s = innerHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "");
  while (s.length > 0) {
    const c = s[0];
    if (/\s/.test(c)) {
      s = s.slice(1);
      continue;
    }
    if (c === "&") {
      const dec = decodeFirstEntity(s);
      if (dec) {
        if (/\s/.test(dec.ch)) {
          s = dec.rest;
          continue;
        }
        return dec.ch;
      }
    }
    return c;
  }
  return null;
}

function hasClassIndent(classAttr: string, klass: string): boolean {
  return classAttr.split(/\s+/).some((c) => c === klass);
}

function parseStyle(style: string): Array<[string, string]> {
  return style
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const idx = s.indexOf(":");
      if (idx < 0) return [s, ""] as [string, string];
      return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()] as [
        string,
        string,
      ];
    });
}

function styleHasTextIndent(style: string): boolean {
  return parseStyle(style).some(([k]) => k.toLowerCase() === "text-indent");
}

function addTextIndentZero(style: string): string {
  const trimmed = style.trim();
  if (trimmed.length === 0) return "text-indent: 0;";
  const withSemi = trimmed.endsWith(";") ? trimmed : `${trimmed};`;
  return `${withSemi}text-indent: 0;`;
}

export interface IndentOptions {
  className: string;
  skipChars: string;
}

export function applyIndentDisable(
  xhtml: string,
  opts: IndentOptions,
): { output: string; changed: number } {
  const skipSet = new Set(Array.from(opts.skipChars));
  let changed = 0;

  const pTagRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  const attrRe = /\s([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

  const output = xhtml.replace(pTagRe, (full, attrsRaw: string, inner: string) => {
    const attrs: Record<string, { value: string; quote: string }> = {};
    const order: string[] = [];
    let m: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((m = attrRe.exec(attrsRaw)) !== null) {
      const name = m[1];
      const value = m[3] !== undefined ? m[3] : m[4] ?? "";
      const quote = m[2][0];
      if (!(name in attrs)) order.push(name);
      attrs[name] = { value, quote };
    }

    const classAttr = attrs["class"]?.value ?? "";
    if (!hasClassIndent(classAttr, opts.className)) return full;

    const firstCh = firstRealChar(inner);
    if (!firstCh || !skipSet.has(firstCh)) return full;

    const existingStyle = attrs["style"]?.value;
    if (existingStyle !== undefined) {
      if (styleHasTextIndent(existingStyle)) return full;
      attrs["style"] = {
        value: addTextIndentZero(existingStyle),
        quote: attrs["style"]!.quote,
      };
    } else {
      attrs["style"] = { value: "text-indent: 0;", quote: '"' };
      order.push("style");
    }

    changed++;
    const rebuilt = order
      .map((n) => {
        const { value, quote } = attrs[n]!;
        return ` ${n}=${quote}${value}${quote}`;
      })
      .join("");
    return `<p${rebuilt}>${inner}</p>`;
  });

  return { output, changed };
}
