import { isDeepStrictEqual } from "node:util";
import type { V1ConfigMap, V1Secret } from "@kubernetes/client-node";
import type {
  CredentialDeploymentConfiguration,
  CredentialDeploymentContext,
  CredentialDeploymentReadiness,
  CredentialDeploymentRef,
  CredentialProxyDriver,
  CredentialSourceReference,
  CredentialUpdateNotification,
  Namespace,
  ResolvedCredential,
} from "@openclaw-enterprise/contracts";
import {
  CredentialWithdrawalRefusedError,
  DependencyUnavailableError,
} from "@openclaw-enterprise/occ";
import { asRecord, numericErrorStatus } from "@openclaw-enterprise/utils";
import { withComputeAbortSignal } from "../compute/operation-context.ts";
import type { StrandsBoxSandboxDriver } from "../sandbox/strands-box.ts";

type CurrentVersion = (source: CredentialSourceReference, signal: AbortSignal) => Promise<string>;
type Target = Awaited<ReturnType<StrandsBoxSandboxDriver["stagedTarget"]>>;

function refuse(): never {
  throw new Error("Strands Box credential delivery does not match the admitted execution.");
}

function requireRetirement(): never {
  throw new CredentialWithdrawalRefusedError(
    "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT",
    "Stop the Strands Box execution before changing its static model credential.",
  );
}

function resource(target: Pick<Target, "name" | "namespace">) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: target.name + "-material", namespace: target.namespace },
  };
}

async function readMaterial(target: Pick<Target, "name" | "namespace" | "client">) {
  try {
    return await target.client.read<V1Secret>(resource(target));
  } catch (error) {
    if (numericErrorStatus(error) === 404) {
      return undefined;
    }
    throw new DependencyUnavailableError("Cannot inspect the Box credential projection.");
  }
}

function material(
  target: Target,
  expected: CredentialDeploymentConfiguration,
  sourceId: string,
  version: unknown,
  value: unknown,
) {
  if (
    typeof version !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,256}$/u.test(version) ||
    typeof value !== "string" ||
    !/^[!-~]{16,4096}$/u.test(value) ||
    value.startsWith("strands_box_")
  ) {
    refuse();
  }
  const payload = {
    sandboxId: expected.targetRef.sandboxId,
    configurationId: expected.configurationId,
    podUid: target.podUid,
    deliveries: [{ sourceId, version, value }],
  };
  const ref = resource(target);
  return {
    ...ref,
    metadata: {
      ...ref.metadata,
      labels: target.labels,
      ownerReferences: [
        { apiVersion: "v1", kind: "Pod", name: target.podName, uid: target.podUid },
      ],
    },
    type: "Opaque",
    immutable: true,
    data: { "material.json": Buffer.from(JSON.stringify(payload)).toString("base64") },
  };
}

// The immutable Pod-owned Secret records the intended version. Only a matching
// report from the pinned launcher confirms it received that version.
async function projectedVersion(
  context: CredentialDeploymentContext,
  expected: CredentialDeploymentConfiguration,
  target: Target,
) {
  const secret = await readMaterial(target);
  context.signal.throwIfAborted();
  if (!secret) {
    return undefined;
  }
  const sourceId = context.revision.credentialDeployment!.bindings[0]!.sourceRef.id;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(secret.data?.["material.json"] ?? "", "base64").toString());
  } catch {
    // The parser's error can contain secret bytes.
    refuse();
  }
  const deliveries = asRecord(payload)?.deliveries;
  const delivery = Array.isArray(deliveries) ? asRecord(deliveries[0]) : undefined;
  const version = delivery?.version;
  const desired = material(target, expected, sourceId, version, delivery?.value);
  const owner = secret.metadata?.ownerReferences?.[0];
  if (
    typeof version !== "string" ||
    secret.immutable !== true ||
    secret.type !== desired.type ||
    !secret.metadata?.uid ||
    secret.metadata.deletionTimestamp ||
    !isDeepStrictEqual(secret.metadata.labels, desired.metadata.labels) ||
    secret.metadata.ownerReferences?.length !== 1 ||
    owner?.apiVersion !== "v1" ||
    owner.kind !== "Pod" ||
    owner.name !== target.podName ||
    owner.uid !== target.podUid ||
    !isDeepStrictEqual(secret.data, desired.data) ||
    (target.status && target.status.versions[sourceId] !== version)
  ) {
    refuse();
  }
  return version;
}

