import { isDeepStrictEqual } from "node:util";
import type { KubernetesObject } from "@kubernetes/client-node";
import type {
  CredentialDeploymentConfiguration,
  SandboxHarnessStatus,
} from "@openclaw-enterprise/contracts";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";

export type LauncherStatus = {
  versions: Record<string, string>;
  released: boolean;
  challenge: string;
  configHash: string;
  policyHash: string;
};
export type Readiness = SandboxHarnessStatus & { readonly staged?: unknown };

/** Accept only a launcher receipt for the single admitted Source and measured inputs. */
export function launcherStatus(report: Readiness, source: string, policy: string, config: string) {
  let status: LauncherStatus | undefined;
  if (report.staged !== undefined) {
    const staged = asRecord(report.staged);
    const versions = asRecord(staged?.versions);
    if (
      !staged ||
      typeof staged.released !== "boolean" ||
      typeof staged.challenge !== "string" ||
      !/^[a-f0-9]{64}$/u.test(staged.challenge) ||
      staged.policyHash !== sha256Hex(policy) ||
      staged.configHash !== sha256Hex(config) ||
      !versions ||
      Object.keys(versions).length !== 1 ||
      !Object.hasOwn(versions, source) ||
      typeof versions[source] !== "string" ||
      !versions[source].length
    ) {
      throw new Error("Strands Box launcher did not attest the admitted configuration.");
    }
    status = {
      challenge: staged.challenge,
      released: staged.released,
      policyHash: staged.policyHash,
      configHash: staged.configHash,
      versions: { [source]: versions[source] },
    };
  }
  if (report.state === "failed" || (report.state === "serving" && !status?.released)) {
    throw new Error("Strands Box launcher is not held or released as expected.");
  }
  return status;
}

export function executionRelease(
  target: {
    name: string;
    namespace: string;
    labels: Readonly<Record<string, string>>;
    podName: string;
    podUid: string;
    configuration: CredentialDeploymentConfiguration;
  },
  status: LauncherStatus,
) {
  const { released: _released, ...receipt } = status;
  const release = {
    ...receipt,
    sandboxId: target.configuration.targetRef.sandboxId,
    configurationId: target.configuration.configurationId,
    podUid: target.podUid,
  };
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: target.name + "-release",
      namespace: target.namespace,
      labels: target.labels,
      ownerReferences: [
        { apiVersion: "v1", kind: "Pod", name: target.podName, uid: target.podUid },
      ],
    },
    immutable: true,
    data: { release: JSON.stringify(release) },
  };
}

export function verifyExecutionRelease(
  existing: KubernetesObject,
  resource: ReturnType<typeof executionRelease>,
) {
  const owner = existing.metadata?.ownerReferences?.[0];
  if (
    existing.metadata?.deletionTimestamp ||
    existing.metadata?.ownerReferences?.length !== 1 ||
    owner?.apiVersion !== "v1" ||
    owner.name !== resource.metadata.ownerReferences[0]!.name ||
    owner?.kind !== "Pod" ||
    owner.uid !== resource.metadata.ownerReferences[0]!.uid ||
    asRecord(existing)?.immutable !== true ||
    !isDeepStrictEqual(asRecord(existing)?.data, resource.data)
  ) {
    throw new Error("Strands Box release differs from the retained execution.");
  }
}
