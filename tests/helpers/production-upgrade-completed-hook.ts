import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asRecord } from "../../packages/utils/src/index.ts";
import { assertHelmIntent } from "./production-upgrade-recovery-evidence.ts";
import type { RecoveryFixture } from "./production-upgrade-recovery-fixture.ts";
import { renderedDocuments, yamlFile } from "./production-upgrade-recovery-render.ts";
import { field, list, record, type RecoveryState } from "./production-upgrade-recovery-state.ts";
import { injectedFault } from "./production-upgrade-recovery-tools.ts";

export const recoverHelm = [
  "--resume",
  "--recover-helm",
  "--migration-history-checked",
  "--recovery-reviewed",
] as const;

// The controlled server records the accepted attempt before losing the reply.
// Helm still reports Running while Kubernetes reports the owned Job complete.
export async function loseHelmResponseWithCompletedHook(
  f: Pick<
    RecoveryFixture,
    "failNext" | "run" | "state" | "evidence" | "readEvidence" | "directory"
  >,
  run: (...args: string[]) => Promise<unknown> = f.run,
) {
  await f.failNext("lost-helm-response");
  await assert.rejects(run(), injectedFault);
  const intent = await assertHelmIntent(f, 1, 2);
  const directory = join(f.evidence, "helm-attempts", intent.attempt.nonce);
  const docs = renderedDocuments(await readFile(join(directory, "rendered.yaml"), "utf8"));
  const hook = docs.find((doc) => field(doc, "kind") === "Job");
  assert.ok(hook, "expected the rendered initializer Job");
  const hookName = field(field(hook, "metadata"), "name");
  const template = asRecord(asRecord(field(hook, "spec"))?.template);
  const podMetadata = asRecord(template?.metadata);
  const podSpec = asRecord(template?.spec);
  assert.ok(podMetadata && podSpec, "expected the initializer Job Pod template");
  const initContainerStatuses = list(podSpec.initContainers, "initializer init containers").map(
    (container) => {
      const name = asRecord(container)?.name;
      assert.equal(typeof name, "string", "expected the rendered init container name");
      return { name, state: { terminated: { exitCode: 0 } } };
    },
  );
  const state = await f.state();
  const recoveryRelease = {
    name: state.release,
    namespace: "system",
    version: 2,
    config: await yamlFile(join(directory, "values.yaml")),
    manifest: docs
      .filter((doc) => doc !== hook)
      .map((doc) => JSON.stringify(doc))
      .join("\n---\n"),
    hooks: [
      {
        name: hookName,
        manifest: JSON.stringify(hook),
        events: ["pre-install", "pre-upgrade"],
        last_run: { phase: "Running" },
      },
    ],
    info: { status: "pending-upgrade" },
  };
  const recoveryResources: Record<string, unknown> = Object.fromEntries(
    docs.map((desired) => {
      const snapshot = record(structuredClone(desired), "rendered recovery resource");
      const { kind } = snapshot;
      const metadata = record(snapshot.metadata, "rendered recovery metadata");
      const { name } = metadata;
      assert.ok(typeof kind === "string", "expected the kind of the rendered recovery resource");
      assert.ok(typeof name === "string", "expected the name of the rendered recovery resource");
      const component = name.endsWith("api") ? "api" : "worker";
      Object.assign(metadata, {
        namespace: "system",
        resourceVersion: "1",
        uid: kind === "Job" ? "initializer-job" : `${component}-deployment-uid`,
      });
      if (kind === "Job") {
        snapshot.status = { conditions: [{ type: "Complete", status: "True" }], succeeded: 1 };
      } else {
        metadata.annotations = {
          "meta.helm.sh/release-name": state.release,
          "meta.helm.sh/release-namespace": "system",
        };
      }
      return [`${kind}/${name}`, snapshot];
    }),
  );
  const owner = {
    apiVersion: "batch/v1",
    kind: "Job",
    name: hookName,
    uid: "initializer-job",
    controller: true,
  };
  const recoveryPod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...structuredClone(podMetadata),
      name: "initializer-pod",
      namespace: "system",
      uid: "initializer-pod-uid",
      resourceVersion: "1",
      ownerReferences: [owner],
    },
    spec: structuredClone(podSpec),
    status: {
      phase: "Succeeded",
      initContainerStatuses,
      containerStatuses: [{ name: "bootstrap", state: { terminated: { exitCode: 0 } } }],
    },
  };
  // Both simulated Kubernetes read paths must see the same Pod mutations.
  recoveryResources["Pod/initializer-pod"] = recoveryPod;
  const interrupted: RecoveryState & {
    recoveryRelease: typeof recoveryRelease;
    recoveryResources: typeof recoveryResources;
    recoveryPod: typeof recoveryPod;
  } = {
    ...state,
    helmStatus: "pending-upgrade",
    recoveryRelease,
    recoveryResources,
    recoveryPod,
  };
  await writeFile(join(f.directory, "state.json"), JSON.stringify(interrupted));
  return interrupted;
}
