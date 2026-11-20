import MarkdownIt from "markdown-it";
import { createDocsMarkdown, parseFrontmatter } from "./vendor/docs-markdown.mjs";

export function createDocsParser() {
  const parser: unknown = createDocsMarkdown();
  if (!(parser instanceof MarkdownIt) || typeof parser.parse !== "function") {
    throw new TypeError("Unsupported docs parser contract: expected MarkdownIt parser");
  }
  return parser;
}

function isParserObject(value: unknown): value is {
  parse?: unknown;
  renderer?: unknown;
  options?: unknown;
  utils?: unknown;
} {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

export function docsParser(value: unknown) {
  if (value == null) {
    return createDocsParser();
  }
  const parser = value;
  if (!isParserObject(parser)) {
    throw new TypeError("Unsupported docs parser contract: expected object with callable parse");
  }
  const parse = parser.parse;
  if (typeof parse !== "function") {
    throw new TypeError("Unsupported docs parser contract: expected object with callable parse");
  }
  const adapter = createDocsParser();
  // The vendor uses these facilities from the same parser that supplies the tokens.
  return Object.defineProperties(adapter, {
    parse: { value: (...args: unknown[]): unknown => Reflect.apply(parse, parser, args) },
    renderer: { get: () => parser.renderer },
    options: { get: () => parser.options },
    utils: { get: () => parser.utils },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("Unsupported docs parser contract: expected object");
  }
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Unsupported docs parser contract: expected array");
  }
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Unsupported docs parser contract: expected string");
  }
  return value;
}

export function frontmatter(text: string) {
  const parsed: unknown = parseFrontmatter(text);
  const result = record(parsed);
  return { data: result.data, content: string(result.content) };
}
