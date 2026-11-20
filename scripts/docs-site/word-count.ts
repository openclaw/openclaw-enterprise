import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "htmlparser2";
import { parseDocsDocument } from "./vendor/docs-markdown.mjs";
import {
  array,
  createDocsParser,
  docsParser,
  frontmatter,
  isRecord,
  record,
  string,
} from "./parser-boundary.ts";

export const DEFAULT_REVIEW_WORDS = 1500;
export const DEFAULT_MAX_WORDS = 2500;

const __filename = fileURLToPath(import.meta.url);
const markdownWord = /[\p{L}\p{N}]/u;

function countWords(text: string) {
  return String(text)
    .split(/\s+/u)
    .filter((word) => markdownWord.test(word)).length;
}

function htmlText(html: string) {
  const parts: string[] = [];
  const separate = () => parts.push(" ");
  const parser = new Parser(
    {
      ontext: (text) => parts.push(text),
      onopentagname: separate,
      onclosetag: separate,
    },
    { decodeEntities: false },
  );
  parser.end(html);
  return parts.join("");
}

function inlineText(token: Record<string, unknown>): string {
  const children = token.children == null ? [] : array(token.children);
  const parts: string[] = [];
  let previousText = false;
  let interrupted = false;
  for (const value of children) {
    const child = record(value);
    const type = child.type;
    if (type === "html_inline" && string(child.content).startsWith("<!--")) {
      interrupted = previousText;
      continue;
    }
    if (type === "text" || type === "image" || type === "code_inline" || type === "html_inline") {
      const content = string(child.content);
      // A comment may interrupt a word. Join its text only after Markdown parsing.
      if (!interrupted || type !== "text") {
        parts.push(" ");
      }
      if (type === "html_inline") {
        parts.push(htmlText(content));
      } else if (type === "image" && content.includes("<!--") && child.children != null) {
        parts.push(inlineText(child));
      } else {
        parts.push(content);
      }
    }
    previousText = type === "text";
    interrupted = false;
  }
  return parts.join("");
}

function gitMarkdownFiles(root: string) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

type FileOptions = { root?: string | undefined; files?: string[] | undefined };
type MarkdownFile = { path: string; absolutePath: string; realPath: string; aliases: string[] };
type Section = {
  heading: string;
  level?: string;
  line: number;
  proseWords: number;
  codeWords: number;
};

export function collectMarkdownFiles({ root = process.cwd(), files }: FileOptions = {}) {
  const absoluteRoot = fs.realpathSync.native(path.resolve(root));
  const seenPaths = new Set();
  const byRealPath = new Map<string, MarkdownFile>();
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

type MarkdownWordCountOptions = { sourceFile?: string; root?: string };

export function countMarkdownWords(
  markdown: string,
  options: MarkdownWordCountOptions & { markdown?: unknown } = {},
) {
  const md = docsParser(options.markdown);
  return countContentWords(frontmatter(markdown).content, md, options);
}

function countContentWords(
  body: string,
  md: ReturnType<typeof createDocsParser>,
  options: MarkdownWordCountOptions,
) {
  const parsed: unknown = parseDocsDocument(body, md, options);
  const tokens = array(record(parsed).tokens);
  const sections = [];
  let proseWords = 0;
  let codeWords = 0;
  let current: Section = { heading: "Introduction", line: 1, proseWords: 0, codeWords: 0 };

  const addProse = (text: string) => {
    const words = countWords(text);
    proseWords += words;
    current.proseWords += words;
  };
  const addCode = (text: string) => {
    const words = countWords(text);
    codeWords += words;
    current.codeWords += words;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = record(tokens[index]);
    const type = token.type;
    if (type === "heading_open") {
      const tag = string(token.tag);
      if (["h1", "h2", "h3"].includes(tag)) {
        const next = tokens[index + 1];
        const heading = string(next == null ? tag : (record(next).content ?? tag));
        const map = token.map == null ? undefined : array(token.map);
        const line = map?.[0] ?? 0;
        if (typeof line !== "number") {
          throw new TypeError("Unsupported docs parser contract: expected line number");
        }
        sections.push(current);
        current = {
          heading: heading.includes("<!--") ? inlineText(record(next)).trim() : heading,
          level: tag,
          line: line + 1,
          proseWords: 0,
          codeWords: 0,
        };
        continue;
      }
    }
    if (type === "inline") {
      addProse(inlineText(token));
    } else if (type === "fence" || type === "code_block") {
      addCode(string(token.content));
    } else if (type === "html_block") {
      addProse(htmlText(string(token.content)));
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
}: FileOptions & { maxWords?: number; reviewWords?: number } = {}) {
  const md = createDocsParser();
  const markdownFiles = collectMarkdownFiles({ root, files });
  const absoluteRoot = fs.realpathSync.native(path.resolve(root));
  const rows = markdownFiles.map((file) => {
    const markdown = fs.readFileSync(file.absolutePath, "utf8");
    const { data, content } = frontmatter(markdown);
    const tags = isRecord(data) ? data.tags : undefined;
    if (
      tags !== undefined &&
      (!Array.isArray(tags) || tags.some((tag: unknown) => typeof tag !== "string" || !tag.trim()))
    ) {
      throw new Error(`${file.path}: tags frontmatter must be a list of nonempty strings`);
    }
    const counts = countContentWords(content, md, {
      sourceFile: file.absolutePath,
      root: file.path.startsWith("docs/")
        ? path.join(absoluteRoot, "docs")
        : path.dirname(file.absolutePath),
    });
    // Exceptions belong to the resolved file, not aliases pointing elsewhere.
    let lengthException;
    if (tags?.includes("nolimit")) {
      lengthException = "nolimit tag";
    } else if (path.basename(file.realPath) === "AGENTS.md") {
      lengthException = "Agent instruction document";
    }
    const reportPath = lengthException
      ? path.relative(absoluteRoot, file.realPath).split(path.sep).join("/")
      : file.path;
    return {
      ...file,
      ...counts,
      path: reportPath,
      aliases: lengthException
        ? [file.path, ...file.aliases].filter((alias) => alias !== reportPath)
        : file.aliases,
      lineCount: markdown.split("\n").length,
      lengthException,
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

export function formatWordCountReport(result: ReturnType<typeof checkMarkdownWordCounts>) {
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

function parseCliArgs(argv: string[]) {
  const options: {
    root: string | undefined;
    maxWords: number;
    reviewWords: number;
    json: boolean;
  } = {
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
      throw new Error("Usage: word-count.ts [--root <path>] [--max <words>] [--json]");
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

export function runWordCountMain() {
  try {
    process.exitCode = runWordCountCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] === __filename) {
  runWordCountMain();
}
