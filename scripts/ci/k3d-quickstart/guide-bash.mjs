// Print one runnable Bash example from the checked-out quickstart. A moved or
// duplicated marker must fail the lane rather than silently testing another step.
import { readFileSync } from "node:fs";

const [guide, marker] = process.argv.slice(2);
if (!guide || !marker) {
  throw new Error("Expected a guide path and a unique command marker.");
}
const markdown = readFileSync(guide, "utf8").replaceAll("\r\n", "\n");
const fences = [...markdown.matchAll(/^([ \t]*)```bash[ \t]*\n([\s\S]*?)^\1```[ \t]*$/gm)];
const matches = fences.filter(([, , body]) => body.includes(marker));
if (matches.length !== 1) {
  throw new Error(
    `Expected one Bash example containing ${JSON.stringify(marker)} in ${guide}; found ${matches.length}.`,
  );
}
// Markdown list examples indent the fences and their contents. Remove that
// enclosing indent so shell heredoc terminators remain at column one.
const [, indent, body] = matches[0];
process.stdout.write(
  body
    .split("\n")
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n"),
);
