import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  SystemSshCommandExecutor,
  type SshCommand,
} from "../../apps/controller/src/drivers/compute/ssh/executor.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { setEnvironment } from "../helpers/environment.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import { fixtureBin, json, missing, stopFixtureUnits } from "./ssh-compute-fixture.ts";

const command: SshCommand = {
  address: "127.0.0.1",
  port: 2222,
  user: "root",
  nodePath: "/usr/bin/node",
  identityFile: "/keys/id",
  knownHostsFile: "/keys/known_hosts",
  connectTimeoutSeconds: 7,
  helper: 'process.stdout.write(JSON.stringify({value: SSH_OPERATION}) + "\\n");',
  operation: "e30=",
  timeoutMs: 5000,
};

test("system SSH executor sends exact argv and stdin and bounds cancellation and timeout", async (t) => {
  const base = await temporaryDirectory(t, "occ-ssh-argv-");
  const bin = join(base, "bin");
  await mkdir(bin);
  // Transport-only stand-in records argv and runs the unchanged stdin program with Node.
  // getBuiltinModule, not require: the stand-in loads as ESM when TMPDIR is inside this repo.
  // It installs its SIGTERM forwarder before spawning the helper. Installed after spawn(),
  // a SIGTERM that lands while spawn() runs (the 100 ms timeout below, on a busy runner)
  // killed the stand-in by default and orphaned the helper, which kept the executor's
  // stdio pipes open, so the execution never settled and the file hit its runner timeout.
  const ssh = join(bin, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}\nconst fs = process.getBuiltinModule('node:fs');\nconst { spawn } = process.getBuiltinModule('node:child_process');\nfs.writeFileSync(${JSON.stringify(join(base, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\nlet child;\nprocess.on('SIGTERM', () => (child ? child.kill('SIGTERM') : process.exit(143)));\nchild = spawn(process.execPath, ['-'], { stdio: 'inherit' });\nchild.on('exit', (code) => process.exit(code ?? 1));\n`,
  );
  await chmod(ssh, 0o755);
  setEnvironment(t, { PATH: `${bin}:${process.env.PATH}` });
  const executor = new SystemSshCommandExecutor();
  assert.deepEqual(await executor.execute(command), {
    code: 0,
    stdout: '{"value":"e30="}\n',
    stderr: "",
  });
  assert.deepEqual(await json(join(base, "argv.json")), [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UserKnownHostsFile=/keys/known_hosts",
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    "/keys/id",
    "-o",
    "ConnectTimeout=7",
    "-o",
    "LogLevel=ERROR",
    "-p",
    "2222",
    "-l",
    "root",
    "127.0.0.1",
    "--",
    "/usr/bin/node",
    "-",
  ]);
  const pidFile = join(base, "helper.pid");
  const waiting = {
    ...command,
    helper: `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
  };
  const controller = new AbortController();
  const pending = assert.rejects(
    withComputeAbortSignal(controller.signal, () => executor.execute(waiting)),
    /cancelled or timed out/,
  );
  // writeFileSync creates the file before it writes the pid, so wait for a complete pid
  // rather than for the file to exist: an empty read is Number("") === 0, and
  // process.kill(0, 0) signals this test's own process group.
  const pid = await waitFor("the remote helper pid", async () => {
    const recorded = Number(await readFile(pidFile, "utf8").catch(() => ""));
    return Number.isSafeInteger(recorded) && recorded > 0 ? recorded : undefined;
  });
  controller.abort();
  await pending;
  // The stand-in forwards SIGTERM and exits only after reaping the helper, so it is normally
  // gone already. If a starved runner hits the executor's SIGKILL grace after the forward,
  // the dead helper is reaped by init instead, so allow a bounded wait for that.
  await waitFor(
    "the cancelled remote helper to exit",
    () => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch (error) {
        assert.equal(asRecord(error)?.code, "ESRCH");
        return true;
      }
    },
    5_000,
  );
  await assert.rejects(executor.execute({ ...waiting, timeoutMs: 100 }), /cancelled or timed out/);
});

test("system SSH executor settles when a descendant of ssh keeps its stderr open", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "occ-ssh-stdio-"));
  const bin = join(base, "bin");
  await mkdir(bin);
  const orphans = join(base, "orphans");
  // Like an operator ProxyCommand, the stand-in starts a detached descendant that inherits
  // ssh's stderr and outlives ssh. The executor's stderr pipe stays open after ssh exits,
  // so an executor that settles only on "close" never settles, whatever timeoutMs says.
  const ssh = join(bin, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}\nconst fs = process.getBuiltinModule('node:fs');\nconst { spawn } = process.getBuiltinModule('node:child_process');\nconst orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });\nfs.appendFileSync(${JSON.stringify(orphans)}, orphan.pid + '\\n');\norphan.unref();\nlet child;\nprocess.on('SIGTERM', () => (child ? child.kill('SIGTERM') : process.exit(143)));\nchild = spawn(process.execPath, ['-'], { stdio: 'inherit' });\nchild.on('exit', (code) => process.exit(code ?? 1));\n`,
  );
  await chmod(ssh, 0o755);
  setEnvironment(t, { PATH: `${bin}:${process.env.PATH}` });
  t.after(async () => {
    const pids = (await readFile(orphans, "utf8").catch(() => "")).split("\n").filter(Boolean);
    for (const recorded of pids) {
      const pid = Number(recorded);
      assert.ok(
        Number.isSafeInteger(pid) && pid > 0,
        "the stand-in must record positive child PIDs",
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        assert.equal(asRecord(error)?.code, "ESRCH");
      }
    }
    await rm(base, { recursive: true, force: true });
  });
  // Generous for a busy runner, yet far below the descendant's 120 s lifetime, which is
  // how long an executor waiting for "close" would stay pending.
  function settled<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("execute() did not settle within 20 s")), 20_000);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }
  const executor = new SystemSshCommandExecutor();
  // ssh exits normally: the result keeps everything ssh wrote before it exited.
  assert.deepEqual(await settled(executor.execute(command)), {
    code: 0,
    stdout: '{"value":"e30="}\n',
    stderr: "",
  });
  // The operation times out: the executor terminates ssh and rejects instead of waiting
  // for the descendant to release stderr.
  await assert.rejects(
    settled(
      executor.execute({ ...command, helper: "setInterval(() => {}, 1000);", timeoutMs: 200 }),
    ),
    /cancelled or timed out/,
  );
});

// Direct fixture checks keep unit-file discovery separate from process liveness.
async function unitFileFixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "occ-unit-file-"));
  const units = join(base, "units");
  const state = join(base, "state");
  await Promise.all([mkdir(units), mkdir(state)]);
  const ctl = (...args: string[]) => {
    const result = spawnSync(join(fixtureBin, "systemctl"), args, {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        OCC_SSH_FIXTURE_STATE: state,
        OCC_SSH_FIXTURE_UNIT_DIRECTORY: units,
      },
    });
    assert.ifError(result.error);
    return result.status;
  };
  t.after(async () => {
    await stopFixtureUnits(state);
    await rm(base, { recursive: true, force: true });
  });
  const unit = "discovery.service";
  const path = join(units, unit);
  await writeFile(path, "[Service]\nEnvironment=OPENCLAW_GATEWAY_PORT=31443\n");
  return { ctl, unit, path, units, state };
}

test("SSH fixture rejects bare-name link without loading or enabling a unit", async (t) => {
  const { ctl, unit, path, units, state } = await unitFileFixture(t);
  assert.equal(ctl("link", unit), 1);
  await missing(join(units, "absent.service"));
  assert.equal(ctl("link", "absent.service"), 1);
  assert.deepEqual(
    (await readdir(state)).filter((name) => name !== "systemctl.log"),
    [],
  );
  assert.equal(ctl("stop", unit), 5);
  assert.equal(ctl("link", path), 0);
  assert.equal(ctl("enable", unit), 0);
  assert.equal(ctl("stop", unit), 0);
  assert.equal(ctl("disable", unit), 0);
  assert.equal(ctl("link", path), 0);
  assert.equal(ctl("stop", unit), 0);
});

test("SSH fixture requires a discoverable file to enable a disabled running unit", async (t) => {
  const { ctl, unit, path, state } = await unitFileFixture(t);
  assert.equal(ctl("enable", path), 0);
  assert.equal(ctl("start", unit), 0);
  assert.equal(ctl("disable", unit), 0);
  assert.equal(ctl("is-active", "--quiet", unit), 0);
  const pid = await readFile(join(state, `${unit}.pid`), "utf8");
  // Neither rejected operation may rediscover the disabled file or disturb its live unit.
  for (const operation of ["enable", "link"]) {
    assert.equal(ctl(operation, unit), 1);
    await missing(join(state, `${unit}.linked`));
    await missing(join(state, `${unit}.enabled`));
    assert.equal(ctl("is-enabled", unit), 1);
    assert.equal(await readFile(join(state, `${unit}.pid`), "utf8"), pid);
    assert.equal(ctl("is-active", "--quiet", unit), 0);
  }
  assert.equal(ctl("stop", unit), 0);
  await missing(join(state, `${unit}.pid`));
  assert.equal(ctl("is-active", "--quiet", unit), 1);
  assert.equal(ctl("stop", unit), 5);
  assert.equal(ctl("enable", path), 0);
  assert.equal(ctl("is-enabled", unit), 0);
});
