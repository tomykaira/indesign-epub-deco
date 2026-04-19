export function removeImageFullHeightRule(css: string): string {
  const re =
    /(?:\r?\n)?[ \t]*img\._idGenObjectAttribute-\d+\s*\{\s*height\s*:\s*100(?:\.0+)?%\s*;?\s*\}/g;
  return css.replace(re, "");
}

export function removeColorDeclaration(css: string, target: string): string {
  const colorLike = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(
    `\\s*(?<![\\w-])color\\s*:\\s*${colorLike}\\s*;?`,
    "gi",
  );

  const lines = css.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const replaced = line.replace(declRe, "");
    if (line.match(declRe) && replaced.trim() === "") continue;
    out.push(replaced);
  }
  return out.join("\n");
}
