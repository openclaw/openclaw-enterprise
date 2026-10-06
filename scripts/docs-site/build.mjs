import fs from "node:fs";
import GithubSlugger from "github-slugger";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMarkdownRenderer, renderMdxish } from "./vendor/mdx-ish.mjs";
import { renderComputeMatrixBlocks } from "./compute-matrix.mjs";
import {
  parseDocsDocument,
  parseFrontmatter,
  resolveDocsFragment,
} from "./vendor/docs-markdown.mjs";
import { createGithubAnchorReader } from "./github-anchors.mjs";
import { publicMarkdown } from "./public-markdown.mjs";

if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("Usage: build.mjs [--check]");
}
const checkOnly = process.argv.includes("--check");
const root = process.cwd();
const docs = path.join(root, "docs");
const output = path.join(root, "dist/docs");
const assets = path.dirname(fileURLToPath(import.meta.url));
const repository = "https://github.com/openclaw/openclaw-enterprise";
const themeBootstrap =
  '<script>try{const theme=localStorage.getItem("enterprise-docs-theme");if(theme==="light"||theme==="dark"){document.documentElement.dataset.theme=theme}}catch{}</script>';
const config = JSON.parse(fs.readFileSync(path.join(docs, "docs.json"), "utf8"));
const md = createMarkdownRenderer();
const githubAnchors = createGithubAnchorReader(md);
const pages = new Map();
const unpublished = new Set();
const escape = (value) => md.utils.escapeHtml(String(value));
const route = (source) =>
  "/" +
  source
    .replace(/(?:^|\/)README\.md$/, "")
    .replace(/\.md$/, "")
    .replace(/\/$/, "") +
  (source === "README.md" ? "" : "/");

function walk(directory, acceptsFile = (entry) => entry.name.endsWith(".md")) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(file, acceptsFile)
      : entry.isFile() && acceptsFile(entry)
        ? [file]
        : [];
  });
}

function yamlCommentMarkdownBlocks(file) {
  const blocks = [];
  let block = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*# ?(.*)$/);
    if (match) {
      block.push(match[1]);
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
  const frontmatter = parseFrontmatter(authored).data;
  if (frontmatter?.published !== undefined && typeof frontmatter.published !== "boolean") {
    throw new Error(source + ": published frontmatter must be true or false");
  }
  if (frontmatter?.published === false) {
    unpublished.add(source);
    continue;
  }
  const text = publicMarkdown(authored, md);
  const parsed = parseDocsDocument(text, md, { sourceFile: file, root: docs });
  const githubAliases = new Map();
  const github = new GithubSlugger();
  const ids = new Set(parsed.ids);
  for (let i = 0; i < parsed.tokens.length; i++) {
    const token = parsed.tokens[i];
    if (token.type !== "heading_open") {
      continue;
    }
    const alias = github.slug(parsed.tokens[i + 1].content);
    if (!ids.has(alias)) {
      githubAliases.set(token.attrGet("id"), alias);
      ids.add(alias);
    }
  }
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
    ids,
    githubAliases,
    parsed,
  });
}
const configuredTabs = config.navigation.languages.find(
  (language) => language.language === "en",
)?.tabs;
if (!configuredTabs?.length) {
  throw new Error("docs/docs.json must declare English navigation tabs");
}
const covered = new Set();

function navigationPage(entry, tab, groups) {
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
  Object.assign(page, {
    tab,
    groups,
    navigationLabel: typeof entry === "string" ? page.title : (entry.label ?? page.title),
  });
  return page;
}

