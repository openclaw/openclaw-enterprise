import assert from "node:assert/strict";
import { asRecord } from "../../packages/utils/src/index.ts";
import { parseStrictJsonLines } from "./json-lines-file.ts";

export { readJsonLines, readJsonLinesSync } from "./json-lines-file.ts";

type JsonLinesOptions = {
  lenient?: boolean;
  strict?: boolean;
};

type ObjectLinesOptions = JsonLinesOptions & { strict?: false };
type JsonRecord = Record<string, unknown>;

// A reader that needs event fields must fail on a non-object, not drop the line.
export function requireLogRecord(value: unknown): JsonRecord {
  const record = asRecord(value);
  assert.ok(record, "Expected a JSON object in the captured log.");
  return record;
}

// A write can append any parsed JSON value, including null and primitives. A function
// property (rather than an array method) lets strictFunctionTypes check the receiver.
type JsonSink = { push: (value: unknown) => unknown };

// The first JSON line (as `jsonLines` parses them with `options`) whose `event` is `event`.
// Fails with the whole text when there is none.
export function jsonEvent(text: string, event: string, options?: ObjectLinesOptions): JsonRecord;
export function jsonEvent(text: string, event: string, options?: JsonLinesOptions): unknown;
export function jsonEvent(text: string, event: string, options?: JsonLinesOptions): unknown {
  // Keep the direct property read: encountering null in strict mode throws, whereas
  // other primitives have no event. This does not validate the returned record's fields.
  const record = jsonLines(text, options).find((line) => (line as JsonRecord).event === event);
  assert.ok(record, text);
  return record;
}

// Parses the JSON object lines in a process's output (structured log events). Lines that
// do not start with "{" (plain text, blank lines) are skipped unless `strict` is set. A line
// that starts with "{" must parse unless `lenient` is set: use that for output where a line
// can be cut short or interleaved, such as container logs read while the container runs.
// `strict` parses every non-empty line of the trimmed text, so any plain-text line fails too:
// use it for output that must hold nothing but JSON events.
export function jsonLines(text: string, options?: ObjectLinesOptions): JsonRecord[];
export function jsonLines(text: string, options?: JsonLinesOptions): unknown[];
export function jsonLines(
  text: string,
  { lenient = false, strict = false }: JsonLinesOptions = {},
): unknown[] {
  assert.ok(!(lenient && strict), "jsonLines takes lenient or strict, not both");
  if (strict) {
    return parseStrictJsonLines(text, true);
  }
  const records: JsonRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) {
      continue;
    }
    // Successfully parsed JSON starting with "{" is necessarily an object.
    if (!lenient) {
      records.push(JSON.parse(line) as JsonRecord);
      continue;
    }
    try {
      records.push(JSON.parse(line) as JsonRecord);
    } catch {
      // A partial or interleaved line is not an event yet.
    }
  }
  return records;
}

// A `createOccLogger` destination that parses every line the logger writes into `records`.
// Each non-empty line must parse: the logger writes nothing but JSON lines.
export function jsonLineDestination(records: JsonSink) {
  return {
    write(chunk: unknown) {
      for (const line of String(chunk).split("\n")) {
        if (line.length > 0) {
          records.push(JSON.parse(line) as unknown);
        }
      }
      return true;
    },
  };
}

// A `createOccLogger` destination that parses each whole write into `records`, for tests that
// expect the logger to write exactly one JSON value per write: a chunk with two lines fails.
export function jsonChunkDestination(records: JsonSink) {
  return {
    write(chunk: unknown) {
      records.push(JSON.parse(String(chunk)) as unknown);
      return true;
    },
  };
}
