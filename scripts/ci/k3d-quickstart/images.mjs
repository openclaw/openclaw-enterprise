import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadRuntimeArtifact, runtimeArtifactSelection } from "../runtime-artifact.ts";

const selection = runtimeArtifactSelection(process.env);
assert.ok(selection, "The quickstart requires its same-run runtime artifact.");
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/);
assert.ok(process.env.GITHUB_ENV, "GitHub Actions environment output is required.");
const owner = `${selection.runId}-${process.env.GITHUB_RUN_ATTEMPT}`;
const runtimeTag = `localhost/oce-quickstart/runtime:${owner}`;
const controllerTag = `localhost/oce-quickstart/controller:${owner}`;
const deadline = Date.now() + 30 * 60_000;

function docker(args, { capture = false, timeoutMs = 120_000 } = {}) {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, "Quickstart image preparation exceeded its deadline.");
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: Math.min(remaining, timeoutMs),
  });
}

const runtime = await loadRuntimeArtifact(
  { ...selection, tag: runtimeTag },
  Date.now() + 10 * 60_000,
);
try {
  const manifest = JSON.parse(
    await readFile(new URL("../test-suites/images-packaging.json", import.meta.url), "utf8"),
  );
  const nodeBase = manifest.prepare.defaultEnv.NODE_BASE_IMAGE;
  assert.match(nodeBase, /@sha256:[a-f0-9]{64}$/);
  docker(
    [
      "buildx",
      "build",
      "--load",
      "--provenance=false",
      "--sbom=false",
      "--target",
      "runtime",
      "--build-arg",
      `NODE_BASE_IMAGE=${nodeBase}`,
      "--build-arg",
      `OCC_BUILD_REVISION=${selection.sourceSha}`,
      "--label",
      `org.opencontainers.image.revision=${selection.sourceSha}`,
      "--tag",
      controllerTag,
      ".",
    ],
    { timeoutMs: 20 * 60_000 },
  );

  // A loopback registry records real RepoDigests on both legacy and containerd
  // Docker stores. The launcher requires a complete, immutable, source-matched pair.
  const registry = docker(
    [
      "run",
      "--detach",
      "--name",
      `oce-quickstart-images-${owner}`,
      "--label",
      `openclaw.dev/quickstart-image-owner=${owner}`,
      "--publish",
      "127.0.0.1::5000",
      "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
    ],
    { capture: true, timeoutMs: 300_000 },
  ).trim();
  assert.match(registry, /^[a-f0-9]{64}$/);
  const [container] = JSON.parse(docker(["inspect", registry], { capture: true }));
  const bindings = container.NetworkSettings.Ports["5000/tcp"];
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
  const port = Number(bindings[0].HostPort);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const endpoint = `127.0.0.1:${port}`;
  const readyDeadline = Math.min(deadline, Date.now() + 30_000);
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      ready = (await fetch(`http://${endpoint}/v2/`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      ready = false;
    }
    if (ready) {
      break;
    }
    await delay(250);
  }
  assert.ok(ready, "The run-owned loopback registry did not become ready.");

  const references = {};
  for (const [role, image] of [
    ["controller", controllerTag],
    ["runtime", runtimeTag],
  ]) {
    const repository = `${endpoint}/oce-${role}`;
    const tag = `${repository}:${owner}`;
    docker(["tag", image, tag]);
    docker(["push", tag], { timeoutMs: 300_000 });
    const [pushed] = JSON.parse(docker(["image", "inspect", tag], { capture: true }));
    const digests = pushed.RepoDigests.filter((value) => value.startsWith(`${repository}@`));
    assert.equal(digests.length, 1);
    assert.match(digests[0], /@sha256:[a-f0-9]{64}$/);
    const [selected] = JSON.parse(docker(["image", "inspect", digests[0]], { capture: true }));
    assert.equal(selected.Config.Labels["org.opencontainers.image.revision"], selection.sourceSha);
    references[role] = digests[0];
  }
  // Export neither selection until both immutable references resolve locally.
  await appendFile(
    process.env.GITHUB_ENV,
    `OCC_DEVELOPMENT_CONTROLLER_IMAGE=${references.controller}\nOCC_KUBERNETES_RUNTIME_IMAGE=${references.runtime}\n`,
  );
  process.stdout.write(`${JSON.stringify({ sourceSha: selection.sourceSha, ...references })}\n`);
} finally {
  await runtime.cleanup();
}
