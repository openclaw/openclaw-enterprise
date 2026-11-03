import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// Local runs share one TMPDIR across every lane and pin loop, so a directory a test
// leaves behind stays there. This hook is added when the module is imported, so it
// runs after the file's last test (after the last file with --test-isolation=none)
// rather than after whichever test is running: import this module statically.
const fileDirectories = new Set();
after(() => {
  for (const directory of fileDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  fileDirectories.clear();
});

// Returns a new directory under TMPDIR that stays until the test file's last test
// ends, passed or failed. Use it from helpers that have no test context to clean up
// with; a helper that has one should remove its directory with `t.after`.
export function fileTemporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  fileDirectories.add(directory);
  return directory;
}

// Returns a new directory under TMPDIR that is removed after the test that owns `t`
// ends, passed or failed. Prefer it whenever a test context is at hand.
export async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// temporaryDirectory for synchronous tests and helpers: the same directory and cleanup.
export function temporaryDirectorySync(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
