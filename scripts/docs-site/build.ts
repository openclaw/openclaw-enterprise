import fs from "node:fs";
import type { Dirent } from "node:fs";
import GithubSlugger from "github-slugger";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createMarkdownRenderer, renderMdxish } from "./vendor/mdx-ish.mjs";
import { renderComputeMatrixBlocks } from "./compute-matrix.ts";
import {
  parseDocsDocument,
  parseFrontmatter,
  resolveDocsFragment,
} from "./vendor/docs-markdown.mjs";
import { createGithubAnchorReader, githubHeadingVisibleText } from "./github-anchors.ts";
import { publicMarkdown } from "./public-markdown.ts";

interface ParsedMarkdown {
  tokens: ReturnType<ReturnType<typeof createMarkdownRenderer>["parse"]>;
  ids: string[];
  links: string[];
}

interface Frontmatter {
  published?: unknown;
  tags?: unknown;
  last_verified?: unknown;
  title?: unknown;
  searchable?: unknown;
}

interface HeadingId {
  id: string;
  alias: string | undefined;
  droppedMint: string | undefined;
}

type PageEntry = string | { page: string; label?: string };
type GroupEntry = { group: string; pages: (GroupEntry | PageEntry)[] };
interface TabEntry {
  tab: string;
  groups: GroupEntry[];
  hidden?: PageEntry[];
}

interface DocsConfig {
  navigation: { languages: { language: string; tabs: TabEntry[] }[] };
  redirects?: { from: string; to: string; anchors?: Record<string, string> }[];
}

interface PageSource {
  source: string;
  file: string;
}

interface Page extends PageSource {
  text: string;
  title: unknown;
  route: string;
  searchable: boolean;
  humanVerified: boolean;
  lastVerified: unknown;
  ids: Set<string>;
  headingIds: Map<string, HeadingId>;
  parsed: ParsedMarkdown;
  html: string;
  navigation?: { tab: NavigationTab; groups: NavigationGroup[]; label: unknown };
}

interface NavigationGroup {
  group: string;
  pages: (NavigationGroup | Page)[];
  landing: Page | undefined;
}

interface NavigationTab {
  tab: string;
  groups: NavigationGroup[];
  landing: Page | undefined;
  linksHtml: string;
}

const { values } = parseArgs({
  options: { check: { type: "boolean" }, output: { type: "string" } },
});
const checkOnly = values.check;
const root = process.cwd();
const docs = path.join(root, "docs");
const output = path.resolve(root, values.output ?? "dist/docs");
if (values.output !== undefined) {
  const previewPath = path.relative(path.join(root, "dist"), output).split(path.sep).join("/");
  if (!/^\.docs-preview-[a-zA-Z0-9]{6}\/[1-9]\d*$/.test(previewPath)) {
    throw new Error("Preview output must be a new build directory under dist/.docs-preview-*/");
  }
  const parent = path.dirname(output);
  if (
    fs.realpathSync(parent) !==
    path.join(fs.realpathSync(path.join(root, "dist")), path.basename(parent))
  ) {
    throw new Error("Preview output cannot use a linked directory");
  }
}
const assets = path.dirname(fileURLToPath(import.meta.url));
const repository = "https://github.com/openclaw/openclaw-enterprise";
const themeBootstrap =
  '<script>try{const theme=localStorage.getItem("enterprise-docs-theme");if(theme==="light"||theme==="dark"){document.documentElement.dataset.theme=theme}}catch{}</script>';
const config: DocsConfig = JSON.parse(fs.readFileSync(path.join(docs, "docs.json"), "utf8"));
const md = createMarkdownRenderer();
const githubAnchors = createGithubAnchorReader(md);
const pages = new Map<string, Page>();
const unpublished = new Set<string>();
const escape = (value: unknown) => md.utils.escapeHtml(String(value));
const route = (source: string) =>
  "/" +
  source
    .replace(/(?:^|\/)README\.md$/, "")
    .replace(/\.md$/, "")
    .replace(/\/$/, "") +
  (source === "README.md" ? "" : "/");

