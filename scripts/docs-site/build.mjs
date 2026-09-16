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

if (process.argv.slice(2).some((arg) => arg !== "--check"))
  throw new Error("Usage: build.mjs [--check]");
const checkOnly = process.argv.includes("--check");
const root = process.cwd();
const docs = path.join(root, "docs");
const output = path.join(root, "dist/docs");
const assets = path.dirname(fileURLToPath(import.meta.url));
const repository = "https://github.com/openclaw/openclaw-enterprise";
const config = JSON.parse(fs.readFileSync(path.join(docs, "docs.json"), "utf8"));
const md = createMarkdownRenderer();
const pages = new Map();
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
  if (block.length) blocks.push(block.join("\n"));
  return blocks;
}

for (const file of walk(docs)) {
  const source = path.relative(docs, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseDocsDocument(text, md, { sourceFile: file, root: docs });
  const githubAliases = new Map();
  const github = new GithubSlugger();
  const ids = new Set(parsed.ids);
  for (let i = 0; i < parsed.tokens.length; i++) {
    const token = parsed.tokens[i];
    if (token.type !== "heading_open") continue;
    const alias = github.slug(parsed.tokens[i + 1].content);
    if (!ids.has(alias)) {
      githubAliases.set(token.attrGet("id"), alias);
      ids.add(alias);
    }
  }
  const firstHeading = parsed.tokens.findIndex(
    (token) => token.type === "heading_open" && token.tag === "h1",
  );
  const frontmatter = parseFrontmatter(text).data;
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
const tabs = config.navigation.languages.find((language) => language.language === "en")?.tabs;
if (!tabs?.length) throw new Error("docs/docs.json must declare English navigation tabs");
const covered = new Set();
for (const tab of tabs)
  for (const group of tab.groups)
    for (const slug of group.pages) {
      const source = slug + ".md";
      if (!pages.has(source)) throw new Error("Missing navigation page: " + source);
      if (covered.has(source)) throw new Error("Duplicate navigation page: " + source);
      covered.add(source);
      Object.assign(pages.get(source), { tab, group });
    }
for (const page of pages.values()) {
  if (!covered.has(page.source)) throw new Error("Page missing from navigation: " + page.source);
}

// Resolve links against their Markdown source, including README indexes and
// parent-directory links, before emitting browser routes.
function resolveLink(page, href) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return href;
  const url = new URL(href, "https://local.invalid/" + page.source);
  const pathname = decodeURIComponent(url.pathname);
  let target;
  if (href.startsWith("#") || href.startsWith("?") || href === "") target = page.file;
  else if (href.startsWith("/")) {
    const linked = [...pages.values()].find(
      (candidate) => candidate.route.replace(/\/$/, "") === pathname.replace(/\/$/, ""),
    );
    target = linked?.file ?? path.join(docs, pathname);
  } else {
    const sourcePath = href.split(/[?#]/, 1)[0];
    target = path.resolve(path.dirname(page.file), decodeURIComponent(sourcePath));
  }
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(page.source + ": link escapes repository: " + href);
  if (!fs.existsSync(target)) throw new Error(page.source + ": missing link target: " + href);
  if (fs.statSync(target).isDirectory()) {
    const readme = path.join(target, "README.md");
    if (target.startsWith(docs + path.sep) && fs.existsSync(readme)) target = readme;
    else
      return (
        repository +
        "/tree/main/" +
        relative.split(path.sep).map(encodeURIComponent).join("/") +
        url.hash
      );
  }
  const docSource = path.relative(docs, target).split(path.sep).join("/");
  const linked = pages.get(docSource);
  if (linked) {
    if (url.hash && !resolveDocsFragment(url.hash, linked.ids))
      throw new Error(page.source + ": missing heading in " + href);
    return linked.route + url.search + url.hash;
  }
  if (target.startsWith(docs + path.sep))
    return "/" + docSource.split("/").map(encodeURIComponent).join("/") + url.search + url.hash;
  return (
    repository +
    "/blob/main/" +
    path.relative(root, target).split(path.sep).map(encodeURIComponent).join("/") +
    url.hash
  );
}

let linkCount = 0;
for (const page of pages.values()) {
  for (const href of page.parsed.links) {
    resolveLink(page, href);
    linkCount++;
  }
  const text = renderComputeMatrixBlocks(page.text, { sourceFile: page.file, root: docs });
  page.html = renderMdxish(text, md, { sourceFile: page.file, root: docs }).replace(
    /<(?:a|img|source|span)\b[^>]*>/g,
    (tag) =>
      tag.replace(
        /\b(href|src|data-href)=(['"])(.*?)\2/g,
        (_, name, quote, href) =>
          name + "=" + quote + escape(resolveLink(page, md.utils.unescapeAll(href))) + quote,
      ),
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
if (fs.existsSync(path.join(docs, "assets")))
  fs.cpSync(path.join(docs, "assets"), path.join(output, "assets"), { recursive: true });
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

for (const page of pages.values()) {
  const tabLinks = tabs
    .map(
      (tab) =>
        "<a" +
        (tab === page.tab ? ' aria-current="page"' : "") +
        ' href="' +
        pages.get(tab.groups[0].pages[0] + ".md").route +
        '">' +
        escape(tab.tab) +
        "</a>",
    )
    .join("");
  const sidebar = page.tab.groups
    .map(
      (group) =>
        "<section><h2>" +
        escape(group.group) +
        "</h2>" +
        group.pages
          .map((slug) => {
            const target = pages.get(slug + ".md");
            return (
              '<a href="' +
              target.route +
              '"' +
              (page === target ? ' aria-current="page"' : "") +
              ">" +
              escape(target.title) +
              "</a>"
            );
          })
          .join("") +
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
    "<title>" +
    escape(page.title) +
    " · OpenClaw Enterprise</title>" +
    '<link rel="icon" href="/assets/lobster-mech-transparent.png"><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/pagefind/pagefind-ui.css">' +
    '<script src="/pagefind/pagefind-ui.js" defer></script><script type="module" src="/assets/site.mjs"></script></head><body>' +
    '<a class="skip" href="#content">Skip to content</a><header><div class="header-row"><a class="brand" href="/"><img src="/assets/lobster-mech-transparent.png" alt=""><span>OpenClaw Enterprise</span><small>DOCS</small></a>' +
    '<button id="search-open" type="button">Search docs <kbd>⌘ K</kbd></button><a class="github" href="' +
    repository +
    '">GitHub</a><button id="theme" type="button" aria-label="Toggle theme">◐</button></div>' +
    '<nav class="tabs" aria-label="Documentation sections">' +
    tabLinks +
    "</nav></header>" +
    '<div class="layout"><button id="menu" type="button" aria-expanded="false" aria-controls="sidebar">Browse pages</button><nav id="sidebar" aria-label="' +
    escape(page.tab.tab) +
    ' pages">' +
    sidebar +
    "</nav>" +
    '<main id="content" class="doc" data-pagefind-body><div class="breadcrumb" data-pagefind-ignore>' +
    escape(page.tab.tab) +
    " / " +
    escape(page.group.group) +
    "</div>" +
    page.html +
    '<footer data-pagefind-ignore><a href="' +
    repository +
    "/blob/main/docs/" +
    page.source +
    '">View Markdown source</a></footer></main>' +
    '<aside class="toc" aria-label="On this page"><strong>On this page</strong>' +
    toc +
    "</aside></div>" +
    '<dialog id="search-dialog"><div class="search-head"><strong>Search documentation</strong><button id="search-close" type="button" aria-label="Close search">✕</button></div><div id="search"></div></dialog><dialog id="diagram-dialog" aria-label="Expanded diagram"><button id="diagram-close" type="button">Close diagram</button><div id="diagram-canvas"></div></dialog></body></html>';
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
