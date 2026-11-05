import fs from "node:fs";
import GithubSlugger from "github-slugger";
import { Parser } from "htmlparser2";
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
    // Only HTML tokens can create anchors. Code examples are text, and the HTML
    // parser ignores comments instead of mistaking their contents for elements.
    const collectHtmlAnchors = (tokens) => {
      for (const token of tokens) {
        if (token.type === "html_block" || token.type === "html_inline") {
          const parser = new Parser({
            onopentag(name, attributes) {
              // Only anchor elements give name attributes fragment-navigation meaning.
              for (const attribute of name === "a" ? ["id", "name"] : ["id"]) {
                if (attributes[attribute]) {
                  ids.add(attributes[attribute]);
                }
              }
            },
          });
          parser.end(token.content);
        }
        if (Array.isArray(token.children)) {
          collectHtmlAnchors(token.children);
        }
      }
    };
    collectHtmlAnchors(tokens);
    documents.set(text, ids);
    return ids;
  };
}
