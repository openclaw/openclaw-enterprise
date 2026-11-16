import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeCommand } from "../helpers/fake-commands.ts";
import {
  cleanupPath,
  createK3dClusterResource,
  fixture,
  repositoryRoot,
  runCleanup,
  writeState,
} from "./ci-cleanup-fixture.ts";
import { registerImageCustodyCases } from "./ci-cleanup-image-cases.ts";
import {
  registerBoundK3dCases,
  registerK3dDirectoryCase,
  registerK3dRemovalCases,
} from "./ci-cleanup-k3d-cases.ts";
import {
  registerChildJournalCases,
  registerPostgresAdminCases,
  registerPostgresResourceCases,
  registerRoutingResetCase,
} from "./ci-cleanup-postgres-cases.ts";
import {
  registerCommandOwnershipCases,
  registerInheritedOutputCases,
  registerInheritedPipeCases,
} from "./ci-cleanup-process-cases.ts";

const processCaseInputs = { repositoryRoot, cleanupPath, fixture, writeState, runCleanup };

registerRoutingResetCase();
registerK3dRemovalCases();
registerPostgresResourceCases();
registerInheritedOutputCases(processCaseInputs);
registerPostgresAdminCases();
registerInheritedPipeCases(processCaseInputs);
registerK3dDirectoryCase();

test("cleanup rejects ownerless resources before invoking cleanup commands", async (t) => {
  const root = await fixture(t);
  const clusterName = "openclaw-k8s-ownerless-cluster-abcdef123456";
  const clusterDirectory = join(root, `${clusterName}-state`);
  const k3dLog = join(root, "k3d.log");
  const cluster = await createK3dClusterResource({ name: clusterName }, clusterDirectory);
  await writeCommand(join(root, "bin"), "k3d", "exit 0\n", { log: k3dLog });

  const statePath = join(root, "state.json");
  const state = {
    version: 1,
    repositoryRoot,
    prefix: "openclaw-ci-local-abcdef1234567890",
    resources: [cluster],
  };
  await writeState(statePath, state);

  const result = runCleanup(statePath, {
    OPENCLAW_CI_K3D_BIN: join(root, "bin/k3d"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /another prefix: undefined/);
  const retainedState: unknown = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(retainedState, state);
  await assert.rejects(() => stat(k3dLog), { code: "ENOENT" });
  assert.equal((await stat(clusterDirectory)).isDirectory(), true);
});

registerCommandOwnershipCases(processCaseInputs);
registerImageCustodyCases();
registerBoundK3dCases();
registerChildJournalCases();
