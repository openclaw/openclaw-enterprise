import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { sha256Hex } from "../../packages/utils/src/index.ts";

const execute = promisify(execFile);
const base = process.env.OCC_TEST_RUNTIME_IMAGE;
const selected = {
  skip: base ? false : "Set OCC_TEST_RUNTIME_IMAGE to test real Docker image inspection.",
};
const docker = (...args) => execute("docker", args, { maxBuffer: 2 * 1024 * 1024 });

test(
  "Docker runtime image inspection follows attached images and rejects foreign revisions",
  selected,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "oce-runtime-images-"));
    const tag = `oce-runtime-images:${randomUUID()}`;
    const commit = "1234567890abcdef1234567890abcdef12345678";
    const openclawCommit = "abcdef1234567890abcdef1234567890abcdef12";
    const names = [];
    t.after(async () => {
      for (const name of names) {
        await docker("rm", "-f", name).catch(() => {});
      }
      await docker("image", "rm", tag).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "Dockerfile"),
      `FROM ${base}\nLABEL org.opencontainers.image.revision=${commit}\nLABEL org.openclaw.image.revision=${openclawCommit}\nLABEL private.fixture=must-not-leak\n`,
    );
    await docker("build", "-t", tag, directory);
    const imageId = JSON.parse((await docker("image", "inspect", tag)).stdout)[0].Id;
    const compute = new DockerComputeDriver({ images: { gateway: tag, agent: base } });
    const namespace = { id: `ns_${randomUUID()}` };
    const agent = { id: `agt_${randomUUID()}` };
    const revision = {
      id: `rev_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: agent.id,
      compute: { id: compute.id, implementation: compute.implementation },
    };
    const name = `oce-${sha256Hex(namespace.id, 12)}-gateway-${sha256Hex(agent.id, 12)}`;
    names.push(name);
    const labels = {
      "org.openclaw.enterprise.managed": "true",
      "org.openclaw.enterprise.compute-driver": "docker",
      "org.openclaw.enterprise.namespace-id": namespace.id,
      "org.openclaw.enterprise.agent-id": agent.id,
      "org.openclaw.enterprise.revision-id": revision.id,
    };
    await docker(
      "create",
      "--name",
      name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      tag,
      "node",
      "--version",
    );
    // Retarget the tag after container creation: observations must follow Image,
    // the actual attached immutable ID, rather than inspect Config.Image's tag.
    await docker("tag", base, tag);
    const result = await compute.getRuntimeImages(revision);
    assert.deepEqual(result, [
      { workload: name, container: "gateway", image: tag, imageId, commit, openclawCommit },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
    await docker("rm", "-f", name);
    // A container from another revision must fail closed, even under the expected name.
    labels["org.openclaw.enterprise.revision-id"] = `rev_${randomUUID()}`;
    await docker(
      "create",
      "--name",
      name,
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      tag,
      "node",
      "--version",
    );
    await assert.rejects(compute.getRuntimeImages(revision), /unowned/i);
  },
);

test(
  "runtime image metadata endpoint validates Enterprise and OpenClaw provenance independently",
  selected,
  async () => {
    const script = `${PLUGIN_RUNTIME_HELPERS}
const fs = require("node:fs");
fs.mkdirSync("/opt/oce/runtime", {recursive: true});
process.env.OPENCLAW_RUNTIME_STATUS_PORT = "18888";
startPluginRuntimeStatusServer();
(async () => {
  const assert = require("node:assert/strict");
  for (const value of ["a".repeat(40), "invalid", null]) {
    fs.writeFileSync("/opt/oce/runtime/provenance.json", JSON.stringify({source: "https://github.com/openclaw/openclaw", commit: value, secret: "never expose"}));
    fs.writeFileSync("/opt/oce/runtime/build.json", JSON.stringify({commit: value, secret: "never expose"}));
    const response = await fetch("http://127.0.0.1:18888/openclaw/runtime/image");
    assert.deepEqual(await response.json(), {commit: typeof value === "string" && value.length === 40 ? value : null, openclawCommit: typeof value === "string" && value.length === 40 ? value : null});
  }
  fs.writeFileSync("/opt/oce/runtime/provenance.json", JSON.stringify({source: "https://example.com/foreign", commit: "b".repeat(40)}));
  assert.deepEqual(await (await fetch("http://127.0.0.1:18888/openclaw/runtime/image")).json(), {commit: null, openclawCommit: null});
  fs.writeFileSync("/opt/oce/runtime/provenance.json", JSON.stringify({source: "https://github.com/openclaw/openclaw", commit: "b".repeat(40)}));
  fs.unlinkSync("/opt/oce/runtime/build.json");
  assert.deepEqual(await (await fetch("http://127.0.0.1:18888/openclaw/runtime/image")).json(), {commit: null, openclawCommit: "b".repeat(40)});
  fs.unlinkSync("/opt/oce/runtime/provenance.json");
  assert.deepEqual(await (await fetch("http://127.0.0.1:18888/openclaw/runtime/image")).json(), {commit: null, openclawCommit: null});
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });`;
    await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "--entrypoint",
      "node",
      base,
      "-e",
      script,
    );
  },
);