// GitHub's heading slug is the canonical heading ID, so permalinks, the table of
// contents, and source links agree. The renderer's own ID stays as an alias.
function githubHeadingIds(parsed: ParsedMarkdown, ids: Set<string>) {
  const github = new GithubSlugger();
  const headingIds = new Map<string, HeadingId>();
  for (let i = 0; i < parsed.tokens.length; i++) {
    const token = parsed.tokens[i]!;
    if (token.type !== "heading_open") {
      continue;
    }
    const id = token.attrGet("id") as string;
    const mint = token.meta?.anchorAlias as string | undefined;
    const slug = github.slug(githubHeadingVisibleText(parsed.tokens[i + 1]));
    // Existing IDs keep their owner: a heading takes its slug only if nobody else has it,
    // and an empty slug keeps the renderer's ID.
    const canonical = slug && (slug === id || slug === mint || !ids.has(slug)) ? slug : id;
    ids.add(canonical);
    headingIds.set(id, {
      id: canonical,
      alias: canonical === id ? undefined : id,
      // The renderer's alias span would repeat an ID that now names the heading.
      droppedMint: canonical === mint ? mint : undefined,
    });
  }
  return headingIds;
}

function useGithubHeadingIds(html: string, headingIds: Map<string, HeadingId>) {
  const span = (id: string, attributes = "") =>
    '<span id="' + escape(id) + '" class="anchor-alias"' + attributes + "></span>";
  return html.replace(/<h[1-6]\b[^>]*\bid="[^"]*"[^>]*>[\s\S]*?<\/h[1-6]>/g, (heading) => {
    const previous = md.utils.unescapeAll(heading.match(/\bid="([^"]*)"/)![1]!);
    const target = headingIds.get(previous);
    if (!target) {
      return heading;
    }
    let result = heading;
    if (target.droppedMint) {
      result = result.replace(span(target.droppedMint, ' aria-hidden="true"'), "");
    }
    return result
      .replace(
        /^(<h[1-6]\b[^>]*\bid=")[^"]*"/,
        (_match: string, open: string) => open + escape(target.id) + '"',
      )
      .replace(/^<h[1-6]\b[^>]*>/, (open) => open + (target.alias ? span(target.alias) : ""));
  });
}

function walk(
  directory: string,
  acceptsFile = (entry: Dirent) => entry.name.endsWith(".md"),
): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(file, acceptsFile)
      : entry.isFile() && acceptsFile(entry)
        ? [file]
        : [];
  });
}

function yamlCommentMarkdownBlocks(file: string) {
  const blocks = [];
  let block: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*# ?(.*)$/);
    if (match) {
      block.push(match[1]!);
      continue;
    }
    if (block.length) {
      blocks.push(block.join("\n"));
      block = [];
    }
  }
  if (block.length) {
    blocks.push(block.join("\n"));
  }
  return blocks;
}