export async function observedMaterialVersion(
  context: CredentialDeploymentContext,
  expected: CredentialDeploymentConfiguration,
  target: Target,
): Promise<string | undefined> {
  return target.status ? projectedVersion(context, expected, target) : undefined;
}

/** Delivery only. Stock Box handles authorized provider requests inside the Pod. */
export class StrandsBoxCredentialProxyDriver implements CredentialProxyDriver {
  readonly capability = "credential_proxy_delivery" as const;
  readonly id: string;
  readonly implementation: string;
  private readonly sandbox: StrandsBoxSandboxDriver;
  private currentVersion?: CurrentVersion;

  constructor(sandbox: StrandsBoxSandboxDriver) {
    if (!sandbox.agentResponsesGrant) {
      refuse();
    }
    this.sandbox = sandbox;
    this.id = sandbox.id;
    this.implementation = sandbox.implementation;
  }

  bindCurrentVersion(resolve: CurrentVersion) {
    this.currentVersion = resolve;
  }

  private requireDeployment(context: CredentialDeploymentContext, ref: CredentialDeploymentRef) {
    context.signal.throwIfAborted();
    const { namespace, revision } = context;
    if (
      revision.credentialDeployment?.proxyDriverId !== this.id ||
      !isDeepStrictEqual(ref, {
        namespaceId: namespace.id,
        agentId: revision.agentId,
        revisionId: revision.id,
      })
    ) {
      refuse();
    }
    return this.sandbox.harnessResource(context);
  }

  async deployProxy(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["deployProxy"]>[1],
  ) {
    this.requireDeployment(context, input.deployment);
    this.sandbox.requireStaged(context);
    const policy = context.revision.credentialDeployment!;
    if (
      !isDeepStrictEqual(input.networkAccessPolicy, policy.networkAccessPolicy) ||
      !isDeepStrictEqual(input.injectionPolicies, policy.injectionPolicies)
    ) {
      refuse();
    }
    return {};
  }

  async configureDeployment(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["configureDeployment"]>[1],
  ) {
    const policy = context.revision.credentialDeployment;
    const supplied = input.bindings[0];
    if (
      !policy ||
      !supplied ||
      input.bindings.length !== 1 ||
      supplied.sharedProviderRef !== undefined ||
      !isDeepStrictEqual(supplied.binding, policy.bindings[0]) ||
      !isDeepStrictEqual(input.injectionPolicies, policy.injectionPolicies)
    ) {
      refuse();
    }
    const { binding } = supplied;
    const target = await this.sandbox.stagedTarget(context, input);
    if (!(await projectedVersion(context, input, target))) {
      if (target.status) {
        refuse();
      }
      const resolved = await supplied.resolveCredential();
      if (resolved.expiresAt !== undefined) {
        refuse();
      }
      const secret = material(
        target,
        input,
        binding.sourceRef.id,
        resolved.version,
        resolved.credential,
      );
      const current = await this.sandbox.stagedTarget(context, input);
      if (current.podUid !== target.podUid || current.status) {
        refuse();
      }
      context.signal.throwIfAborted();
      try {
        await target.client.create(secret);
      } catch {
        // Never forward a Secret-bearing SDK error or overwrite a concurrent
        // delivery. Reconcile a lost acknowledgement against immutable state.
        if ((await projectedVersion(context, input, target)) !== resolved.version) {
          throw new DependencyUnavailableError("Cannot confirm the Box credential projection.");
        }
      }
    }
    return {
      credentialProjections: [
        {
          bindingRef: binding.bindingRef,
          environment: binding.projection.environment,
          placeholder: { kind: "runtime" as const },
        },
      ],
    };
  }