function navigationGroup(entry, tab, ancestors = []) {
  if (
    typeof entry?.group !== "string" ||
    !entry.group.trim() ||
    "page" in entry ||
    !Array.isArray(entry.pages) ||
    !entry.pages.length
  ) {
    throw new Error("Invalid navigation group in " + tab.tab + ": " + JSON.stringify(entry));
  }
  const group = { group: entry.group };
  const groups = [...ancestors, group];
  group.pages = entry.pages.map((child) =>
    child && typeof child === "object" && "group" in child
      ? navigationGroup(child, tab, groups)
      : navigationPage(child, tab, groups),
  );
  group.landing = group.pages[0].landing ?? group.pages[0];
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
  const tab = { tab: entry.tab };
  tab.groups = entry.groups.map((group) => navigationGroup(group, tab));
  tab.landing = tab.groups[0].landing;
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
function resolveLink(page, href) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
    return href;
  }
  const url = new URL(href, "https://local.invalid/" + page.source);
  const pathname = decodeURIComponent(url.pathname);
  let target;
  if (href.startsWith("#") || href.startsWith("?") || href === "") {
    target = page.file;
  } else if (href.startsWith("/")) {
    const linked = [...pages.values()].find(
      (candidate) => candidate.route.replace(/\/$/, "") === pathname.replace(/\/$/, ""),
    );
    target = linked?.file ?? path.join(docs, pathname);
  } else {
    const sourcePath = href.split(/[?#]/, 1)[0];
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
  if (target.startsWith(docs + path.sep)) {
    return "/" + docSource.split("/").map(encodeURIComponent).join("/") + url.search + url.hash;
  }
  if (url.hash && target.endsWith(".md") && !resolveDocsFragment(url.hash, githubAnchors(target))) {
    throw new Error(page.source + ": missing heading in " + href);
  }
  return (
    repository +
    "/blob/main/" +
    path.relative(root, target).split(path.sep).map(encodeURIComponent).join("/") +
    url.hash
  );
}

let linkCount = 0;
for (const page of pages.values()) {
  // Reuse validated targets while rendering this page from the same build inputs.
  const resolvedLinks = new Map();
  for (const href of page.parsed.links) {
    resolvedLinks.set(href, resolveLink(page, href));
    linkCount++;
  }
  const text = renderComputeMatrixBlocks(page.text, { sourceFile: page.file, root: docs });
  page.html = renderMdxish(text, md, { sourceFile: page.file, root: docs }).replace(
    /<(?:a|img|source|span)\b[^>]*>/g,
    (tag) =>
      tag.replace(/\b(href|src|data-href)=(['"])(.*?)\2/g, (_, name, quote, href) => {
        const sourceHref = md.utils.unescapeAll(href);
        const resolved = resolvedLinks.get(sourceHref) ?? resolveLink(page, sourceHref);
        return name + "=" + quote + escape(resolved) + quote;
      }),
  );
}
const deploymentExamples = path.join(root, "deploy/examples");
if (fs.existsSync(deploymentExamples)) {
  for (const file of walk(deploymentExamples, (entry) => /\.(?:ya?ml)$/i.test(entry.name))) {
    const source = path.relative(root, file).split(path.sep).join("/");
    for (const block of yamlCommentMarkdownBlocks(file)) {
      const commentLinks = parseDocsDocument(block, md, {
        sourceFile: file,
        root: path.dirname(file),
      }).links;
      for (const href of commentLinks) {
        resolveLink({ source, file }, href);
        linkCount++;
      }
    }
  }
}
for (const page of pages.values()) {
  page.html = page.html.replace(/<h[1-6]\b[^>]*>/g, (tag) => {
    const id = tag.match(/\bid="([^"]*)"/)?.[1];
    const alias = page.githubAliases.get(md.utils.unescapeAll(id ?? ""));
    return tag + (alias ? '<span class="anchor-alias" id="' + escape(alias) + '"></span>' : "");
  });
}
if (checkOnly) {
  console.log("Validated " + pages.size + " pages and " + linkCount + " links.");
  process.exit(0);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "assets"), { recursive: true });
if (fs.existsSync(path.join(docs, "assets"))) {
  fs.cpSync(path.join(docs, "assets"), path.join(output, "assets"), { recursive: true });
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
fs.copyFileSync(path.join(assets, "site.mjs"), path.join(output, "assets/site.mjs"));
fs.copyFileSync(
  path.join(assets, "compute-matrix-browser.mjs"),
  path.join(output, "assets/compute-matrix-browser.mjs"),
);
const mermaid = path.dirname(fileURLToPath(import.meta.resolve("mermaid")));
fs.cpSync(mermaid, path.join(output, "assets/mermaid"), {
  recursive: true,
  filter: (source) => !source.endsWith(".map"),
});

function renderSidebarPages(entries, page) {
  return (
    '<ul class="sidebar-pages" role="list">' +
    entries
      .map((entry) => {
        if ("group" in entry) {
          const active = page.groups.includes(entry);
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
          escape(entry.navigationLabel) +
          "</a></li>"
        );
      })
      .join("") +
    "</ul>"
  );
}

function renderBreadcrumb(page) {
  const ancestors = [
    { label: page.tab.tab, target: page.tab.landing },
    ...page.groups.map((group) => ({
      label: group.group,
      target: "source" in group.pages[0] ? group.pages[0] : null,
    })),
  ].filter((item, index, items) => index === 0 || item.label !== items[index - 1].label);
  if (ancestors.at(-1)?.label === page.navigationLabel) {
    ancestors.pop();
  }
  const linkedRoutes = new Set();
  const items = ancestors.map(({ label, target }) => {
    if (!target || target === page || linkedRoutes.has(target.route)) {
      return "<li><span>" + escape(label) + "</span></li>";
    }
    linkedRoutes.add(target.route);
    return '<li><a href="' + escape(target.route) + '">' + escape(label) + "</a></li>";
  });
  items.push('<li><span aria-current="page">' + escape(page.navigationLabel) + "</span></li>");
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
        escape(tab.landing.route) +
        '">' +
        escape(tab.tab) +
        "</a>",
    )
    .join("");
}
for (const page of pages.values()) {
  const sidebar = page.tab.groups
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
              escape(token.attrGet("id")) +
              '">' +
              escape(tokens[index + 1].content) +
              "</a>",
          ]
        : [],
    )
    .join("");
  const html =
    '<!doctype html><html lang="en" data-theme="dark" data-oc-theme="product"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    themeBootstrap +
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
    page.tab.linksHtml +
    "</nav></header>" +
    '<div class="layout"><button id="menu" type="button" aria-expanded="false" aria-controls="sidebar">Browse pages</button><nav id="sidebar" aria-label="' +
    escape(page.tab.tab) +
    ' pages">' +
    sidebar +
    "</nav>" +
    '<main id="content" class="doc" data-pagefind-body>' +
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
console.log("Built " + pages.size + " pages; validated " + linkCount + " links → dist/docs");