for (const file of walk(docs)) {
  const source = path.relative(docs, file).split(path.sep).join("/");
  const authored = fs.readFileSync(file, "utf8");
  const frontmatter: Frontmatter = parseFrontmatter(authored).data;
  if (frontmatter?.published !== undefined && typeof frontmatter.published !== "boolean") {
    throw new Error(source + ": published frontmatter must be true or false");
  }
  if (frontmatter?.published === false) {
    unpublished.add(source);
    continue;
  }
  const humanVerified =
    Array.isArray(frontmatter?.tags) && frontmatter.tags.includes("human_verified");
  const lastVerified = frontmatter?.last_verified;
  if (humanVerified || lastVerified !== undefined) {
    if (
      typeof lastVerified !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(lastVerified) ||
      !Number.isFinite(Date.parse(lastVerified)) ||
      new Date(lastVerified).toISOString().slice(0, 10) !== lastVerified
    ) {
      throw new Error(
        source + ": last_verified must be a valid YYYY-MM-DD date for human verification",
      );
    }
  }
  const text = publicMarkdown(authored, md);
  const parsed: ParsedMarkdown = parseDocsDocument(text, md, { sourceFile: file, root: docs });
  const ids = new Set(parsed.ids);
  const headingIds = githubHeadingIds(parsed, ids);
  const firstHeading = parsed.tokens.findIndex(
    (token) => token.type === "heading_open" && token.tag === "h1",
  );
  const title = frontmatter?.title ?? parsed.tokens[firstHeading + 1]?.content ?? source;
  pages.set(source, {
    source,
    file,
    text,
    title,
    route: route(source),
    searchable: frontmatter?.searchable !== false,
    humanVerified,
    lastVerified,
    ids,
    headingIds,
    parsed,
    html: "",
  });
}
// Former published routes remain usable without retaining duplicate source pages.
const redirects = config.redirects ?? [];
if (!Array.isArray(redirects)) {
  throw new Error("docs/docs.json redirects must be an array");
}
const redirectSources = new Set<string>();
function checkRedirectTarget(target: unknown) {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) {
    throw new Error("Invalid redirect target: " + target);
  }
  const url = new URL(target, "https://local.invalid");
  const page = [...pages.values()].find((candidate) => candidate.route === url.pathname);
  if (
    url.origin !== "https://local.invalid" ||
    !page ||
    url.search ||
    (url.hash && !resolveDocsFragment(url.hash, page.ids))
  ) {
    throw new Error("Missing redirect page or heading: " + target);
  }
}
for (const redirect of redirects) {
  if (
    !redirect ||
    typeof redirect.from !== "string" ||
    !/^\/(?:[a-z0-9-]+\/)+$/.test(redirect.from) ||
    redirectSources.has(redirect.from) ||
    [...pages.values()].some((page) => page.route === redirect.from)
  ) {
    throw new Error("Invalid or duplicate redirect route: " + redirect?.from);
  }
  redirectSources.add(redirect.from);
  checkRedirectTarget(redirect.to);
  if (
    redirect.anchors !== undefined &&
    (!redirect.anchors || typeof redirect.anchors !== "object" || Array.isArray(redirect.anchors))
  ) {
    throw new Error("Redirect anchors must be an object: " + redirect.from);
  }
  for (const target of Object.values(redirect.anchors ?? {})) {
    checkRedirectTarget(target);
  }
}
const configuredTabs = config.navigation.languages.find(
  (language) => language.language === "en",
)?.tabs;
if (!configuredTabs?.length) {
  throw new Error("docs/docs.json must declare English navigation tabs");
}
const covered = new Set<string>();

function navigationPage(entry: PageEntry, tab: NavigationTab, groups: NavigationGroup[]): Page {
  const slug = typeof entry === "string" ? entry : entry?.page;
  if (typeof slug !== "string" || !slug || (typeof entry === "object" && "group" in entry)) {
    throw new Error("Invalid navigation page in " + tab.tab + ": " + JSON.stringify(entry));
  }
  if (
    typeof entry === "object" &&
    "label" in entry &&
    (typeof entry.label !== "string" || !entry.label.trim())
  ) {
    throw new Error("Invalid navigation label for " + slug);
  }
  const source = slug + ".md";
  const page = pages.get(source);
  if (!page) {
    throw new Error("Missing navigation page: " + source);
  }
  if (covered.has(source)) {
    throw new Error("Duplicate navigation page: " + source);
  }
  covered.add(source);
  page.navigation = {
    tab,
    groups,
    label: typeof entry === "string" ? page.title : (entry.label ?? page.title),
  };
  return page;
}

