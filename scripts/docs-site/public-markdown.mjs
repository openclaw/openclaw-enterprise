import { parseFrontmatter } from "./vendor/docs-markdown.mjs";

export function publicMarkdown(markdown, md) {
  const { content } = parseFrontmatter(markdown);
  const frontmatter = markdown.slice(0, markdown.length - content.length);
  const lines = content.split("\n");
  const tokens = md.parse(content, {});
  const headings = [];
  const placeholders = [];
  const placeholder =
    /^\[keep\s+this\s+for\s+the\s+user\s+to\s+add\s+notes\.\s+do\s+not\s+change\s+between\s+edits\]$/i;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const inline = tokens[index + 1];
    if (token.type === "heading_open") {
      const title = inline.children
        .map((child) => (child.type === "softbreak" ? " " : child.content))
        .join("")
        .trim();
      headings.push({
        title,
        depth: Number(token.tag.slice(1)),
        start: token.map[0],
        end: token.map[1],
      });
    } else if (token.type === "paragraph_open" && placeholder.test(inline.content.trim())) {
      placeholders.push(token.map);
    }
  }

  const hidden = Array(lines.length).fill(false);
  const sections = headings.flatMap((heading, index) =>
    heading.depth > 1 && /^(?:change\s*log|manual\s+notes)$/i.test(heading.title)
      ? [
          {
            ...heading,
            stop:
              headings.slice(index + 1).find((next) => next.depth <= heading.depth)?.start ??
              lines.length,
          },
        ]
      : [],
  );
  for (const section of sections) {
    if (/^change\s*log$/i.test(section.title)) {
      hidden.fill(true, section.start, section.stop);
    }
  }
  for (const section of sections.toReversed()) {
    if (hidden[section.start]) {
      continue;
    }
    for (const [start, end] of placeholders) {
      if (start >= section.end && end <= section.stop) {
        hidden.fill(true, start, end);
      }
    }
    // Treat comments as whitespace when deciding whether to retain this section.
    const notes = lines
      .slice(section.end, section.stop)
      .filter((_, index) => !hidden[section.end + index])
      .join("\n")
      .replace(/<!--[^]*?-->|\{\/\*[^]*?\*\/\}/g, " ")
      .trim();
    if (!notes) {
      hidden.fill(true, section.start, section.stop);
    }
  }

  let published = lines.filter((_, index) => !hidden[index]).join("\n");
  if (content.endsWith("\n") && !published.endsWith("\n")) {
    published += "\n";
  }
  return frontmatter + published;
}
