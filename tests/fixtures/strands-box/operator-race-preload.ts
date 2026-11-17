import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

export type OperatorRace =
  | "gateway-removed"
  | "gateway-removed-after-read"
  | "workspace-replaced-after-marker"
  | "ancestor-at-expected"
  | "directory-at-intent";

const base = process.env.STRANDS_TEST_OPERATOR_ROOT;
assert.ok(base);

function scheduleFileRace(base: string) {
  const role = process.env.STRANDS_TEST_OPERATOR_RACE;
  const mount = "/home/node/workspace";
  const localMount = join(base, "workspace");
  const open = fs.openSync;
  const lstat = fs.lstatSync;
  const realpath = fs.realpathSync;
  const readlink = fs.readlinkSync;
  const write = fs.writeFileSync;
  let swapped = false;

  // Route the fixed mount path to a disposable directory without changing host paths.
  function mountPath<T>(path: T): T | string {
    if (path === mount) {
      return localMount;
    }
    if (typeof path === "string" && path.startsWith(mount + "/")) {
      return localMount + path.slice(mount.length);
    }
    return path;
  }

  function moveGateway() {
    const gateway = join(base, "original", "run", "gateway.json");
    fs.renameSync(gateway, gateway + ".moved");
    swapped = true;
  }

  fs.openSync = (path, flags, mode) => {
    if (
      !swapped &&
      role === "ancestor-at-expected" &&
      typeof path === "string" &&
      basename(path) === "expected.json"
    ) {
      const original = join(base, "original");
      fs.renameSync(original, join(base, "moved"));
      fs.symlinkSync(join(base, "alternate"), original, "dir");
      swapped = true;
    }
    if (!swapped && typeof path === "string" && basename(path) === "owner-wss.json") {
      if (role === "gateway-removed-after-read") {
        moveGateway();
      }
      if (role === "workspace-replaced-after-marker") {
        fs.renameSync(localMount, join(base, "moved-workspace"));
        fs.mkdirSync(localMount, { mode: 0o700 });
        swapped = true;
      }
    }
    return open(mountPath(path), flags, mode);
  };
  fs.lstatSync = ((path, options) => {
    if (
      !swapped &&
      role === "gateway-removed" &&
      typeof path === "string" &&
      basename(path) === "gateway.json"
    ) {
      moveGateway();
    }
    return lstat(mountPath(path), options);
  }) as typeof lstat;
  fs.realpathSync = Object.assign(
    (path: fs.PathLike) => {
      const result = realpath(mountPath(path));
      return result === localMount ? mount : result;
    },
    { native: realpath.native },
  ) as typeof realpath;
  fs.readlinkSync = ((path: fs.PathLike) => {
    const result = readlink(path);
    return result === localMount ? mount : result;
  }) as typeof readlink;
  fs.writeFileSync = (path, data, options) => {
    if (
      !swapped &&
      role === "directory-at-intent" &&
      typeof path === "string" &&
      basename(path) === "intent.json"
    ) {
      const original = join(base, "original", "run");
      fs.renameSync(original, join(base, "moved"));
      fs.renameSync(join(base, "alternate", "run"), original);
      swapped = true;
    }
    write(mountPath(path), data, options);
  };
  syncBuiltinESMExports();
}

if (import.meta.main) {
  // Harmless CLI records exactly what the caller sent without opening a socket.
  const args = process.argv.slice(2);
  fs.appendFileSync(join(base, "cli.jsonl"), JSON.stringify(args) + "\n");
  const [, , method, , , params, payload] = args;
  assert.equal(method, "chat.send");
  assert.equal(params, "--params");
  assert.ok(payload);
  const data = JSON.parse(payload) as { idempotencyKey: string };
  process.stdout.write(JSON.stringify({ runId: data.idempotencyKey, status: "accepted" }));
} else {
  scheduleFileRace(base);
}
