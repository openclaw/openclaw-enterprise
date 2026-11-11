import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const script = fileURLToPath(new URL("../../deploy/runtime/node/jobs.sh", import.meta.url));
const gib = 1024 * 1024 * 1024;

type Builder = { cpus: number; availableGiB: number; cgroup?: Record<string, string> };

async function selectJobs(t: test.TestContext, requested: string, builder: Builder) {
  const directory = await temporaryDirectory(t, "node-build-jobs-");
  const meminfo = join(directory, "meminfo");
  const cgroup = join(directory, "cgroup");
  await mkdir(cgroup);
  await writeFile(
    meminfo,
    `MemTotal:       ${512 * 1024 * 1024} kB\nMemAvailable:   ${builder.availableGiB * 1024 * 1024} kB\n`,
  );
  for (const [name, value] of Object.entries(builder.cgroup ?? {})) {
    await writeFile(join(cgroup, name), `${value}\n`);
  }
  return spawnSync("sh", [script, requested, String(builder.cpus), meminfo, cgroup], {
    encoding: "utf8",
  });
}

test("auto Node compile jobs follow the builder's CPUs and memory within fixed bounds", async (t) => {
  for (const [builder, expected] of [
    // Memory bounds a large-CPU builder: (40 - 8) / 2.
    [{ cpus: 192, availableGiB: 40 }, 16],
    [{ cpus: 12, availableGiB: 64 }, 12],
    // The cap bounds the load on large shared hosts.
    [{ cpus: 192, availableGiB: 150 }, 64],
    // Never fewer than the previous fixed default.
    [{ cpus: 2, availableGiB: 4 }, 4],
    [{ cpus: 16, availableGiB: 7 }, 4],
    // Builder cgroup limits lower both inputs.
    [{ cpus: 64, availableGiB: 150, cgroup: { "cpu.max": "1000000 100000" } }, 10],
    [
      {
        cpus: 64,
        availableGiB: 150,
        cgroup: { "memory.max": String(30 * gib), "memory.current": String(2 * gib) },
      },
      10,
    ],
    [{ cpus: 48, availableGiB: 150, cgroup: { "cpu.max": "max 100000", "memory.max": "max" } }, 48],
  ] as const) {
    const result = await selectJobs(t, "auto", builder);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected}\n`, JSON.stringify(builder));
    assert.match(
      result.stderr,
      new RegExp(`NODE_BUILD_JOBS=auto selected ${expected} compiler jobs`),
    );
  }
});

test("explicit Node compile jobs are used as given and invalid values fail", async (t) => {
  const builder = { cpus: 2, availableGiB: 4 };
  for (const requested of ["1", "8", "96"]) {
    const result = await selectJobs(t, requested, builder);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${requested}\n`);
  }
  for (const requested of ["", "0", "08", "-1", "4.5", "max", "auto "]) {
    const result = await selectJobs(t, requested, builder);
    assert.notEqual(result.status, 0, requested);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /NODE_BUILD_JOBS must be auto or a positive decimal integer/);
  }
});

test("the runtime Dockerfile defaults the Node compile to auto jobs", async () => {
  // A host-dependent default would make the compile layer's cache key differ by builder.
  const dockerfile = await readFile(
    new URL("../../deploy/runtime/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(
    dockerfile,
    /^FROM node-source AS node-compiled\nARG NODE_BUILD_JOBS=auto\nRUN --network=none sh \/node-repair\/build.sh$/m,
  );
  const build = await readFile(
    new URL("../../deploy/runtime/node/build.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    build,
    /sh \/node-repair\/jobs\.sh "\$\{NODE_BUILD_JOBS-auto\}" "\$\(nproc\)" \/proc\/meminfo \/sys\/fs\/cgroup/,
  );
});
