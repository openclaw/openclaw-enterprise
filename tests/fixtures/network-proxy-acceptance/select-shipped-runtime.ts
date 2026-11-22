import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  boundedImageCommand,
  createK3dImageAdmission,
  immutableDigest,
  selectNativeSourceImage,
} from "../../../scripts/ci/k3d-image-admission.ts";
import { createK3dNodeImages } from "../../../scripts/ci/k3d-node-images.ts";
import type {
  PreparationJournal,
  PreparationResource,
  PreparationState,
} from "../../../scripts/ci/k3d-preparation.ts";
import { execFile } from "../../../scripts/ci/prepare-command.ts";

const repository = "ghcr.io/openclaw/openclaw-enterprise-runtime";
const index = `${repository}@sha256:05247b40b16fd6f1154198d783f35b06c7313444858dc7603802e7f62365e2f8`;
const manifest = "sha256:6d2af2efbc2e0ceb8435e5dfe4bcb22b2dd38d09fd31c1374652d4094adb432e";
const config = "sha256:e4c1426181a2bf471688d7e85041f041926631187e8596f3a48c86bdb6b07a10";
const selection = { platform: "linux/amd64", configDigest: config, cacheIndex: index };

type Configuration = {
  drivers: {
    compute: {
      configuration: {
        images: { gateway: string; agent: string; requireImmutableDigest: boolean };
        runtime: { codexSeccompProfile?: string };
      };
    };
  };
};
type Fixture = {
  state: { cluster: string };
  stateDirectory: string;
  configuration: Configuration;
  resources: { after(cleanup: () => Promise<void>): void };
  kubectl(...args: string[]): Promise<string>;
  run(binary: string, args: string[], options?: { timeout?: number }): Promise<string>;
  saveInstallation(configuration: Configuration): Promise<void>;
  record(name: string, value: unknown): Promise<string>;
  pod(
    agent: unknown,
    role: "gateway" | "agent",
  ): Promise<{
    spec: { containers: { name: string; image: string }[] };
    status: { containerStatuses: { name: string; ready: boolean; imageID: string }[] };
  }>;
};

/** Admit the published child into this QA-owned cluster, then use the normal Installation update. */
export async function selectShippedRuntime(f: Fixture): Promise<void> {
  const cluster = f.state.cluster;
  assert.match(cluster, /^occ-dev-qa-k-[a-f0-9]{8}$/u);
  const nodes = JSON.parse(await f.kubectl("get", "nodes", "-o", "json")).items;
  assert.ok(
    Array.isArray(nodes) &&
      nodes.length === 1 &&
      nodes[0].status.nodeInfo.operatingSystem === "linux" &&
      nodes[0].status.nodeInfo.architecture === "amd64" &&
      nodes[0].metadata.name === `k3d-${cluster}-server-0`,
    "QA node platform or ownership is invalid",
  );
  const journalDirectory = process.env.OCC_TEST_ACCEPTANCE_IMAGE_JOURNAL_DIR;
  assert.ok(
    journalDirectory && isAbsolute(journalDirectory),
    "QA-owned image journal directory is missing",
  );
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const statePath = join(journalDirectory, `${cluster}.json`);
  const state: PreparationState & { hostImageId?: string } = {
    lane: "slack",
    prefix: `network-proxy-${cluster}`,
    resources: [],
  };
  const journal: PreparationJournal = {
    addResource(target, kind, details) {
      const resource = {
        id: randomUUID(),
        kind,
        owner: target.prefix,
        status: "pending",
        createdAt: new Date().toISOString(),
        ...details,
      };
      target.resources.push(resource);
      return resource;
    },
    async writeState(path, target) {
      await writeFile(path, JSON.stringify(target), { mode: 0o600 });
    },
    async markResourceReady(path, target, resource) {
      resource.status = "ready";
      resource.readyAt = new Date().toISOString();
      await journal.writeState(path, target);
    },
  };
  const nodeImages = createK3dNodeImages({
    execFile,
    boundedImageCommand,
    immutableDigest,
    progress: () => {},
    timedPreparation: (_lane, _phase, work) => work(),
  });
  const admission = createK3dImageAdmission(journal, nodeImages, new Set());
  const native = `${repository}@${manifest}`;
  const host = await selectNativeSourceImage(
    native,
    selection,
    "QA shipped runtime",
    "pull-if-missing",
  );
  state.hostImageId = host.hostImageId;
  await journal.writeState(statePath, state);
  const removeHostTags = async () => {
    for (const resource of state.resources as (PreparationResource & { name?: string })[]) {
      if (resource.kind !== "image-tag" || !resource.name) {
        continue;
      }
      const current = await f
        .run("docker", ["image", "inspect", "--format", "{{.Id}}", resource.name])
        .catch(() => undefined);
      if (current?.trim() === host.hostImageId) {
        await f.run("docker", ["image", "rm", resource.name]);
      }
    }
  };
  f.resources.after(removeHostTags);
  try {
    const admitted = await admission.registerImageInK3d(
      statePath,
      state,
      { name: cluster, nodes: [nodes[0].metadata.name] },
      native,
      "QA shipped runtime",
      selection,
    );
    assert.ok(
      admitted.reference.endsWith(`@${manifest}`) && admitted.hostImageId === host.hostImageId,
      "QA admitted runtime identity changed",
    );
    const qualification = JSON.parse(
      await f.run(
        "node",
        [
          "scripts/prepare-development-codex-seccomp.ts",
          f.stateDirectory,
          admitted.reference,
          "120",
        ],
        { timeout: 300_000 },
      ),
    );
    assert.ok(
      qualification.mode === "Localhost" &&
        typeof qualification.profileName === "string" &&
        qualification.profileName.length > 0,
      "Published QA runtime did not pass custom Codex sandbox qualification",
    );
    const next = structuredClone(f.configuration);
    assert.equal(next.drivers.compute.configuration.images.requireImmutableDigest, true);
    next.drivers.compute.configuration.images.gateway = admitted.reference;
    next.drivers.compute.configuration.images.agent = admitted.reference;
    next.drivers.compute.configuration.runtime.codexSeccompProfile = qualification.profileName;
    await f.saveInstallation(next);
    await f.record("network-proxy-shipped-runtime", {
      platform: selection.platform,
      manifest,
      config,
      reference: admitted.reference,
      criRepoDigestAndPinQualified: true,
      sandboxMode: qualification.mode,
      profile: qualification.profileName,
    });
  } finally {
    await removeHostTags();
  }
}

export async function assertShippedPods(f: Fixture, agent: unknown): Promise<void> {
  const images = f.configuration.drivers.compute.configuration.images;
  assert.ok(
    images.requireImmutableDigest &&
      images.gateway === images.agent &&
      images.gateway.endsWith(`@${manifest}`),
    "QA workload image selection lost the shipped native manifest",
  );
  const observations = [];
  for (const role of ["gateway", "agent"] as const) {
    const pod = await f.pod(agent, role);
    const container = pod.spec.containers.find((item) => item.name === role);
    const status = pod.status.containerStatuses.find((item) => item.name === role);
    assert.ok(
      container?.image === images.gateway &&
        status?.ready === true &&
        typeof status.imageID === "string" &&
        [manifest, config].some((digest) => status.imageID.endsWith(digest)),
      "A running QA Gateway or Harness does not match the qualified shipped runtime",
    );
    observations.push({ role, image: container.image, imageID: status.imageID });
  }
  const revision = (agent as { revision: { id: string } }).revision.id;
  assert.match(revision, /^rev_[a-f0-9-]+$/u);
  await f.record(`network-proxy-shipped-pods-${revision}`, observations);
}
