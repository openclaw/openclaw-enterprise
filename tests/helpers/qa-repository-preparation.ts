import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import type { KubernetesWorkloadPeer } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { allowsPushRef } from "../../apps/controller/src/drivers/repo/access/client-contracts.ts";
import type { ServiceConfig } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type {
  GitHubRepositoryRegistration,
  GitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  REPOSITORY_CONTROL_SOCKET,
  REPOSITORY_PUBLIC_CA_PATH,
  REPOSITORY_REGISTRY_PATH,
  preparedRepositoryBackend,
  preparedRepositoryInstallation,
} from "../../scripts/lib/prepared-repository-installation.ts";
import { protectedText } from "./qa-secrets.ts";

type RegistrySettings = Pick<GitHubRepositoryRegistry, "backendId" | "maximumDurationSeconds">;

interface QaNamespacePolicy {
  namespaceId?: unknown;
  profiles?: unknown;
  transport?: unknown;
  pushRefAllowlist?: unknown;
  pullRequestBase?: unknown;
  draftPullLimit?: unknown;
}

interface QaRepositoryRegistration extends Pick<
  GitHubRepositoryRegistration,
  "repositoryRef" | "repository"
> {
  namespaces: QaNamespacePolicy[];
}

interface QaRepositoryRegistry extends RegistrySettings {
  repositories: QaRepositoryRegistration[];
}

