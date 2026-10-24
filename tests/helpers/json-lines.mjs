import assert from "node:assert/strict";

// The first JSON line (as `jsonLines` parses them with `options`) whose `event` is `event`.
// Fails with the whole text when there is none.
export function jsonEvent(text, event, options) {
  const record = jsonLines(text, options).find((line) => line.event === event);
  assert.ok(record, text);
  return record;
}

// Parses the JSON object lines in a process's output (structured log events). Lines that
// do not start with "{" (plain text, blank lines) are skipped unless `strict` is set. A line
// that starts with "{" must parse unless `lenient` is set: use that for output where a line
// can be cut short or interleaved, such as container logs read while the container runs.
// `strict` parses every non-empty line of the trimmed text, so any plain-text line fails too:
// use it for output that must hold nothing but JSON events.
export function jsonLines(text, { lenient = false, strict = false } = {}) {
  assert.ok(!(lenient && strict), "jsonLines takes lenient or strict, not both");
  if (strict) {
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) {
      continue;
    }
    if (!lenient) {
      records.push(JSON.parse(line));
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partial or interleaved line is not an event yet.
    }
  }
  return records;
}
