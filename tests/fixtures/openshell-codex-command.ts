import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { brotliDecompressSync, inflateRawSync } from "node:zlib";

type CodexChildArguments = readonly ["-e", string, string, ...string[]];

function isCodexChildArguments(value: unknown): value is CodexChildArguments {
  if (!Array.isArray(value)) {
    return false;
  }
  const args: readonly unknown[] = value;
  return (
    args.length >= 3 && args[0] === "-e" && args.slice(1).every((arg) => typeof arg === "string")
  );
}

// The driver supplies the final argv, after both preludes. Decode it without
// rebuilding the launch command or using the production encoder as an oracle.
export function inspectOpenShellCodexCommand(
  t: TestContext,
  command: readonly string[],
  { compact, current = true }: { compact: boolean; current?: boolean },
) {
  assert.deepEqual(command.slice(0, 7), ["/usr/bin/tini", "-s", "-e", "143", "--", "node", "-e"]);
  const bytes = Buffer.byteLength(JSON.stringify(command));
  const largest = Math.max(...command.map((part) => Buffer.byteLength(part)));
  t.diagnostic(`CreateSandbox command ${bytes} bytes, largest argument ${largest} bytes`);
  assert.ok(largest <= 32_768);
  if (current) {
    assert.ok(bytes <= 65_536, `CreateSandbox command is ${bytes} bytes`);
  }
  const [loader, ...pieces] = command.slice(7);
  assert.ok(loader, "OpenShell supplies the Node program loader");
  const supervisor = inflateRawSync(Buffer.from(pieces.join(""), "base64")).toString();
  const child = /\n\s+name: "Codex",\n\s+args: (.+),\n/.exec(supervisor)?.[1];
  assert.ok(child, "Compute includes the workspace node supervisor");
  const parsed: unknown = JSON.parse(child);
  assert.ok(
    isCodexChildArguments(parsed),
    "Codex child argv includes -e, a loader and program pieces",
  );
  const [, childLoader, ...childPieces] = parsed;
  assert.match(childLoader, compact ? /brotliDecompressSync/ : /inflateRawSync/);
  assert.ok(childPieces.every((piece) => Buffer.byteLength(piece) <= 32_768));
  const decode = compact ? brotliDecompressSync : inflateRawSync;
  const codex = decode(Buffer.from(childPieces.join(""), "base64")).toString();
  return { loader, supervisor, codex };
}