function navigationGroup(
  entry: GroupEntry,
  tab: NavigationTab,
  ancestors: NavigationGroup[] = [],
): NavigationGroup {
  if (
    typeof entry?.group !== "string" ||
    !entry.group.trim() ||
    "page" in entry ||
    !Array.isArray(entry.pages) ||
    !entry.pages.length
  ) {
    throw new Error("Invalid navigation group in " + tab.tab + ": " + JSON.stringify(entry));
  }
  const group: NavigationGroup = { group: entry.group, pages: [], landing: undefined };
  const groups = [...ancestors, group];
  group.pages = entry.pages.map((child) =>
    child && typeof child === "object" && "group" in child
      ? navigationGroup(child, tab, groups)
      : navigationPage(child, tab, groups),
  );
  const firstPage = group.pages[0]!;
  group.landing = "group" in firstPage ? firstPage.landing : firstPage;
  return group;
}

const tabs = configuredTabs.map((entry) => {
  if (
    typeof entry?.tab !== "string" ||
    !entry.tab.trim() ||
    !Array.isArray(entry.groups) ||
    !entry.groups.length
  ) {
    throw new Error("Invalid documentation tab: " + JSON.stringify(entry));
  }
  if (entry.hidden !== undefined && !Array.isArray(entry.hidden)) {
    throw new Error("Invalid hidden navigation pages in " + entry.tab);
  }
  const tab: NavigationTab = { tab: entry.tab, groups: [], landing: undefined, linksHtml: "" };
  tab.groups = entry.groups.map((group) => navigationGroup(group, tab));
  tab.landing = tab.groups[0]!.landing;
  for (const hidden of entry.hidden ?? []) {
    navigationPage(hidden, tab, []);
  }
  return tab;
});
for (const page of pages.values()) {
  if (!covered.has(page.source)) {
    throw new Error("Page missing from navigation: " + page.source);
  }
}

// Resolve links against their Markdown source, including README indexes and
// parent-directory links, before emitting browser routes.
function resolveLink(page: PageSource, href: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
    return href;
  }
  const url = new URL(href, "https://local.invalid/" + page.source);
  const pathname = decodeURIComponent(url.pathname);
  let target: string;
  if (href.startsWith("#") || href.startsWith("?") || href === "") {
    target = page.file;
  } else if (href.startsWith("/")) {
    const linked = [...pages.values()].find(
      (candidate) => candidate.route.replace(/\/$/, "") === pathname.replace(/\/$/, ""),
    );
    target = linked?.file ?? path.join(docs, pathname);
  } else {
    const sourcePath = href.split(/[?#]/, 1)[0]!;
    target = path.resolve(path.dirname(page.file), decodeURIComponent(sourcePath));
  }
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(page.source + ": link escapes repository: " + href);
  }
  if (!fs.existsSync(target)) {
    throw new Error(page.source + ": missing link target: " + href);
  }
  if (fs.statSync(target).isDirectory()) {
    const readme = path.join(target, "README.md");
    if (target.startsWith(docs + path.sep) && fs.existsSync(readme)) {
      target = readme;
    } else {
      return (
        repository +
        "/tree/main/" +
        relative.split(path.sep).map(encodeURIComponent).join("/") +
        url.hash
      );
    }
  }
  const docSource = path.relative(docs, target).split(path.sep).join("/");
  if (unpublished.has(docSource)) {
    throw new Error(page.source + ": link targets an unpublished document: " + href);
  }
  const linked = pages.get(docSource);
  if (linked) {
    if (url.hash && !resolveDocsFragment(url.hash, linked.ids)) {
      throw new Error(page.source + ": missing heading in " + href);
    }
    return linked.route + url.search + url.hash;
  }
  if (/^(?:assets|snippets)\//.test(docSource)) {
    return "/" + docSource.split("/").map(encodeURIComponent).join("/") + url.search + url.hash;
  }
  if (url.hash && target.endsWith(".md") && !resolveDocsFragment(url.hash, githubAnchors(target))) {
    throw new Error(page.source + ": missing heading in " + href);
  }
  return (
    repository +
    "/blob/main/" +
    path.relative(root, target).split(path.sep).map(encodeURIComponent).join("/") +
    (target.startsWith(docs + path.sep) ? url.search : "") +
    url.hash
  );
}