  async getDeploymentStatus(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
  ): Promise<CredentialDeploymentReadiness> {
    const target = await this.sandbox.stagedTarget(context, expected);
    const version = await observedMaterialVersion(context, expected, target);
    if (!version) {
      return { state: "pending" };
    }
    if (!this.currentVersion) {
      throw new DependencyUnavailableError("Strands Box needs the selected TokenService.");
    }
    const source = context.revision.credentialDeployment!.bindings[0]!.sourceRef;
    const current = await this.currentVersion(source, context.signal);
    context.signal.throwIfAborted();
    return version === current
      ? { state: "ready" }
      : { state: "failed", code: "CREDENTIAL_SOURCE_VERSION_CHANGED" };
  }

  async removeDeployment(
    context: CredentialDeploymentContext,
    input: Parameters<CredentialProxyDriver["removeDeployment"]>[1],
  ) {
    if ("unboundDeployment" in input) {
      this.requireDeployment(context, input.unboundDeployment);
      return;
    }
    const { sandboxId, ...deployment } = input.targetRef;
    const ref = this.requireDeployment(context, deployment);
    if (!sandboxId) {
      refuse();
    }
    if (input.bindingRefs !== undefined) {
      if (
        !isDeepStrictEqual(
          input.bindingRefs,
          context.revision.credentialDeployment!.bindings.map((b) => b.bindingRef),
        )
      ) {
        refuse();
      }
      requireRetirement();
    }
    // Compute stops the Sandbox first. Its teardown fences the Pod and removes
    // the projection. This path cannot delete material belonging to a successor.
    const scope = await this.sandbox.stagedScope(context.namespace.id);
    if (
      ref.namespaceName !== scope.namespace ||
      (await readMaterial({ ...scope, name: ref.resourceName }))
    ) {
      refuse();
    }
  }

  async retireSource(
    namespace: Readonly<Namespace>,
    source: CredentialSourceReference,
    signal: AbortSignal,
  ) {
    if (namespace.id !== source.namespaceId) {
      refuse();
    }
    await this.requireSourceUnused(source, signal);
  }

  async notifyCredentialUpdated(
    notification: CredentialUpdateNotification,
    _resolve: () => Promise<ResolvedCredential>,
    signal: AbortSignal,
  ) {
    await this.requireSourceUnused(notification.sourceRef, signal);
  }

  async requireSourceUnused(source: CredentialSourceReference, signal: AbortSignal) {
    signal.throwIfAborted();
    if (source.kind !== "credential_source" || !source.id) {
      refuse();
    }
    const scope = await this.sandbox.stagedScope(source.namespaceId);
    // Immutable workload inputs precede resolution and outlive delivery.
    // Refuse updates even while a copy is being staged. No Secret list grant.
    const selector = Object.entries(scope.labels)
      .map(([k, v]) => k + "=" + v)
      .join(",");
    const copies = await withComputeAbortSignal(signal, () =>
      scope.client.list<V1ConfigMap>(
        "v1",
        "ConfigMap",
        scope.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        selector,
      ),
    );
    signal.throwIfAborted();
    if (copies.metadata?._continue) {
      refuse();
    }
    const names = new Set(copies.items.map((item) => item.metadata?.name));
    for (const copy of copies.items) {
      const name = copy.metadata?.name;
      const base = name?.replace(/-(listener|release)$/u, "");
      if (!base || !names.has(base)) {
        refuse();
      }
      if (name !== base) {
        continue;
      }
      const manifest = copy.data?.["workload.json"];
      if (!manifest) {
        refuse();
      }
      if (asRecord(asRecord(JSON.parse(manifest))?.stockStaged)?.sourceId === source.id) {
        requireRetirement();
      }
    }
  }
}
