// Parses the JSON object lines in a process's output (structured log events). Lines that
// do not start with "{" (plain text, blank lines) are skipped in every mode. A line that
// starts with "{" must parse unless `lenient` is set: use that for output where a line
// can be cut short or interleaved, such as container logs read while the container runs.
export function jsonLines(text, { lenient = false } = {}) {
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