interface QaRepositoryInstallation {
  backend?: ReturnType<typeof preparedRepositoryBackend>[];
  repository?: ReturnType<typeof preparedRepositoryInstallation>;
  drivers: {
    repo?: unknown;
    compute: {
      configuration: {
        network: {
          repositoryCredentials?: KubernetesWorkloadPeer & { port: number };
          [setting: string]: unknown;
        };
      };
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isQaRepositoryRegistration(value: unknown): value is QaRepositoryRegistration {
  return (
    isRecord(value) &&
    typeof value.repositoryRef === "string" &&
    typeof value.repository === "string" &&
    Array.isArray(value.namespaces) &&
    value.namespaces.every(isRecord)
  );
}

function isQaRepositoryRegistry(value: unknown): value is QaRepositoryRegistry {
  return (
    isRecord(value) &&
    typeof value.backendId === "string" &&
    typeof value.maximumDurationSeconds === "number" &&
    Array.isArray(value.repositories) &&
    value.repositories.every(isQaRepositoryRegistration)
  );
}

// Keep the operator's mutable wire object, including fields that the startup loaders own.
export async function readQaRepositoryRegistry(input: string): Promise<QaRepositoryRegistry> {
  const registry: unknown = JSON.parse(
    await protectedText(join(input, "registry.json"), "repository registry"),
  );
  assert.ok(isQaRepositoryRegistry(registry), "invalid QA repository registry");
  return registry;
}

function selectQaRepository(
  registry: QaRepositoryRegistry,
  message: string,
): QaRepositoryRegistration {
  assert.equal(registry.repositories.length, 1, message);
  const [entry] = registry.repositories;
  assert.ok(entry, message);
  return entry;
}

/** The one run-owned branch that every repository scenario of a QA run may push. */
export function qaRepositoryBranch(suffix: string): `oce-qa-${string}` {
  return `oce-qa-${suffix}`;
}

/** Narrow an existing operator write grant to the exact ref the prepared Git worker serves. */
export function grantQaRepositoryBranch(
  registry: QaRepositoryRegistry,
  suffix: string,
): QaRepositoryRegistry {
  const entry = selectQaRepository(registry, "select exactly one authorized repository");
  const ref = `refs/heads/${qaRepositoryBranch(suffix)}`;
  for (const policy of entry.namespaces) {
    const { profiles, pushRefAllowlist } = policy;
    assert.ok(
      Array.isArray(profiles) &&
        profiles.some((profile: unknown) => profile === "git-write" || profile === "git-full"),
      "selected registry must already grant git-write or git-full",
    );
    if (pushRefAllowlist) {
      assert.ok(
        Array.isArray(pushRefAllowlist) &&
          pushRefAllowlist.some((candidate: unknown) => {
            assert.ok(typeof candidate === "string", "selected registry must list Git refs");
            return allowsPushRef([candidate], ref);
          }),
        "selected registry must authorize the run-owned branch name",
      );
    }
    policy.profiles = ["git-write"];
    policy.transport = "git-only";
    policy.pushRefAllowlist = [ref];
    delete policy.pullRequestBase;
    delete policy.draftPullLimit;
  }
  return registry;
}

export function selectPreparedQaRepository(
  registry: QaRepositoryRegistry,
  suffix: string,
): QaRepositoryRegistration {
  const entry = selectQaRepository(registry, "select exactly one authorized disposable repository");
  const [policy] = entry.namespaces;
  // createQaInstallation writes these values through grantQaRepositoryBranch.
  assert.ok(policy, "prepared QA repository must have a namespace policy");
  assert.deepEqual(policy.profiles, ["git-write"]);
  assert.deepEqual(policy.pushRefAllowlist, [`refs/heads/${qaRepositoryBranch(suffix)}`]);
  return entry;
}

/** The repository service sends native Git and holds no App key. */
export function qaRepositoryServiceConfig(registry: RegistrySettings, host: string) {
  return {
    gateway: {
      listen: "0.0.0.0:8443",
      publicOrigin: `https://${host}`,
      controlSocket: REPOSITORY_CONTROL_SOCKET,
      tlsCertFile: REPOSITORY_PUBLIC_CA_PATH,
      tlsKeyFile: "/etc/openclaw/repository-inputs/tls.key",
    } satisfies ServiceConfig["gateway"] & { tlsCertFile: string; tlsKeyFile: string },
    sessionPolicy: {
      maximumDurationSeconds: registry.maximumDurationSeconds,
      defaultProfile: "git-write" as const,
      allowedProfiles: ["git-write"] satisfies ["git-write"],
    } satisfies ServiceConfig["sessionPolicy"],
    backend: {
      kind: "github-prepared-git-registry" as const,
      backendId: registry.backendId,
      registryFile: REPOSITORY_REGISTRY_PATH,
    },
  };
}

/** Point the Installation at the Compose repository service through the relay. */
export function applyQaRepositoryInstallation(
  configuration: QaRepositoryInstallation,
  registry: RegistrySettings,
  podLabels: KubernetesWorkloadPeer["podLabels"],
): QaRepositoryInstallation {
  configuration.backend = [preparedRepositoryBackend({ backendId: registry.backendId })];
  delete configuration.drivers.repo;
  configuration.repository = preparedRepositoryInstallation({
    sessionDurationSeconds: registry.maximumDurationSeconds,
  });
  configuration.drivers.compute.configuration.network.repositoryCredentials = {
    namespace: "oce-system",
    podLabels,
    port: 8443,
  };
  return configuration;
}

// The hosted selector and launcher validate the public GitHub source. Check the local
// CIDRs before DNS or exec, then share subnet containment across both preflights.
export async function readQaRepositoryUpstreamPolicy(input: string) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(input, "upstream-cidrs.json"), "utf8"));
  } catch {
    throw new Error("repository egress input must contain valid JSON");
  }
  const explicit = Array.isArray(value);
  const ranges: unknown = explicit ? value : isRecord(value) ? value.githubApiAndGit : undefined;
  assert.ok(Array.isArray(ranges) && ranges.length > 0, "repository egress requires IPv4 CIDRs");
  const approved = new BlockList();
  const cidrs = ranges.map((cidr: unknown) => {
    assert.ok(typeof cidr === "string", "repository egress requires canonical IPv4 CIDRs");
    const [address, prefix, extra] = cidr.split("/");
    assert.ok(
      address !== undefined &&
        prefix !== undefined &&
        isIP(address) === 4 &&
        /^(?:[1-9]|[12][0-9]|3[0-2])$/.test(prefix) &&
        extra === undefined,
      "repository egress requires canonical IPv4 CIDRs",
    );
    const bits = Number(prefix);
    const numeric = address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
    assert.equal(numeric % 2 ** (32 - bits), 0, "repository egress CIDR must be a network address");
    assert.ok(!explicit || bits === 32, "explicit repository endpoints require IPv4 /32 addresses");
    approved.addSubnet(address, bits, "ipv4");
    return cidr;
  });
  return { cidrs, approved };
}
