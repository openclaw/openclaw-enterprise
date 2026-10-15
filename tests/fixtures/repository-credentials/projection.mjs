import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  repositoryMaterialDeployment,
  repositoryMaterialSpec,
} from "../../../apps/controller/src/drivers/compute/kubernetes/repository-material.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";

/**
 * Projects `count` new repository credential sessions into the existing `sourceRoot` the
 * way the kubelet publishes the production Secret volume. Each session's files come from
 * the real encoder. The returned descriptor is the one repositoryMaterialDeployment renders
 * for the init container, so it still names the in-Pod /run/oce roots: callers replace
 * sourceRoot and targetRoot with the paths where their run sees the projection and output.
 */
export async function projectRepositorySessions(
  sourceRoot,
  { client, deadlineWallMs, count = 1, publicCa },
) {
  const bindings = Array.from({ length: count }, (_, index) => {
    const sessionId = `session_material_${index}`;
    return {
      kind: "new",
      repositoryRef: `repository-${index}`,
      sessionId,
      deadlineWallMs,
      files: encodeRepositoryCredentialSessionFiles(
        {
          session: { sessionId, deadlineWallMs },
          bearer: `controlled_gateway_bearer_${index}_0000000000000000000000`,
          client,
        },
        publicCa,
      ),
    };
  });
  const revision = {
    id: "revision-material",
    namespaceId: "namespace-material",
    agentId: "agent-material",
    repositoryCredentials: {
      driver: { id: "repository-credentials", implementation: "repository-credentials" },
      deadlineWallMs,
      bindings: bindings.map(({ repositoryRef }) => ({
        repositoryRef,
        profile: "read",
        backendId: "github",
        grant: { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" },
      })),
    },
  };
  const deployment = repositoryMaterialDeployment(
    repositoryMaterialSpec(revision, bindings),
    "runtime-fixture:local",
  );
  const argument = [
    ...(deployment.initContainers[0].command ?? []),
    ...(deployment.initContainers[0].args ?? []),
  ].find((value) => value.startsWith('{"sourceRoot"'));
  assert.ok(argument, "the production init container must carry its material descriptor");
  const descriptor = JSON.parse(argument);

  // Kubernetes publishes a generation directory through ..data and symlinks each
  // top-level projected directory. Exercise those real symlinks, not flat files.
  const generation = join(sourceRoot, "..2026_projection");
  await mkdir(generation);
  await symlink(basename(generation), join(sourceRoot, "..data"));
  for (const [index, binding] of descriptor.manifest.bindings.entries()) {
    const directory = basename(binding.directory);
    await mkdir(join(generation, directory, "gh"), { recursive: true });
    for (const [name, content] of Object.entries(bindings[index].files)) {
      await writeFile(join(generation, directory, name), content, { mode: 0o444 });
    }
    await symlink(`..data/${directory}`, join(sourceRoot, directory));
  }
  return { bindings, deployment, descriptor, generation };
}
