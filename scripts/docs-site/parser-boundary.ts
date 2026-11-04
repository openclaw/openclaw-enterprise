import { parseFrontmatter } from "./vendor/docs-markdown.mjs";

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
