import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { PLUGIN_RUNTIME_HELPERS } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { sha256Hex } from "../../packages/utils/src/index.ts";
import {
  isRuntimeImageJob,
  localDockerCli,
  withRuntimeImageFixture,
} from "../helpers/runtime-image-fixture.mjs";
import "../helpers/runtime-image-fixture.test.mjs";

const execute = promisify(execFile);
const base = `localhost/oce-runtime-images-${randomUUID()}/runtime:local`;
const selected = {
  skip: isRuntimeImageJob(process.env)
    ? false
    : "Run through the dedicated GitHub-hosted runtime-image-fixture job.",
};
const docker = localDockerCli(execute);

// This suite is routed only to its dedicated GitHub-hosted job. The job owns
// the VM; preparation, builds, tests and cleanup are sequential in this process.
// Cancellation or a lost response is not a cleanup receipt.
test("runtime image fixture", selected, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-images-"));
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  await withRuntimeImageFixture(
    docker,
    directory,
    async (fixture) => {
      const dockerfile = join(directory, "runtime.Dockerfile");
      const productionDockerfile = await readFile(join(root, "deploy/runtime/Dockerfile"), "utf8");
      const runtimeBase = productionDockerfile.match(/^ARG NODE_RUNTIME_BASE_IMAGE=(\S+)$/m)?.[1];
      assert.ok(runtimeBase, "production runtime Dockerfile must pin NODE_RUNTIME_BASE_IMAGE");
      // Images and Packaging already builds and validates the complete production
      // image. This owned job needs only a real Node image to exercise Docker's
      // immutable-image behavior and the source-injected metadata endpoint.
      await writeFile(
        dockerfile,
        `FROM ${runtimeBase}\nLABEL private.fixture.base=${randomUUID()}\n`,
      );
      await fixture.buildRuntimeBase(base, join(directory, "base.iid"), dockerfile, root);
      await t.test(
        "Docker runtime image inspection follows attached images and rejects foreign revisions",
        async () => {
          const tag = `oce-runtime-images:${randomUUID()}`;
          const replacementTag = `oce-runtime-images:${randomUUID()}`;
          const commit = "1234567890abcdef1234567890abcdef12345678";
          const openclawCommit = "abcdef1234567890abcdef1234567890abcdef12";
          {
            await writeFile(
              join(directory, "Dockerfile"),
              `FROM ${base}\nARG FIXTURE_NONCE\nLABEL org.opencontainers.image.revision=${commit}\nLABEL org.openclaw.image.revision=${openclawCommit}\nLABEL private.fixture=must-not-leak\nLABEL private.fixture.nonce=${"${FIXTURE_NONCE}"}\n`,
            );
            const baseId = (await fixture.inspectImage(base)).Id;
            const imageId = await fixture.build(
              tag,
              join(directory, "image.iid"),
              randomUUID(),
              baseId,
            );
            const replacementId = await fixture.build(
              replacementTag,
              join(directory, "replacement.iid"),
              randomUUID(),
              baseId,
            );
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
            const labels = {
              "org.openclaw.enterprise.managed": "true",
              "org.openclaw.enterprise.compute-driver": "docker",
              "org.openclaw.enterprise.namespace-id": namespace.id,
              "org.openclaw.enterprise.agent-id": agent.id,
              "org.openclaw.enterprise.revision-id": revision.id,
            };
            const firstContainer = await fixture.create(name, [
              ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
              tag,
              "node",
              "--version",
            ]);
            // Retarget the tag after container creation: observations must follow Image,
            // the actual attached immutable ID, rather than inspect Config.Image's tag.
            await fixture.retag(replacementId, tag);
            const result = await compute.getRuntimeImages(revision);
            assert.deepEqual(result, [
              { workload: name, container: "gateway", image: tag, imageId, commit, openclawCommit },
            ]);
            assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
            await fixture.removeContainer(firstContainer);
            // A container from another revision must fail closed, even under the expected name.
            labels["org.openclaw.enterprise.revision-id"] = `rev_${randomUUID()}`;
            await fixture.create(name, [
              ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
              tag,
              "node",
              "--version",
            ]);
            await assert.rejects(compute.getRuntimeImages(revision), /unowned/i);
          }
        },
      );

      await t.test(
        "runtime image metadata endpoint validates Enterprise and OpenClaw provenance independently",
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
          {
            const id = await fixture.create(`oce-runtime-status-${randomUUID()}`, [
              "--network",
              "none",
              "--user",
              "0:0",
              "--entrypoint",
              "node",
              base,
              "-e",
              script,
            ]);
            await fixture.startAttached(id);
          }
        },
      );
    },
    { receiptPath: process.env.OCC_RUNTIME_IMAGE_RECEIPT },
  );
});
