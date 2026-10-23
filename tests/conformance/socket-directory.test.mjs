import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { socketDirectory, socketPathLimit } from "../helpers/socket-directory.mjs";

// An owner whose cleanups the test runs itself, so it can observe the removal.
function ownerFor(t) {
  const cleanups = [];
  const close = async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()();
    }
  };
  t.after(close);
  return { after: (cleanup) => cleanups.push(cleanup), close };
}

async function withTemporaryRoot(directory, body) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
  }
}

async function assertBinds(path) {
  const server = createServer();
  server.listen(path);
  await once(server, "listening");
  assert.equal((await lstat(path)).isSocket(), true);
  await new Promise((resolve) => server.close(resolve));
}

test("socket directories stay under a TMPDIR that leaves room for the socket", async (t) => {
  const owner = ownerFor(t);
  const prefix = "socket-directory-test-";
  const root = await socketDirectory(owner, "sdt-", {
    longest: `${prefix}XXXXXX/control-relay.sock`,
  });
  const directory = await withTemporaryRoot(root, () => socketDirectory(owner, prefix));
  assert.equal(dirname(directory), root);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  await assertBinds(join(directory, "control-relay.sock"));
  await owner.close();
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});

test("a TMPDIR too deep for the socket falls back to a short root", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "socket-directory-deep-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const deep = join(base, "d".repeat(Math.max(1, socketPathLimit - base.length)));
  await mkdir(deep);
  const owner = ownerFor(t);
  const longest = "control/private/control.sock";
  const directory = await withTemporaryRoot(deep, () =>
    socketDirectory(owner, "socket-directory-test-", { longest }),
  );
  assert.equal(directory.startsWith(`${deep}/`), false);
  assert.ok(Buffer.byteLength(join(directory, longest)) <= socketPathLimit);
  assert.deepEqual(await readdir(deep), [], "the rejected deep directory is removed");
  await mkdir(join(directory, "control", "private"), { recursive: true });
  await assertBinds(join(directory, longest));
  await owner.close();
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});
