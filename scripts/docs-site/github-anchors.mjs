import fs from "node:fs";
import GithubSlugger from "github-slugger";
import { parseFrontmatter } from "./vendor/docs-markdown.mjs";

/** Visible heading text as GitHub slugger sees it, not raw Markdown inline source. */
export function githubHeadingVisibleText(inlineToken) {
  if (inlineToken === undefined || inlineToken === null) {
    return "";
  }
  if (inlineToken.type === "image") {
    return "";
  }
  if (inlineToken.type === "text" || inlineToken.type === "code_inline") {
    return inlineToken.content;
  }
  if (Array.isArray(inlineToken.children)) {
    return inlineToken.children.map((child) => githubHeadingVisibleText(child)).join("");
  }
  return "";
}

// Fragment targets of a Markdown file as GitHub renders it: github-slugger heading
// slugs (duplicates get -1, -2, ...) plus explicit HTML id/name anchors.
export function createGithubAnchorReader(md) {
  const documents = new Map();
  return function githubAnchors(file) {
    // Keep reads and frontmatter diagnostics; only reuse anchors for unchanged text.
    const text = parseFrontmatter(fs.readFileSync(file, "utf8")).content;
    if (documents.has(text)) {
      return documents.get(text);
    }
    const tokens = md.parse(text, {});
    const slugger = new GithubSlugger();
    const ids = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === "heading_open") {
        ids.add(slugger.slug(githubHeadingVisibleText(tokens[i + 1])));
      }
    }
    for (const match of text.matchAll(/<[a-z][^>]*?\s(?:id|name)=(["'])([^"']+)\1/gi)) {
      ids.add(match[2]);
    }
    documents.set(text, ids);
    return ids;
  };
}
