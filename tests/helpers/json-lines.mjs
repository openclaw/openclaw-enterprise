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

// A `createOccLogger` destination that parses every line the logger writes into `records`.
// Each non-empty line must parse: the logger writes nothing but JSON lines.
export function jsonLineDestination(records) {
  return {
    write(chunk) {
      for (const line of String(chunk).split("\n")) {
        if (line.length > 0) {
          records.push(JSON.parse(line));
        }
      }
      return true;
    },
  };
}
