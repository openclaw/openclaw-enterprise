import fs from "node:fs";
import GithubSlugger from "github-slugger";
import { parseFrontmatter } from "./vendor/docs-markdown.mjs";

// Fragment targets of a Markdown file as GitHub renders it: github-slugger heading
// slugs (duplicates get -1, -2, ...) plus explicit HTML id/name anchors.
export function githubAnchors(file, md) {
  const text = parseFrontmatter(fs.readFileSync(file, "utf8")).content;
  const tokens = md.parse(text, {});
  const slugger = new GithubSlugger();
  const ids = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === "heading_open") {
      const heading = (tokens[i + 1].children ?? [])
        .filter((child) => child.type === "text" || child.type === "code_inline")
        .map((child) => child.content)
        .join("");
      ids.add(slugger.slug(heading));
    }
  }
  for (const match of text.matchAll(/<[a-z][^>]*?\s(?:id|name)=(["'])([^"']+)\1/gi)) {
    ids.add(match[2]);
  }
  return ids;
}
