import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AgentRevision,
  RepositoryCredentialRuntimeBinding,
} from "../../../packages/contracts/src/index.ts";
import type { SessionStatus } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import type { RepositoryCredentialClientConfiguration } from "../../../apps/controller/src/drivers/repo/access/client-contracts.ts";
import { createHarnessConfiguration } from "../../helpers/harness-configuration.mjs";
import {
  repositoryMaterialDeployment,
  repositoryMaterialSpec,
} from "../../../apps/controller/src/drivers/compute/kubernetes/repository-material.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../../apps/controller/src/drivers/repo/github/access/client/config.ts";

function assertProjectionDescriptor<Manifest>(
  value: unknown,
  manifest: Manifest,
): asserts value is { sourceRoot: string; targetRoot: string; manifest: Manifest } {
  assert.ok(
    value !== null &&
      typeof value === "object" &&
      "sourceRoot" in value &&
      typeof value.sourceRoot === "string" &&
      "targetRoot" in value &&
      typeof value.targetRoot === "string" &&
      "manifest" in value,
    "the production init descriptor must carry both roots and a manifest",
  );
  assert.deepStrictEqual(value.manifest, manifest);
}

/**
 * Projects `count` new repository credential sessions into the existing `sourceRoot` the
 * way the kubelet publishes the production Secret volume. Each session's files come from
 * the real encoder. The returned descriptor is the one repositoryMaterialDeployment renders
 * for the init container, so it still names the in-Pod /run/oce roots: callers replace
 * sourceRoot and targetRoot with the paths where their run sees the projection and output.
 */
export async function projectRepositorySessions(
  sourceRoot: string,
  {
    client,
    deadlineWallMs,
    count = 1,
    publicCa,
  }: {
    client: RepositoryCredentialClientConfiguration;
    deadlineWallMs: number;
    count?: number;
    publicCa?: Uint8Array | undefined;
  },
) {
  const grant = { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" };
  const sessions = Array.from({ length: count }, (_, index): SessionStatus => ({
    sessionId: `session_material_${index}`,
    deadlineWallMs,
    state: "OPEN",
    binding: grant,
    activeUses: 0,
    cleanup: {
      active: 0,
      pending: 0,
      revoked: 0,
      expired: 0,
      uncertain: 0,
      auxiliaryPending: false,
    },
  }));
  const bindings = sessions.map(
    (session, index): Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }> => {
      return {
        kind: "new",
        repositoryRef: `repository-${index}`,
        sessionId: session.sessionId,
        deadlineWallMs,
        files: encodeRepositoryCredentialSessionFiles(
          {
            session,
            bearer: `controlled_gateway_bearer_${index}_0000000000000000000000`,
            client,
          },
          publicCa,
        ),
      };
    },
  );
  const revision: AgentRevision = {
    id: "revision-material",
    namespaceId: "namespace-material",
    agentId: "agent-material",
    revision: 1,
    backendId: null,
    configurationId: "configuration-material",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: createHarnessConfiguration("codex", "fixture"),
    gatewayManagedMode: false,
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    compute: { id: "kubernetes", implementation: "kubernetes" },
    harnessAuth: { method: "runtime" },
    servicePrincipalId: "service-principal-material",
    createdAt: new Date().toISOString(),
    executionAdmission: { version: 2, mode: "unprotected" },
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs,
      bindings: bindings.map(({ repositoryRef }) => ({
        repositoryRef,
        profile: "read",
        backendId: "github",
        grant,
      })),
    },
  };
  const spec = repositoryMaterialSpec(revision, bindings);
  assert.ok(spec);
  const resolvedBindings = spec.bindings.map((binding) => {
    assert.ok(binding.kind === "new");
    return binding;
  });
  const deployment = repositoryMaterialDeployment(
    { ...spec, bindings: resolvedBindings },
    "runtime-fixture:local",
  );
  const init = deployment.initContainers[0];
  assert.ok(init);
  const argument = [...(init.command ?? []), ...(init.args ?? [])].find((value) =>
    value.startsWith('{"sourceRoot"'),
  );
  assert.ok(argument, "the production init container must carry its material descriptor");
  const descriptor: unknown = JSON.parse(argument);
  assertProjectionDescriptor(descriptor, {
    version: 1,
    generation: spec.generation,
    bindings: resolvedBindings.map(
      ({ repositoryRef, sessionId, deadlineWallMs, directory, client }) => ({
        repositoryRef,
        sessionId,
        deadlineWallMs,
        directory,
        client,
      }),
    ),
  });

  // Kubernetes publishes a generation directory through ..data and symlinks each
  // top-level projected directory. Exercise those real symlinks, not flat files.
  const generation = join(sourceRoot, "..2026_projection");
  await mkdir(generation);
  await symlink(basename(generation), join(sourceRoot, "..data"));
  for (const [index, binding] of descriptor.manifest.bindings.entries()) {
    const directory = basename(binding.directory);
    await mkdir(join(generation, directory, "gh"), { recursive: true });
    const session = bindings[index];
    assert.ok(session);
    for (const [name, content] of Object.entries(session.files)) {
      await writeFile(join(generation, directory, name), content, { mode: 0o444 });
    }
    await symlink(`..data/${directory}`, join(sourceRoot, directory));
  }
  return { bindings, deployment, descriptor, generation, sessions };
}
