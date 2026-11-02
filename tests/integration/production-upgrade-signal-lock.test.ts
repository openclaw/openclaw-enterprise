import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const script = join(repository, "scripts/upgrade-production-images");
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();

async function setup(t: TestContext) {
  const directory = await temporaryDirectory(t, "upgrade-signal-");
  const bin = join(directory, "bin");
  const evidence = join(directory, "evidence");
  const lock = join(evidence, ".upgrade-lock");
  const ready = join(directory, "ready");
  const release = join(directory, "release");
  const journal = join(directory, "commands");
  await mkdir(bin);
  await writeFile(journal, "");
  for (const name of ["kubeconfig", "values", "installation", "service-key"]) {
    await writeFile(join(directory, name), "{}\n", { mode: 0o600 });
  }
  // Only parameter binding is replaced. Earlier input checks use real Python.
  // The child stops before any cluster command or credential parsing can occur.
  const python = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  await writeFile(
    join(bin, "python3"),
    `#!/bin/bash
if [[ "\${2:-}" == "$SIGNAL_KUBECONFIG" ]]; then
  [[ -d "$SIGNAL_EVIDENCE/.upgrade-lock" ]] || exit 91
  printf 'binding-start\n' >> "$SIGNAL_JOURNAL"
  touch "$SIGNAL_READY"
  for ((attempt=0; attempt<6000; attempt++)); do
    [[ -f "$SIGNAL_RELEASE" ]] && break
    sleep 0.02
  done
  [[ -f "$SIGNAL_RELEASE" ]] || exit 74
  printf 'binding-end\n' >> "$SIGNAL_JOURNAL"
  exit 73
fi
exec "$SIGNAL_PYTHON" "$@"
`,
    { mode: 0o700 },
  );
  for (const command of ["helm", "kubectl", "jq", "yq", "occ"]) {
    await writeFile(
      join(bin, command),
      '#!/bin/bash\nprintf "unexpected:%s\\n" "$0" >> "$SIGNAL_JOURNAL"\nexit 92\n',
      { mode: 0o700 },
    );
  }
  const args = [
    "--kubeconfig",
    join(directory, "kubeconfig"),
    "--context",
    "synthetic",
    "--namespace",
    "synthetic",
    "--release",
    "synthetic",
    "--values",
    join(directory, "values"),
    "--installation",
    join(directory, "installation"),
    "--controller-image",
    `example.invalid/controller@sha256:${"a".repeat(64)}`,
    "--source-revision",
    revision,
    "--evidence-dir",
    evidence,
  ];
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: directory,
    OCC_URL: "https://control.invalid",
    OCC_SERVICE_KEY_FILE: join(directory, "service-key"),
    SIGNAL_PYTHON: python,
    SIGNAL_KUBECONFIG: join(directory, "kubeconfig"),
    SIGNAL_EVIDENCE: evidence,
    SIGNAL_JOURNAL: journal,
    SIGNAL_READY: ready,
    SIGNAL_RELEASE: release,
  };
  const start = (...extra: string[]) => {
    const child = spawn(script, [...args, ...extra], {
      cwd: repository,
      env,
      timeout: 60000,
      killSignal: "SIGKILL",
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const done = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => accept({ code, signal, stderr }));
    });
    return { child, done };
  };
  const commands = () => readFile(journal, "utf8");
  const waitReady = () =>
    waitUntil("the parameter-binding child to start", () => existsSync(ready), {
      timeoutMs: 30000,
      intervalMs: 20,
    });
  const assertLockedResume = async () => {
    const before = await commands();
    const { done } = start("--resume");
    const result = await done;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /evidence directory is locked/);
    assert.equal(await commands(), before, "locked resume entered an external command");
  };
  return { lock, release, start, commands, waitReady, assertLockedResume };
}

for (const [signal, status] of [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(
    `upgrade retains its lock after ${signal} until explicit reconciliation`,
    { timeout: 180000 },
    async (t) => {
      const f = await setup(t);
      const running = f.start();
      try {
        await f.waitReady();
        await f.assertLockedResume();
        assert.equal(await f.commands(), "binding-start\n");
        // Signal the real caller only; its accepted child is independently controlled.
        assert.ok(running.child.kill(signal));
        await writeFile(f.release, "settle\n");
        const result = await running.done;
        assert.ok(existsSync(f.lock), "interruption released the evidence lock");
        assert.deepEqual(
          { code: result.code, signal: result.signal },
          { code: status, signal: null },
        );
        assert.equal(await f.commands(), "binding-start\nbinding-end\n");
        await f.assertLockedResume();
        // Only after the child has settled may the operator remove the retained lock.
        await rmdir(f.lock);
        const resumed = await f.start("--resume").done;
        assert.equal(resumed.code, 73, resumed.stderr);
        assert.equal(
          await f.commands(),
          "binding-start\nbinding-end\nbinding-start\nbinding-end\n",
        );
        assert.equal(existsSync(f.lock), false, "terminal error left a stale lock");
      } finally {
        await writeFile(f.release, "settle\n");
        await running.done;
      }
    },
  );
}

test(
  "ordinary parameter-binding failure releases the upgrade lock",
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t);
    await writeFile(f.release, "settle\n");
    const result = await f.start().done;
    assert.equal(result.code, 73, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(existsSync(f.lock), false);
    assert.equal(await f.commands(), "binding-start\nbinding-end\n");
  },
);
