// The observers compare exact literal argv. They never run the observed command.
export function standaloneArguments(command: unknown): string[] | undefined {
  if (typeof command !== "string" || command.length > 8192 || /[\r\n\0]/.test(command)) {
    return undefined;
  }
  const args: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index);
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === "\\") {
        const escaped = command.charAt(++index);
        if (![34, 36, 92, 96].includes(escaped.charCodeAt(0))) {
          return undefined;
        }
        word += escaped;
        continue;
      }
      if (quote === '"' && (char === "$" || char.charCodeAt(0) === 96)) {
        return undefined;
      }
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) {
        args.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (char === "\\") {
      const escaped = command.charAt(++index);
      if (!["'", '"', "\\", " ", "\t"].includes(escaped)) {
        return undefined;
      }
      word += escaped;
      started = true;
      continue;
    }
    if (/[;&|<>(){}$#*?[\]~]/.test(char) || char.charCodeAt(0) === 96) {
      return undefined;
    }
    word += char;
    started = true;
  }
  if (quote) {
    return undefined;
  }
  if (started) {
    args.push(word);
  }
  return args;
}

// SQLite transcripts and native RPC replies both carry open JSON records.
export function observationFields(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function matchingOperations(
  expected: unknown,
  cwd: unknown,
  args: string[] | undefined,
): unknown[] {
  if (!Array.isArray(expected)) {
    throw new Error("invalid repository command inventory");
  }
  return (expected as unknown[]).flatMap((entry) => {
    const spec = observationFields(entry);
    if (!spec) {
      throw new Error("invalid repository command expectation");
    }
    const argv = typeof spec.argv === "string" ? spec.argv : observationFields(spec.argv);
    const matches =
      cwd === spec.workdir &&
      args !== undefined &&
      args.length === argv?.length &&
      args.every(
        (arg, index) => arg === (typeof argv === "string" ? argv[index] : argv[String(index)]),
      );
    return matches ? [spec.operation] : [];
  });
}