let linkCount = 0;
for (const page of pages.values()) {
  // Reuse validated targets while rendering this page from the same build inputs.
  const resolvedLinks = new Map<string, string>();
  for (const href of page.parsed.links) {
    resolvedLinks.set(href, resolveLink(page, href));
    linkCount++;
  }
  const text = renderComputeMatrixBlocks(page.text, { sourceFile: page.file, root: docs });
  page.html = useGithubHeadingIds(
    renderMdxish(text, md, {
      sourceFile: page.file,
      root: docs,
      headingIds: page.headingIds,
    }),
    page.headingIds,
  ).replace(/<(?:a|img|source|span)\b[^>]*>/g, (tag) =>
    tag.replace(
      /\b(href|src|data-href)=(['"])(.*?)\2/g,
      (_match: string, name: string, quote: string, href: string) => {
        const sourceHref = md.utils.unescapeAll(href);
        const resolved = resolvedLinks.get(sourceHref) ?? resolveLink(page, sourceHref);
        return name + "=" + quote + escape(resolved) + quote;
      },
    ),
  );
}
const deploymentExamples = path.join(root, "deploy/examples");
if (fs.existsSync(deploymentExamples)) {
  for (const file of walk(deploymentExamples, (entry) => /\.(?:ya?ml)$/i.test(entry.name))) {
    const source = path.relative(root, file).split(path.sep).join("/");
    for (const block of yamlCommentMarkdownBlocks(file)) {
      const parsed: ParsedMarkdown = parseDocsDocument(block, md, {
        sourceFile: file,
        root: path.dirname(file),
      });
      for (const href of parsed.links) {
        resolveLink({ source, file }, href);
        linkCount++;
      }
    }
  }
}
for (const page of pages.values()) {
  if (page.humanVerified) {
    page.html = page.html.replace(
      /<\/h1>/,
      '$&<details class="human-verification" data-pagefind-ignore>' +
        '<summary><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>' +
        '<span>Human verified</span><span aria-hidden="true">·</span>' +
        '<time datetime="' +
        escape(page.lastVerified) +
        '" aria-label="Last verified: ' +
        escape(page.lastVerified) +
        '">' +
        escape(page.lastVerified) +
        "</time>" +
        '<span class="verification-info" aria-hidden="true">ⓘ</span></summary>' +
        "<p>A human reviewed this page, but it may be out of date. Later edits may not have been reviewed.</p></details>",
    );
  }
}
for (const page of pages.values()) {
  if (page.source === "reference/api-explorer.md") {
    page.html +=
      '<p><a href="/assets/occ-api.openapi.json" download="occ-api.openapi.json">Download OpenAPI JSON</a></p><div id="occ-api-explorer"></div>';
  }
}
if (checkOnly) {
  console.log("Validated " + pages.size + " pages and " + linkCount + " links.");
  process.exit(0);
}

if (values.output === undefined) {
  fs.rmSync(output, { recursive: true, force: true });
} else {
  // Preview builds only create a fresh directory; never delete a caller's path.
  fs.mkdirSync(output);
}
fs.mkdirSync(path.join(output, "assets"), { recursive: true });
if (fs.existsSync(path.join(docs, "assets"))) {
  fs.cpSync(path.join(docs, "assets"), path.join(output, "assets"), { recursive: true });
}
if (fs.existsSync(path.join(docs, "snippets"))) {
  fs.cpSync(path.join(docs, "snippets"), path.join(output, "snippets"), { recursive: true });
}
fs.cpSync(path.join(assets, "fonts"), path.join(output, "assets/fonts"), { recursive: true });
const carapaceCss = [
  "tokens.css",
  "themes.css",
  "typography.css",
  "components.css",
  "themes/product.css",
]
  .map((file) =>
    fs.readFileSync(fileURLToPath(import.meta.resolve("@openclaw/carapace/" + file)), "utf8"),
  )
  .join("\n");
fs.writeFileSync(
  path.join(output, "assets/site.css"),
  carapaceCss + "\n" + fs.readFileSync(path.join(assets, "site.css"), "utf8"),
);
function writeBrowserModule(name: string) {
  const source = fs.readFileSync(path.join(assets, name + ".mts"), "utf8");
  fs.writeFileSync(path.join(output, "assets", name + ".mjs"), stripTypeScriptTypes(source));
}

writeBrowserModule("site");
writeBrowserModule("compute-matrix-browser");
if (pages.has("reference/api-explorer.md")) {
  writeBrowserModule("api-explorer");
  const scalar = path.dirname(fileURLToPath(import.meta.resolve("@scalar/api-reference")));
  fs.copyFileSync(
    path.join(scalar, "browser/standalone.js"),
    path.join(output, "assets/scalar.js"),
  );
  fs.copyFileSync(
    path.join(root, "packages/contracts/openapi/occ-api.openapi.json"),
    path.join(output, "assets/occ-api.openapi.json"),
  );
}
const mermaid = path.dirname(fileURLToPath(import.meta.resolve("mermaid")));
fs.cpSync(mermaid, path.join(output, "assets/mermaid"), {
  recursive: true,
  filter: (source) => !source.endsWith(".map"),
});

function renderSidebarPages(entries: (NavigationGroup | Page)[], page: Page): string {
  return (
    '<ul class="sidebar-pages" role="list">' +
    entries
      .map((entry) => {
        if ("group" in entry) {
          const active = page.navigation!.groups.includes(entry);
          return (
            '<li><details class="sidebar-group"' +
            (active ? " open data-active" : "") +
            "><summary>" +
            escape(entry.group) +
            "</summary>" +
            renderSidebarPages(entry.pages, page) +
            "</details></li>"
          );
        }
        return (
          '<li><a href="' +
          escape(entry.route) +
          '"' +
          (page === entry ? ' aria-current="page"' : "") +
          ">" +
          escape(entry.navigation!.label) +
          "</a></li>"
        );
      })
      .join("") +
    "</ul>"
  );
}

function renderBreadcrumb(page: Page): string {
  const { tab, groups, label } = page.navigation!;
  const ancestors = [
    { label: tab.tab, target: tab.landing },
    ...groups.map((group) => {
      const firstPage = group.pages[0]!;
      return { label: group.group, target: "source" in firstPage ? firstPage : null };
    }),
  ].filter((item, index, items) => index === 0 || item.label !== items[index - 1]!.label);
  if (ancestors.at(-1)?.label === label) {
    ancestors.pop();
  }
  const linkedRoutes = new Set<string>();
  const items = ancestors.map(({ label, target }) => {
    if (!target || target === page || linkedRoutes.has(target.route)) {
      return "<li><span>" + escape(label) + "</span></li>";
    }
    linkedRoutes.add(target.route);
    return '<li><a href="' + escape(target.route) + '">' + escape(label) + "</a></li>";
  });
  items.push('<li><span aria-current="page">' + escape(label) + "</span></li>");
  return (
    '<nav class="breadcrumb" aria-label="Breadcrumb" data-pagefind-ignore><ol role="list">' +
    items.join("") +
    "</ol></nav>"
  );
}

for (const activeTab of tabs) {
  activeTab.linksHtml = tabs
    .map(
      (tab) =>
        "<a" +
        (tab === activeTab ? ' aria-current="location"' : "") +
        ' href="' +
        escape(tab.landing!.route) +
        '">' +
        escape(tab.tab) +
        "</a>",
    )
    .join("");
}
for (const page of pages.values()) {
  const { tab } = page.navigation!;
  const sidebar = tab.groups
    .map(
      (group) =>
        "<section><h2>" +
        escape(group.group) +
        "</h2>" +
        renderSidebarPages(group.pages, page) +
        "</section>",
    )
    .join("");
  const toc = page.parsed.tokens
    .flatMap((token, index, tokens) =>
      token.type === "heading_open" && token.tag === "h2"
        ? [
            '<a href="#' +
              escape(
                page.headingIds.get(token.attrGet("id") as string)?.id ?? token.attrGet("id"),
              ) +
              '">' +
              escape(tokens[index + 1]!.content) +
              "</a>",
          ]
        : [],
    )
    .join("");
  const html =
    '<!doctype html><html lang="en" data-theme="dark" data-oc-theme="product"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    (page.searchable ? "" : '<meta name="robots" content="noindex">') +
    themeBootstrap +
    (page.source === "reference/api-explorer.md"
      ? '<script src="/assets/scalar.js" defer></script><script type="module" src="/assets/api-explorer.mjs"></script>'
      : "") +
    "<title>" +
    escape(page.title) +
    " · OpenClaw Enterprise</title>" +
    '<link rel="icon" href="/assets/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16.png"><link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png"><link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png"><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/pagefind/pagefind-ui.css">' +
    '<script src="/pagefind/pagefind-ui.js" defer></script><script type="module" src="/assets/site.mjs"></script></head><body>' +
    '<a class="skip" href="#content">Skip to content</a><header><div class="header-row"><a class="brand" href="/"><img src="/assets/oce-mascot.png" alt=""><span>OpenClaw Enterprise</span><small>DOCS</small></a>' +
    '<button id="search-open" type="button">Search docs <kbd>⌘ K</kbd></button><a class="github" href="' +
    repository +
    '">GitHub</a><button id="theme" type="button" aria-label="Toggle theme">◐</button></div>' +
    '<nav class="tabs" aria-label="Documentation sections">' +
    tab.linksHtml +
    "</nav></header>" +
    '<div class="layout"><button id="menu" type="button" aria-expanded="false" aria-controls="sidebar">Browse pages</button><nav id="sidebar" aria-label="' +
    escape(tab.tab) +
    ' pages">' +
    sidebar +
    "</nav>" +
    (page.searchable
      ? '<main id="content" class="doc" data-pagefind-body>'
      : '<main id="content" class="doc">') +
    renderBreadcrumb(page) +
    page.html +
    '<footer data-pagefind-ignore><a href="' +
    repository +
    "/blob/main/docs/" +
    page.source +
    '">View Markdown source</a></footer></main>' +
    '<aside class="toc" aria-label="On this page"><strong>On this page</strong>' +
    toc +
    "</aside></div>" +
    '<dialog id="search-dialog" aria-labelledby="search-title"><div class="search-head"><strong id="search-title">Search documentation</strong><button id="search-close" type="button" aria-label="Close search">✕</button></div><div id="search"></div></dialog><dialog id="diagram-dialog" aria-label="Expanded diagram"><button id="diagram-close" type="button">Close diagram</button><div id="diagram-canvas"></div></dialog></body></html>';
  const destination = path.join(output, page.route, "index.html");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, html);
}
fs.writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify(
    [...pages.values()].map(({ source, title, route }) => ({ source, title, route })),
    null,
    2,
  ) + "\n",
);
for (const redirect of redirects) {
  const directory = path.join(output, redirect.from.slice(1));
  fs.mkdirSync(directory, { recursive: true });
  const settings = JSON.stringify(redirect).replaceAll("<", "\\u003c");
  fs.writeFileSync(
    path.join(directory, "index.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Page moved</title><link rel="canonical" href="${escape(redirect.to)}">
<script>
const redirect = ${settings};
const anchor = decodeURIComponent(location.hash.slice(1));
const mapped = Object.hasOwn(redirect.anchors ?? {}, anchor) ? redirect.anchors[anchor] : undefined;
const target = new URL(mapped ?? redirect.to, location.origin);
if (!mapped && !target.hash) target.hash = location.hash;
target.search = location.search;
location.replace(target.href);
</script></head><body><p>This page moved. <a href="${escape(redirect.to)}">Continue to the current guide</a>.</p></body></html>`,
  );
}
console.log(
  "Built " +
    pages.size +
    " pages; validated " +
    linkCount +
    " links → " +
    path.relative(root, output),
);
