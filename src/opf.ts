import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { posix } from "node:path";

export type OpfTree = any[];
type Node = Record<string, any> & { ":@"?: Record<string, string> };

const parserOpts = {
  ignoreAttributes: false,
  preserveOrder: true,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  commentPropName: "#comment",
};

const builderOpts = {
  ignoreAttributes: false,
  preserveOrder: true,
  attributeNamePrefix: "@_",
  suppressEmptyNode: true,
  suppressBooleanAttributes: false,
  commentPropName: "#comment",
  format: false,
};

export function parseOpf(xml: string): OpfTree {
  return new XMLParser(parserOpts).parse(xml);
}

export function serializeOpf(tree: OpfTree): string {
  return new XMLBuilder(builderOpts).build(tree);
}

function nodeTagName(node: Node): string | null {
  for (const key of Object.keys(node)) {
    if (key === ":@") continue;
    return key;
  }
  return null;
}

function findChild(children: Node[], tagName: string): Node | null {
  for (const child of children) {
    if (tagName in child) return child;
  }
  return null;
}

function findPackage(tree: OpfTree): Node {
  for (const n of tree) {
    if ("package" in n) return n;
  }
  throw new Error("content.opf: <package> not found");
}

function getAttrs(node: Node): Record<string, string> {
  if (!node[":@"]) node[":@"] = {};
  return node[":@"]!;
}

function attr(node: Node, name: string): string | undefined {
  return node[":@"]?.[`@_${name}`];
}

function setAttr(node: Node, name: string, value: string): void {
  getAttrs(node)[`@_${name}`] = value;
}

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

export interface OpfInfo {
  manifestItems: ManifestItem[];
  spineIdrefs: string[];
  coverImageId: string | null;
  coverImageHref: string | null;
}

export function inspectOpf(tree: OpfTree): OpfInfo {
  const pkg = findPackage(tree);
  const pkgChildren = pkg.package as Node[];
  const manifest = findChild(pkgChildren, "manifest");
  const spine = findChild(pkgChildren, "spine");
  if (!manifest) throw new Error("content.opf: <manifest> not found");
  if (!spine) throw new Error("content.opf: <spine> not found");

  const manifestItems: ManifestItem[] = (manifest.manifest as Node[])
    .filter((c) => "item" in c)
    .map((c) => ({
      id: attr(c, "id") ?? "",
      href: attr(c, "href") ?? "",
      mediaType: attr(c, "media-type") ?? "",
      properties: attr(c, "properties"),
    }));

  const spineIdrefs: string[] = (spine.spine as Node[])
    .filter((c) => "itemref" in c)
    .map((c) => attr(c, "idref") ?? "");

  let coverImageId: string | null = null;
  let coverImageHref: string | null = null;
  for (const it of manifestItems) {
    if (it.properties && it.properties.split(/\s+/).includes("cover-image")) {
      coverImageId = it.id;
      coverImageHref = it.href;
      break;
    }
  }

  return { manifestItems, spineIdrefs, coverImageId, coverImageHref };
}

export function resolveSpineHrefs(info: OpfInfo): string[] {
  const map = new Map(info.manifestItems.map((i) => [i.id, i.href]));
  return info.spineIdrefs
    .map((id) => map.get(id))
    .filter((h): h is string => !!h);
}

export interface AddItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

export interface UpdatePlan {
  addManifest: AddItem[];
  insertSpineAfterIdref: string | null;
  insertSpineItems: string[];
  appendSpineItems: string[];
  dctermsModifiedUtc: string;
}

export function updateOpf(tree: OpfTree, plan: UpdatePlan): void {
  const pkg = findPackage(tree);
  const pkgChildren = pkg.package as Node[];
  const manifest = findChild(pkgChildren, "manifest")!;
  const spine = findChild(pkgChildren, "spine")!;
  const metadata = findChild(pkgChildren, "metadata");
  if (!metadata) throw new Error("content.opf: <metadata> not found");

  const manifestChildren = manifest.manifest as Node[];
  for (const add of plan.addManifest) {
    const node: Node = { item: [] };
    const a: Record<string, string> = {
      "@_id": add.id,
      "@_href": add.href,
      "@_media-type": add.mediaType,
    };
    if (add.properties) a["@_properties"] = add.properties;
    node[":@"] = a;
    manifestChildren.push(node);
  }

  const spineChildren = spine.spine as Node[];
  const newItemrefs = plan.insertSpineItems.map<Node>((idref) => ({
    itemref: [],
    ":@": { "@_idref": idref },
  }));

  if (plan.insertSpineAfterIdref !== null) {
    const idx = spineChildren.findIndex(
      (c) => "itemref" in c && attr(c, "idref") === plan.insertSpineAfterIdref,
    );
    if (idx >= 0) {
      spineChildren.splice(idx + 1, 0, ...newItemrefs);
    } else {
      const firstIdx = spineChildren.findIndex((c) => "itemref" in c);
      if (firstIdx >= 0) spineChildren.splice(firstIdx, 0, ...newItemrefs);
      else spineChildren.push(...newItemrefs);
    }
  } else {
    const firstIdx = spineChildren.findIndex((c) => "itemref" in c);
    if (firstIdx >= 0) spineChildren.splice(firstIdx, 0, ...newItemrefs);
    else spineChildren.push(...newItemrefs);
  }

  for (const idref of plan.appendSpineItems) {
    spineChildren.push({ itemref: [], ":@": { "@_idref": idref } });
  }

  const metaChildren = metadata.metadata as Node[];
  let modifiedNode: Node | null = null;
  for (const c of metaChildren) {
    if ("meta" in c && attr(c, "property") === "dcterms:modified") {
      modifiedNode = c;
      break;
    }
  }
  if (modifiedNode) {
    modifiedNode.meta = [{ "#text": plan.dctermsModifiedUtc }];
  } else {
    metaChildren.push({
      meta: [{ "#text": plan.dctermsModifiedUtc }],
      ":@": { "@_property": "dcterms:modified" },
    });
  }
}

export interface MetadataEntry {
  tag: string;
  attrs: Record<string, string>;
  text: string;
}

export function readMetadataEntries(tree: OpfTree): MetadataEntry[] {
  const pkg = findPackage(tree);
  const metadata = findChild(pkg.package as Node[], "metadata");
  if (!metadata) return [];
  const entries: MetadataEntry[] = [];
  for (const c of metadata.metadata as Node[]) {
    const tag = nodeTagName(c);
    if (!tag || tag.startsWith("#")) continue;
    const attrs: Record<string, string> = {};
    const rawAttrs = c[":@"] ?? {};
    for (const k of Object.keys(rawAttrs)) {
      attrs[k.replace(/^@_/, "")] = rawAttrs[k]!;
    }
    const children = c[tag] as Node[];
    const text = children
      .filter((ch) => "#text" in ch)
      .map((ch) => String(ch["#text"]))
      .join("");
    entries.push({ tag, attrs, text });
  }
  return entries;
}

export function resolveHrefRelativeToOpf(
  opfPathInZip: string,
  href: string,
): string {
  const opfDir = posix.dirname(opfPathInZip);
  return posix.normalize(posix.join(opfDir, href));
}
