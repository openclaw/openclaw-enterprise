/** Parse grammar first, then report decoded duplicate names in each object.
 * Depth counts containing objects and arrays; a root object has depth 1. */
export function parseJsonMembers(
  text: string,
  onDuplicate: (decodedName: string, depth: number) => void,
  reviver?: (key: string, value: unknown, context?: { source?: string }) => unknown,
): unknown {
  const parsed: unknown = JSON.parse(text, reviver);
  const stack: { keys: Set<string> | undefined; expectingKey: boolean }[] = [];
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]/gs)) {
    if (token === "{" || token === "[") {
      stack.push({ keys: token === "{" ? new Set() : undefined, expectingKey: token === "{" });
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else {
      const frame = stack.at(-1);
      if (frame?.keys && token === ",") {
        frame.expectingKey = true;
      } else if (frame?.keys && frame.expectingKey && token.startsWith('"')) {
        const key: string = JSON.parse(token);
        if (frame.keys.has(key)) {
          onDuplicate(key, stack.length);
        }
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    }
  }
  return parsed;
}

/** Strict consumers must never select a value from ambiguous JSON. */
export function parseUnambiguousJson(text: string): unknown {
  return parseJsonMembers(text, () => {
    throw new Error("Ambiguous JSON members are unsupported.");
  });
}
