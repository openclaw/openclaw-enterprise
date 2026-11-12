import { brotliCompressSync, constants, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Upper bound for one program piece. Linux rejects any single exec argument or
 * environment string above 128 KiB (MAX_ARG_STRLEN) with E2BIG, and OpenShell
 * carries a Sandbox's whole command in one environment variable.
 */
const NODE_PROGRAM_PIECE_BYTES = 32 * 1024;

// Runs as `node -e`, which already defines require, module and Buffer as globals.
// Removing the pieces leaves process.argv as a plain `node -e <program>` sees it.
function programLoader(decoder: "inflateRawSync" | "brotliDecompressSync"): string {
  return (
    `require("node:vm").runInThisContext(require("node:zlib").${decoder}(` +
    'Buffer.from(process.argv.splice(1).join(""), "base64")).toString("utf8"), { filename: "[eval]" });'
  );
}

const NODE_PROGRAM_LOADER = programLoader("inflateRawSync");

/**
 * The program without its whole-line `//` comments, which are about a fifth of a
 * rendered runtime program's compressed size (finding 2326). Without template literals,
 * line continuations, a `/*`, or a line terminator other than `\n` (a string may hold a raw
 * U+2028 or U+2029) anywhere, such a line cannot sit inside a string or a block comment,
 * so only comments go; any other program is returned unchanged.
 */
export function withoutLineComments(program: string): string {
  return /[`\r\u2028\u2029]|\/\*|\\\n/.test(program)
    ? program
    : program.replace(/^[ \t]*\/\/.*\n/gm, "");
}

/**
 * Arguments that follow `node -e` to run a controller-rendered program. The
 * program travels compressed in bounded pieces after a fixed loader, so no exec
 * argument outgrows a piece and a Sandbox command carries only the compressed size.
 */
export function nodeProgramArguments(
  program: string,
  codec: "deflate" | "brotli" = "deflate",
): string[] {
  const source = withoutLineComments(program);
  // The nested protected Codex child shares its supervisor's OpenShell command budget.
  const packed =
    codec === "brotli"
      ? brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
      : deflateRawSync(source, { level: 9, memLevel: 7 });
  const encoded = packed.toString("base64");
  const pieces: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += NODE_PROGRAM_PIECE_BYTES) {
    pieces.push(encoded.slice(offset, offset + NODE_PROGRAM_PIECE_BYTES));
  }
  return [
    codec === "brotli" ? programLoader("brotliDecompressSync") : NODE_PROGRAM_LOADER,
    ...pieces,
  ];
}

/** Re-encode a provider prelude with the canonical, already-rendered Node program. */
export function prependNodeProgramArguments(prelude: string, args: readonly string[]): string[] {
  const [loader, ...pieces] = args;
  if (loader !== NODE_PROGRAM_LOADER) {
    throw new Error("Expected the canonical Node program loader.");
  }
  const program = inflateRawSync(Buffer.from(pieces.join(""), "base64")).toString("utf8");
  return nodeProgramArguments(prelude + program);
}
