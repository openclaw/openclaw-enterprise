import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The longest Unix socket path that binds everywhere: sun_path holds 104 bytes on macOS
// and 108 on Linux, including the trailing NUL.
export const socketPathLimit = 103;

// Used only when TMPDIR is too deep for a socket path: checkouts that keep TMPDIR inside
// a long workspace path, and often macOS's per-user TMPDIR once canonicalized. Linux
// abstract sockets are no alternative: the control socket is a configured filesystem
// path that the product validates, chmods and lstat()s, and macOS has no abstract
// namespace.
const shortTemporaryRoot = "/tmp";

// Returns a new private directory (mode 0700, canonical path) in which `longest`, the
// longest socket path the caller creates relative to it, fits within socketPathLimit.
// It prefers tmpdir() and falls back to /tmp. Keep other files in an ordinary temporary
// directory: the fallback exists for sockets only. `owner.after` removes the directory.
export async function socketDirectory(
  owner,
  prefix = "socket-",
  { longest = "control-relay.sock" } = {},
) {
  for (const root of new Set([tmpdir(), shortTemporaryRoot])) {
    const directory = await realpath(await mkdtemp(join(root, prefix)));
    if (Buffer.byteLength(join(directory, longest)) <= socketPathLimit) {
      owner.after(() => rm(directory, { recursive: true, force: true }));
      return directory;
    }
    await rm(directory, { recursive: true, force: true });
  }
  throw new Error(`no temporary directory fits ${longest} within ${socketPathLimit} bytes`);
}
