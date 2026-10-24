import { deflateRawSync } from "node:zlib";

/**
 * Upper bound for one program piece. Linux rejects any single exec argument or
 * environment string above 128 KiB (MAX_ARG_STRLEN) with E2BIG, and OpenShell
 * carries a Sandbox's whole command in one environment variable.
 */
const NODE_PROGRAM_PIECE_BYTES = 32 * 1024;

// Runs as `node -e`, which already defines require, module and Buffer as globals.
// Removing the pieces leaves process.argv as a plain `node -e <program>` sees it.
const NODE_PROGRAM_LOADER =
  'require("node:vm").runInThisContext(require("node:zlib").inflateRawSync(' +
  'Buffer.from(process.argv.splice(1).join(""), "base64")).toString("utf8"), { filename: "[eval]" });';

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
export function nodeProgramArguments(program: string): string[] {
  const encoded = deflateRawSync(withoutLineComments(program)).toString("base64");
  const pieces: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += NODE_PROGRAM_PIECE_BYTES) {
    pieces.push(encoded.slice(offset, offset + NODE_PROGRAM_PIECE_BYTES));
  }
  return [NODE_PROGRAM_LOADER, ...pieces];
}
