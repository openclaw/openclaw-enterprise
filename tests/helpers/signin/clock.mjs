import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const podClock = `const fs=require('node:fs');
for (const pid of ['1','self']) {
  const dir='/proc/'+pid+'/';
  const env=fs.readFileSync(dir+'environ','utf8');
  const maps=fs.readFileSync(dir+'maps','utf8');
  if (!env || !maps || env.split('\\0').some(s=>/^(FAKETIME[^=]*|LD_PRELOAD|LD_AUDIT|NODE_OPTIONS)=[\\s\\S]/.test(s))
      || /faketime/i.test(maps)) process.exit(42);
}
console.log(JSON.stringify([fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),
 fs.readlinkSync('/proc/1/ns/time'),fs.readlinkSync('/proc/self/ns/time'),Date.now()]));`;

// Run inside the acknowledged DB Pod. grep -z reads whole NUL-delimited entries.
// A clean scan returns 1. Treat read errors and empty proc files as failed evidence.
const dbPodClock = `set -eu
test -n "$1" && test "$OCE_TEST_POD_UID" = "$1" || exit 42
grep -zq . /proc/1/environ
grep -q . /proc/1/maps
if grep -zEq '^(FAKETIME[^=]*|LD_PRELOAD|LD_AUDIT|NODE_OPTIONS)=.' /proc/1/environ; then exit 42; else test "$?" -eq 1; fi
if grep -iq faketime /proc/1/maps; then exit 42; else test "$?" -eq 1; fi
init=$(readlink /proc/1/ns/time)
reader=$(readlink /proc/self/ns/time)
test "$init" = "$reader"
printf '%s\\n' "$init"`;

function containerIdentity(pod, name, node) {
  const status = pod.status.containerStatuses.find((c) => c.name === name);
  assert.equal(pod.spec.nodeName, node);
  assert(
    !pod.metadata.deletionTimestamp &&
      pod.metadata.uid &&
      status?.state.running &&
      status.containerID,
  );
  return [pod.metadata.name, pod.metadata.uid, status.containerID];
}

export async function fixtureClock({ kube, pods, custody, localCluster }) {
  assert.equal(process.platform, "linux");
  assert(
    !Object.keys(process.env).some(
      (k) => /^(?:FAKETIME.*|LD_PRELOAD|LD_AUDIT|NODE_OPTIONS)$/.test(k) && process.env[k],
    ),
  );
  assert(!/faketime/i.test(await readFile("/proc/self/maps", "utf8")));
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const ns = await readlink("/proc/self/ns/time");
  const child = spawn(
    "python3",
    ["-I", fileURLToPath(new URL("./clock-watch.py", import.meta.url))],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function sample() {
    child.stdin.write("sample\n");
    let timer;
    try {
      const { done, value } = await Promise.race([
        lines.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("clock-step monitor unavailable")), 3000);
        }),
      ]);
      assert(!done && /^\d+$/.test(value));
      return Number(value);
    } finally {
      clearTimeout(timer);
    }
  }
  const component = (pod) => pod.metadata.labels["app.kubernetes.io/component"];
  const controllers = (list) =>
    list
      .map((p) => containerIdentity(p, component(p), localCluster.node))
      .sort(([a], [b]) => a.localeCompare(b));
  async function databaseIdentity() {
    const pod = JSON.parse(await kube("get", "pod/postgres", "-o", "json"));
    custody.assertUID("pod/postgres", pod.metadata.uid);
    return containerIdentity(pod, "postgres", localCluster.node);
  }
  async function bracket() {
    const monotonicStart = process.hrtime.bigint();
    const hostBefore = Date.now();
    const lower = await sample();
    await localCluster.assertCluster();
    const node = JSON.parse(await kube("get", "node/" + localCluster.node, "-o", "json"));
    assert.equal(node.metadata.uid, localCluster.nodeUID, "clock witness Node changed");
    assert.equal(node.status.nodeInfo.bootID, boot, "clock witness kernel boot changed");
    const list = await pods();
    const before = controllers(list);
    const database = await databaseIdentity();
    const podNs = (
      await kube(
        "exec",
        "pod/postgres",
        "-c",
        "postgres",
        "--",
        "sh",
        "-ec",
        dbPodClock,
        "clock-witness",
        database[1],
      )
    ).trim();
    assert(/^time:\[\d+\]$/.test(podNs), "invalid database time namespace");
    assert.equal(podNs, last?.podNs ?? podNs, "fixture DB time namespace changed");
    // Time namespaces virtualize monotonic and boottime. REALTIME is shared across
    // this kernel boot. Keep namespace equality within the observed fixture.
    const values = await Promise.all(
      list.map(async (pod) => {
        const [domain, initNs, execNs, value] = JSON.parse(
          await kube("exec", pod.metadata.name, "-c", component(pod), "--", "node", "-e", podClock),
        );
        assert.equal(domain, boot, "controller kernel boot changed");
        assert.equal(initNs, execNs, "controller and clock reader namespaces differ");
        assert.equal(initNs, podNs, "controller outside fixture time namespace");
        return value;
      }),
    );
    const db = (
      await custody.postgres(
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "--dbname=postgres",
        "-c",
        "SELECT btrim(pg_read_file('/proc/sys/kernel/random/boot_id',0,128), chr(10)||chr(13)||' '), floor(extract(epoch FROM clock_timestamp())*1000)::bigint",
      )
    )
      .trim()
      .split("|");
    assert(
      db.length === 2 && db[0] === boot && /^\d+$/.test(db[1]),
      "invalid backend clock witness",
    );
    values.push(Number(db[1]));
    assert.deepEqual(
      await databaseIdentity(),
      database,
      "database container changed during sample",
    );
    assert.deepEqual(controllers(await pods()), before, "controller set changed during sample");
    const upper = await sample();
    const hostAfter = Date.now();
    const monotonicEnd = process.hrtime.bigint();
    assert(
      monotonicStart <= monotonicEnd && (!last || BigInt(last.monotonicEndNs) <= monotonicStart),
    );
    assert(hostBefore <= lower && lower <= upper && upper <= hostAfter);
    assert(lower >= (last?.upper ?? lower), "clock observations moved backward");
    assert(values.every((v) => Number.isSafeInteger(v) && lower <= v && v <= upper));
    last = {
      lower,
      upper,
      readersMs: values,
      boot,
      hostNs: ns,
      podNs,
      containers: before,
      database,
      monotonicStartNs: String(monotonicStart),
      monotonicEndNs: String(monotonicEnd),
    };
    return last;
  }
  let bound;
  let last;
  return {
    lastObservation: () => ({ ...last, skewMs: bound }),
    async verifiedSkewMs() {
      const { lower, upper } = await bracket();
      // Identical realtime domain. Use the measured outer observation interval plus
      // integer clock quantization as a conservative cross-reader bound.
      bound ??= upper - lower + 2;
      return bound;
    },
    async readerUpperMs() {
      return (await bracket()).upper;
    },
    async waitUntilReaderPast(deadline) {
      const end = performance.now() + 150000;
      while (performance.now() < end) {
        const { lower } = await bracket();
        if (lower > deadline) {
          return;
        }
        await delay(Math.min(deadline - lower + 1, 1000));
      }
      throw new Error("reader expiry not observed");
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        const force = setTimeout(() => child.kill("SIGKILL"), 3000);
        try {
          await new Promise((resolve) => child.once("close", resolve));
        } finally {
          clearTimeout(force);
        }
      }
    },
  };
}
