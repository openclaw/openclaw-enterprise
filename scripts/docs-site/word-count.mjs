import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDocsMarkdown,
  parseDocsDocument,
  parseFrontmatter,
} from "./vendor/docs-markdown.mjs";

export const DEFAULT_REVIEW_WORDS = 1500;
export const DEFAULT_MAX_WORDS = 2500;

const __filename = fileURLToPath(import.meta.url);
const markdownWord = /[\p{L}\p{N}]/u;

function countWords(text) {
  return String(text)
    .split(/\s+/u)
    .filter((word) => markdownWord.test(word)).length;
}

function stripHtml(value) {
  return String(value)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ");
}

function gitMarkdownFiles(root) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

export function collectMarkdownFiles({ root = process.cwd(), files } = {}) {
  const absoluteRoot = fs.realpathSync.native(path.resolve(root));
  const seenPaths = new Set();
  const byRealPath = new Map();
  for (const file of files ?? gitMarkdownFiles(absoluteRoot)) {
    const relativePath = file.split(path.sep).join("/");
    if (seenPaths.has(relativePath)) {
      continue;
    }
    seenPaths.add(relativePath);
    const absolutePath = path.resolve(absoluteRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    const realPath = fs.realpathSync.native(absolutePath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      continue;
    }
    const existing = byRealPath.get(realPath);
    if (existing) {
      existing.aliases.push(relativePath);
      continue;
    }
    byRealPath.set(realPath, {
      path: relativePath,
      absolutePath,
      realPath,
      aliases: [],
    });
  }
  return [...byRealPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function countMarkdownWords(markdown, options = {}) {
  const md = options.markdown ?? createDocsMarkdown();
  const content = parseFrontmatter(markdown).content.replace(/<!--[\s\S]*?-->/g, "");
  const parsed = parseDocsDocument(content, md, options);
  const sections = [];
  let proseWords = 0;
  let codeWords = 0;
  let current = { heading: "Introduction", line: 1, proseWords: 0, codeWords: 0 };

  const addProse = (text) => {
    const words = countWords(text);
    proseWords += words;
    current.proseWords += words;
  };
  const addCode = (text) => {
    const words = countWords(text);
    codeWords += words;
    current.codeWords += words;
  };

  for (let index = 0; index < parsed.tokens.length; index++) {
    const token = parsed.tokens[index];
    if (token.type === "heading_open" && ["h1", "h2", "h3"].includes(token.tag)) {
      sections.push(current);
      current = {
        heading: parsed.tokens[index + 1]?.content ?? token.tag,
        level: token.tag,
        line: (token.map?.[0] ?? 0) + 1,
        proseWords: 0,
        codeWords: 0,
      };
      continue;
    }
    if (token.type === "inline") {
      addProse(
        (token.children ?? [])
          .filter((child) => ["text", "code_inline", "html_inline", "image"].includes(child.type))
          .map((child) => (child.type === "html_inline" ? stripHtml(child.content) : child.content))
          .join(" "),
      );
    } else if (token.type === "fence" || token.type === "code_block") {
      addCode(token.content);
    } else if (token.type === "html_block") {
      addProse(stripHtml(token.content));
    }
  }
  sections.push(current);
  return {
    proseWords,
    codeWords,
    totalWords: proseWords + codeWords,
    sections,
  };
}

export function checkMarkdownWordCounts({
  root = process.cwd(),
  maxWords = DEFAULT_MAX_WORDS,
  reviewWords = DEFAULT_REVIEW_WORDS,
  files,
} = {}) {
  const md = createDocsMarkdown();
  const markdownFiles = collectMarkdownFiles({ root, files });
  // The approved exception belongs to this file, not aliases pointing elsewhere.
  const apiReference = path.join(
    fs.realpathSync.native(path.resolve(root)),
    "docs/reference/api.md",
  );
  const rows = markdownFiles.map((file) => {
    const markdown = fs.readFileSync(file.absolutePath, "utf8");
    const counts = countMarkdownWords(markdown, {
      markdown: md,
      sourceFile: file.absolutePath,
      root: path.dirname(file.absolutePath),
    });
    const isApiReference = file.realPath === apiReference;
    return {
      ...file,
      ...counts,
      path: isApiReference ? "docs/reference/api.md" : file.path,
      aliases: isApiReference
        ? [file.path, ...file.aliases].filter((alias) => alias !== "docs/reference/api.md")
        : file.aliases,
      lineCount: markdown.split("\n").length,
      lengthException: isApiReference ? "User-approved single-page API reference" : undefined,
    };
  });
  const exceptions = rows.filter((row) => row.lengthException);
  const violations = rows.filter((row) => !row.lengthException && row.totalWords > maxWords);
  const reviewPages = rows.filter(
    (row) => !row.lengthException && row.totalWords > reviewWords && row.totalWords <= maxWords,
  );
  return {
    maxWords,
    reviewWords,
    fileCount: rows.length,
    rows,
    reviewPages,
    exceptions,
    violations,
    ok: violations.length === 0,
  };
}

export function formatWordCountReport(result) {
  const lines = [
    `Checked ${result.fileCount} Markdown files; hard limit ${result.maxWords} words; review threshold ${result.reviewWords} words.`,
  ];
  for (const row of result.exceptions) {
    lines.push(
      `- ${row.path}: ${row.totalWords} words (approved length exception: ${row.lengthException}).`,
    );
  }
  if (result.reviewPages.length) {
    lines.push(
      `${result.reviewPages.length} Markdown file${
        result.reviewPages.length === 1 ? "" : "s"
      } ${result.reviewPages.length === 1 ? "exceeds" : "exceed"} the ${
        result.reviewWords
      }-word review threshold:`,
    );
    for (const row of result.reviewPages) {
      const aliases = row.aliases.length ? ` (aliases: ${row.aliases.join(", ")})` : "";
      lines.push(`- ${row.path}${aliases}: ${row.totalWords} words`);
    }
  } else {
    lines.push("No Markdown files are in the review-only range.");
  }

  if (!result.violations.length) {
    lines.push(
      result.exceptions.length
        ? `No Markdown files without an approved exception exceed the ${result.maxWords}-word hard limit.`
        : `No Markdown files exceed the ${result.maxWords}-word hard limit.`,
    );
    return lines.join("\n");
  }

  lines.push(
    `${result.violations.length} Markdown file${
      result.violations.length === 1 ? "" : "s"
    } ${result.violations.length === 1 ? "exceeds" : "exceed"} the ${
      result.maxWords
    }-word hard limit:`,
  );
  for (const row of result.violations) {
    const aliases = row.aliases.length ? ` (aliases: ${row.aliases.join(", ")})` : "";
    lines.push(`- ${row.path}${aliases}: ${row.totalWords} words`);
    for (const section of row.sections
      .filter((section) => section.proseWords + section.codeWords > 0)
      .sort(
        (left, right) => right.proseWords + right.codeWords - (left.proseWords + left.codeWords),
      )
      .slice(0, 3)) {
      lines.push(
        `  - ${section.heading} (line ${section.line}): ${
          section.proseWords + section.codeWords
        } words`,
      );
    }
  }
  return lines.join("\n");
}

function parseCliArgs(argv) {
  const options = {
    root: process.cwd(),
    maxWords: DEFAULT_MAX_WORDS,
    reviewWords: DEFAULT_REVIEW_WORDS,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--root") {
      options.root = argv[++index];
    } else if (arg === "--max") {
      options.maxWords = Number(argv[++index]);
    } else {
      throw new Error("Usage: word-count.mjs [--root <path>] [--max <words>] [--json]");
    }
  }
  if (!Number.isInteger(options.maxWords) || options.maxWords < 1) {
    throw new Error("--max must be a positive integer");
  }
  return options;
}

export function runWordCountCli(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const result = checkMarkdownWordCounts(options);
  const output = options.json
    ? JSON.stringify(
        {
          maxWords: result.maxWords,
          reviewWords: result.reviewWords,
          fileCount: result.fileCount,
          ok: result.ok,
          rows: result.rows.map((row) => ({
            path: row.path,
            aliases: row.aliases,
            proseWords: row.proseWords,
            codeWords: row.codeWords,
            totalWords: row.totalWords,
            lineCount: row.lineCount,
            lengthException: row.lengthException,
            sections: row.sections,
          })),
          reviewPages: result.reviewPages.map((row) => row.path),
          exceptions: result.exceptions.map((row) => row.path),
          violations: result.violations.map((row) => row.path),
        },
        null,
        2,
      )
    : formatWordCountReport(result);
  (result.ok ? console.log : console.error)(output);
  return result.ok ? 0 : 1;
}

if (process.argv[1] === __filename) {
  try {
    process.exitCode = runWordCountCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
