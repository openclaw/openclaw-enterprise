import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { DependencyUnavailableError, TransientDependencyError } from "@openclaw-enterprise/occ";
import type {
  SandboxHarnessContext,
  SandboxNamespaceContext,
} from "@openclaw-enterprise/contracts";
import { digest, record, type Execution, type Owner } from "./control.ts";

export interface RelayOptions {
  readonly image: string;
  readonly hostAddress: string;
  readonly installation: string;
  readonly workerPeer: {
    readonly namespace: string;
    readonly podLabels: Readonly<Record<string, string>>;
  };
}

const INSTANCE = "box.openclaw.dev/installation";
const APP = "app.kubernetes.io/name";
const APP_VALUE = "box-harness-relay";
const NAMESPACE = "openclaw.dev/namespace";
const AGENT = "openclaw.dev/agent";
const REVISION = "openclaw.dev/revision";
const ROLE = "openclaw.dev/workload-role";
const HASH = "box.openclaw.dev/relay-spec-sha256";
const EXECUTION = "box.openclaw.dev/execution";
const REQUIREMENTS = "box.openclaw.dev/requirements-sha256";

type Header = {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
  };
};
type RelayKind = "Deployment" | "ConfigMap" | "NetworkPolicy";

interface ObjectApi {
  read(header: Header): Promise<unknown>;
  create(resource: Header & Readonly<Record<string, unknown>>): Promise<unknown>;
  list(
    apiVersion: "v1" | "discovery.k8s.io/v1",
    kind: "Pod" | "EndpointSlice",
    namespace: string,
    pretty: undefined,
    exact: undefined,
    exportt: undefined,
    fieldSelector: undefined,
    labelSelector: string,
  ): Promise<unknown>;
  delete(
    header: Header,
    pretty: undefined,
    dryRun: undefined,
    gracePeriod: undefined,
    orphanDependents: undefined,
    propagationPolicy: "Foreground",
    body: { readonly preconditions: { readonly uid: string; readonly resourceVersion: string } },
  ): Promise<unknown>;
}

function objects(context: SandboxNamespaceContext): ObjectApi {
  const object = record(context.kubernetes);
  if (
    !object ||
    typeof object.read !== "function" ||
    typeof object.create !== "function" ||
    typeof object.list !== "function" ||
    typeof object.delete !== "function"
  ) {
    throw new DependencyUnavailableError(
      "The selected Compute did not supply its Kubernetes object client.",
    );
  }
  return object as unknown as ObjectApi;
}

function statusCode(error: unknown, expected: number): boolean {
  const value = record(error);
  const response = record(value?.response);
  return [value?.code, value?.statusCode, response?.status, response?.statusCode].includes(
    expected,
  );
}

export async function readObject(
  context: SandboxNamespaceContext,
  header: Header,
): Promise<unknown> {
  context.signal.throwIfAborted();
  try {
    const result = await objects(context).read(header);
    context.signal.throwIfAborted();
    // KubernetesObjectApi materializes typed models. Compare their JSON fields,
    // without making the SDK prototype part of the security decision.
    return structuredClone(result);
  } catch (error) {
    context.signal.throwIfAborted();
    if (statusCode(error, 404)) return undefined;
    throw new DependencyUnavailableError(
      "Kubernetes did not confirm the exact Strands Box object.",
    );
  }
}

function podSelector(labels: Readonly<Record<string, string>>) {
  return { matchLabels: labels };
}

function peer(namespace: string, labels: Readonly<Record<string, string>>) {
  return {
    namespaceSelector: podSelector({ "kubernetes.io/metadata.name": namespace }),
    podSelector: podSelector(labels),
  };
}

export function relayName(installation: string): string {
  return `box-relay-${digest(installation).slice(0, 16)}`;
}

export class Relay {
  private readonly options: RelayOptions;
  private readonly authority: string;
  private readonly caBundle: string;

  constructor(options: RelayOptions, endpoint: string, caBundle: string) {
    this.options = options;
    this.authority = new URL(endpoint).hostname;
    this.caBundle = caBundle;
  }

  private header(kind: RelayKind, namespace: string): Header {
    return {
      apiVersion:
        kind === "NetworkPolicy"
          ? "networking.k8s.io/v1"
          : kind === "Deployment"
            ? "apps/v1"
            : "v1",
      kind,
      metadata: { name: relayName(this.options.installation), namespace },
    };
  }

  private desired(execution: Execution, requiredLabels: Readonly<Record<string, string>>) {
    const { owner } = execution;
    const selectors = {
      [APP]: APP_VALUE,
      [INSTANCE]: this.options.installation,
      [NAMESPACE]: owner.namespaceId,
      [AGENT]: owner.agentId,
      [REVISION]: owner.revisionId,
      [ROLE]: "agent",
    };
    if (
      Object.entries(selectors).some(
        ([key, value]) => Object.hasOwn(requiredLabels, key) && requiredLabels[key] !== value,
      )
    ) {
      throw new DependencyUnavailableError(
        "The Harness labels contradict the Strands Box execution.",
      );
    }
    const labels = { ...requiredLabels, ...selectors };
    const namespace = owner.namespaceName;
    const port = [{ protocol: "TCP", port: 8443 }];
    const withMetadata = <T extends Readonly<Record<string, unknown>>>(
      kind: RelayKind,
      body: T,
    ) => {
      const header = this.header(kind, namespace);
      return {
        ...header,
        metadata: {
          ...header.metadata,
          labels,
          annotations: {
            [HASH]: digest({ body, labels, executionId: execution.executionId }),
            [EXECUTION]: execution.executionId,
            [REQUIREMENTS]: execution.requirementsDigest,
          },
        },
        ...body,
      };
    };
    const policy = withMetadata("NetworkPolicy", {
      spec: {
        podSelector: podSelector(selectors),
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            // The stock KubernetesObjectApi uses its typed SDK's _from
            // property; its serializer writes the real wire key "from".
            _from: [
              peer(namespace, {
                [NAMESPACE]: owner.namespaceId,
                [AGENT]: owner.agentId,
                [REVISION]: owner.revisionId,
                [ROLE]: "gateway",
              }),
              peer(this.options.workerPeer.namespace, this.options.workerPeer.podLabels),
            ],
            ports: port,
          },
        ],
        egress: [{ to: [{ ipBlock: { cidr: `${this.options.hostAddress}/32` } }], ports: port }],
      },
    });
    const trust = withMetadata("ConfigMap", { immutable: true, data: { "ca.pem": this.caBundle } });
    const podSpec = {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Always",
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "relay",
          image: this.options.image,
          command: ["node", "/opt/box-ingress/relay.ts", "serve"],
          ports: [{ containerPort: 8443, protocol: "TCP" }],
          env: [
            {
              name: "BOX_RELAY_LISTEN_ADDRESS",
              valueFrom: { fieldRef: { fieldPath: "status.podIP" } },
            },
            { name: "BOX_RELAY_UPSTREAM_ADDRESS", value: this.options.hostAddress },
            { name: "BOX_RELAY_AUTHORITY", value: this.authority },
            { name: "BOX_RELAY_CA_FILE", value: "/etc/box-transport/ca.pem" },
          ],
          readinessProbe: {
            exec: { command: ["node", "/opt/box-ingress/relay.ts", "probe"] },
            timeoutSeconds: 5,
            periodSeconds: 5,
            failureThreshold: 1,
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [{ name: "trust", mountPath: "/etc/box-transport", readOnly: true }],
        },
      ],
      volumes: [{ name: "trust", configMap: { name: relayName(this.options.installation) } }],
    };
    const deployment = withMetadata("Deployment", {
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: podSelector(selectors),
        template: {
          metadata: {
            labels,
            annotations: {
              [EXECUTION]: execution.executionId,
              [REQUIREMENTS]: execution.requirementsDigest,
            },
          },
          spec: podSpec,
        },
      },
    });
    return { policy, trust, deployment, podSpec };
  }

  async prepare(
    context: SandboxNamespaceContext,
    execution: Execution,
    requiredLabels: Readonly<Record<string, string>>,
  ): Promise<void> {
    const { policy, trust, deployment } = this.desired(execution, requiredLabels);
    // The normal Worker can manage Deployments but cannot create or delete Pods.
    await this.admit(context, policy);
    await this.admit(context, trust);
    await this.admit(context, deployment);
  }

  async assertCurrent(context: SandboxHarnessContext, execution: Execution): Promise<void> {
    const { policy, trust, deployment, podSpec } = this.desired(
      execution,
      context.requirements.labels,
    );
    const policyObservation = await this.verify(context, policy);
    const trustObservation = await this.verify(context, trust);
    const deploymentObservation = await this.verify(context, deployment);
    const namespace = context.namespace.name;
    const serviceHeader = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "box-harness", namespace },
    };
    const service = record(await readObject(context, serviceHeader));
    const serviceMeta = exactMeta(service, serviceHeader);
    const serviceSpec = record(service?.spec);
    const serviceSelector = { [APP]: APP_VALUE, [INSTANCE]: this.options.installation };
    const servicePorts = serviceSpec?.ports;
    if (
      serviceMeta === undefined ||
      serviceSpec?.type !== "ClusterIP" ||
      typeof serviceSpec.clusterIP !== "string" ||
      isIP(serviceSpec.clusterIP) !== 4 ||
      !isDeepStrictEqual(serviceSpec.clusterIPs, [serviceSpec.clusterIP]) ||
      serviceSpec.publishNotReadyAddresses === true ||
      !emptyList(serviceSpec.externalIPs) ||
      !isDeepStrictEqual(serviceSpec.selector, serviceSelector) ||
      !Array.isArray(servicePorts) ||
      servicePorts.length !== 1 ||
      !isDeepStrictEqual(servicePorts[0], {
        name: "native-wss",
        protocol: "TCP",
        port: 8443,
        targetPort: 8443,
      })
    ) {
      throw changed();
    }

    // The Service's selectors intentionally survive a revision. Inspect every Pod
    // it selects, including a foreign Pod with only the two installation labels.
    const podSelector = `${APP}=${APP_VALUE},${INSTANCE}=${this.options.installation}`;
    const sliceSelector = "kubernetes.io/service-name=box-harness";
    const pods = await this.list(context, "v1", "Pod", podSelector);
    const slices = await this.list(context, "discovery.k8s.io/v1", "EndpointSlice", sliceSelector);
    if (pods.length > 1 || slices.length > 1) throw changed();
    const observedPod = record(pods[0]);
    const observedPodMeta = record(observedPod?.metadata);
    const deploymentMeta = record(deploymentObservation.metadata)!;
    let ready = false;
    let replicaSetObservation: { header: Header; object: Record<string, unknown> } | undefined;
    if (observedPod) {
      const podName = observedPodMeta?.name;
      const podMeta =
        typeof podName === "string"
          ? exactMeta(
              observedPod,
              {
                apiVersion: "v1",
                kind: "Pod",
                metadata: { name: podName, namespace },
              },
              true,
            )
          : undefined;
      const rs = controllerReference(podMeta?.ownerReferences, "apps/v1", "ReplicaSet");
      const labels = record(podMeta?.labels);
      const hash = labels?.["pod-template-hash"];
      if (
        typeof podName !== "string" ||
        !podMeta ||
        !rs ||
        typeof hash !== "string" ||
        !hash ||
        !templateLabels(labels, deployment.metadata.labels, hash) ||
        !containsProjection(podMeta.annotations, deployment.spec.template.metadata.annotations) ||
        !podSpecMatches(observedPod.spec, podSpec, true)
      ) {
        throw changed();
      }
      const rsHeader = {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: { name: rs.name, namespace },
      };
      const replicaSet = record(await readObject(context, rsHeader));
      const rsMeta = exactMeta(replicaSet, rsHeader);
      const upstream = controllerReference(rsMeta?.ownerReferences, "apps/v1", "Deployment");
      const rsSpec = record(replicaSet?.spec);
      const template = record(rsSpec?.template);
      const templateMeta = record(template?.metadata);
      if (
        rsMeta?.uid !== rs.uid ||
        upstream?.uid !== deploymentMeta.uid ||
        upstream?.name !== deployment.metadata.name ||
        !templateLabels(record(rsMeta?.labels), deployment.metadata.labels, hash) ||
        !templateLabels(record(templateMeta?.labels), deployment.metadata.labels, hash) ||
        !containsProjection(
          templateMeta?.annotations,
          deployment.spec.template.metadata.annotations,
        ) ||
        !podSpecMatches(template?.spec, podSpec)
      ) {
        throw changed();
      }
      replicaSetObservation = { header: rsHeader, object: replicaSet! };
      const podStatus = record(observedPod.status);
      const address = podStatus?.podIP;
      const conditions = podStatus?.conditions;
      const podReady =
        podStatus?.phase === "Running" &&
        Array.isArray(conditions) &&
        conditions.some(
          (item: unknown) => record(item)?.type === "Ready" && record(item)?.status === "True",
        );
      ready = this.selectedEndpoint(
        slices,
        serviceMeta.uid,
        podName,
        podMeta.uid,
        address,
        namespace,
      );
      if (ready && !podReady) throw changed();
    } else {
      // An empty EndpointSlice is normal until scheduling. Any address without
      // our observed Pod would let Kubernetes steer the bearer elsewhere.
      this.selectedEndpoint(slices, serviceMeta.uid, undefined, undefined, undefined, namespace);
    }
    if (execution.state === "running") {
      const status = record(deploymentObservation.status);
      if (
        !ready ||
        typeof deploymentMeta.generation !== "number" ||
        status?.observedGeneration !== deploymentMeta.generation ||
        status.readyReplicas !== 1 ||
        status.updatedReplicas !== 1 ||
        status.replicas !== 1
      ) {
        throw new TransientDependencyError(
          "sandbox_gateway",
          "unavailable",
          "The exact Strands Box relay has not finished rolling out.",
        );
      }
    }
    await this.unchanged(context, policy, policyObservation);
    await this.unchanged(context, trust, trustObservation);
    await this.unchanged(context, deployment, deploymentObservation);
    await this.unchanged(context, serviceHeader, service!);
    if (replicaSetObservation) {
      await this.unchanged(context, replicaSetObservation.header, replicaSetObservation.object);
    }
    if (
      !sameObjects(pods, await this.list(context, "v1", "Pod", podSelector)) ||
      !sameObjects(
        slices,
        await this.list(context, "discovery.k8s.io/v1", "EndpointSlice", sliceSelector),
      )
    ) {
      throw changed();
    }
  }

  private selectedEndpoint(
    slices: readonly unknown[],
    serviceUid: unknown,
    podName: string | undefined,
    podUid: unknown,
    podIP: unknown,
    namespace: string,
  ): boolean {
    if (slices.length === 0) return false;
    const slice = record(slices[0]);
    const name = record(slice?.metadata)?.name;
    const metadata =
      typeof name === "string"
        ? exactMeta(
            slice,
            {
              apiVersion: "discovery.k8s.io/v1",
              kind: "EndpointSlice",
              metadata: { name, namespace },
            },
            true,
          )
        : undefined;
    const service = controllerReference(metadata?.ownerReferences, "v1", "Service");
    if (
      metadata === undefined ||
      record(metadata.labels)?.["kubernetes.io/service-name"] !== "box-harness" ||
      service?.name !== "box-harness" ||
      service.uid !== serviceUid ||
      slice?.addressType !== "IPv4" ||
      !Array.isArray(slice.endpoints) ||
      slice.endpoints.length > 1
    ) {
      throw changed();
    }
    if (slice.endpoints.length === 0) return false;
    const endpoint = record(slice.endpoints[0]);
    const target = record(endpoint?.targetRef);
    const conditions = record(endpoint?.conditions);
    if (
      typeof podIP !== "string" ||
      isIP(podIP) !== 4 ||
      !isDeepStrictEqual(endpoint?.addresses, [podIP]) ||
      target?.kind !== "Pod" ||
      target.name !== podName ||
      target.namespace !== namespace ||
      target.uid !== podUid ||
      !isDeepStrictEqual(slice.ports, [{ name: "native-wss", protocol: "TCP", port: 8443 }])
    ) {
      throw changed();
    }
    return (
      conditions?.ready === true && conditions.terminating !== true && conditions.serving !== false
    );
  }

  private async list(
    context: SandboxNamespaceContext,
    apiVersion: "v1" | "discovery.k8s.io/v1",
    kind: "Pod" | "EndpointSlice",
    selector: string,
  ): Promise<readonly unknown[]> {
    context.signal.throwIfAborted();
    let result: Record<string, unknown> | undefined;
    try {
      result = record(
        await objects(context).list(
          apiVersion,
          kind,
          context.namespace.name,
          undefined,
          undefined,
          undefined,
          undefined,
          selector,
        ),
      );
    } catch {
      context.signal.throwIfAborted();
      throw changed();
    }
    context.signal.throwIfAborted();
    const metadata = record(result?.metadata);
    if (
      !Array.isArray(result?.items) ||
      (metadata?.continue !== undefined && metadata.continue !== "") ||
      (metadata?._continue !== undefined && metadata._continue !== "") ||
      (metadata?.remainingItemCount !== undefined && metadata.remainingItemCount !== 0)
    ) {
      throw changed();
    }
    return structuredClone(result.items);
  }

  private async unchanged(
    context: SandboxNamespaceContext,
    header: Header,
    prior: Record<string, unknown>,
  ) {
    const before = exactMeta(prior, header);
    const after = exactMeta(record(await readObject(context, header)), header);
    if (!before || after?.uid !== before.uid || after?.resourceVersion !== before.resourceVersion) {
      throw changed();
    }
  }

  private async admit(
    context: SandboxNamespaceContext,
    desired: Header & Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const header = this.header(desired.kind as RelayKind, desired.metadata.namespace);
    if ((await readObject(context, header)) === undefined) {
      context.signal.throwIfAborted();
      try {
        await objects(context).create(desired);
      } catch (error) {
        if (!statusCode(error, 409)) {
          throw new DependencyUnavailableError(
            "Kubernetes did not confirm the Strands Box relay creation.",
          );
        }
      }
    }
    await this.verify(context, desired);
  }

  private async verify(
    context: SandboxNamespaceContext,
    desired: Header & Readonly<Record<string, unknown>>,
  ) {
    const observed = record(await readObject(context, desired));
    const meta = exactMeta(observed, desired);
    if (
      !meta ||
      !isDeepStrictEqual(meta.labels, desired.metadata.labels) ||
      !containsProjection(meta.annotations, desired.metadata.annotations)
    ) {
      throw changed();
    }
    const expected = record(desired.spec);
    const actual = record(observed?.spec);
    if (
      (desired.kind === "NetworkPolicy" && !isDeepStrictEqual(actual, expected)) ||
      (desired.kind === "ConfigMap" &&
        (observed?.immutable !== true ||
          !isDeepStrictEqual(observed.data, desired.data) ||
          (observed.binaryData !== undefined && !isDeepStrictEqual(observed.binaryData, {})))) ||
      (desired.kind === "Deployment" && !deploymentMatches(actual, expected))
    ) {
      throw changed();
    }
    return observed!;
  }

  async cleanup(context: SandboxNamespaceContext, owner: Partial<Owner>): Promise<void> {
    for (const kind of ["Deployment", "ConfigMap", "NetworkPolicy"] as const) {
      if (kind === "ConfigMap") {
        await this.confirmNoPods(context);
      }
      const header = this.header(kind, context.namespace.name);
      const observed = await readObject(context, header);
      if (observed === undefined) continue;
      const metadata = record(record(observed)?.metadata);
      if (!metadata) {
        throw new DependencyUnavailableError(
          "Kubernetes returned incomplete Strands Box ownership evidence.",
        );
      }
      const labels = record(metadata.labels);
      if (
        metadata.name !== header.metadata.name ||
        metadata.namespace !== header.metadata.namespace ||
        labels?.[INSTANCE] !== this.options.installation ||
        labels[APP] !== APP_VALUE ||
        labels[NAMESPACE] !== context.namespace.id ||
        (owner.agentId !== undefined && labels[AGENT] !== owner.agentId) ||
        (owner.revisionId !== undefined && labels[REVISION] !== owner.revisionId)
      ) {
        throw new DependencyUnavailableError("Refusing to delete a foreign Strands Box relay.");
      }
      if (typeof metadata.uid !== "string" || typeof metadata.resourceVersion !== "string") {
        throw new DependencyUnavailableError(
          "The Strands Box relay has no Kubernetes deletion precondition.",
        );
      }
      context.signal.throwIfAborted();
      try {
        await objects(context).delete(
          header,
          undefined,
          undefined,
          undefined,
          undefined,
          "Foreground",
          {
            preconditions: { uid: metadata.uid, resourceVersion: metadata.resourceVersion },
          },
        );
      } catch (error) {
        if (!statusCode(error, 404)) {
          throw new DependencyUnavailableError(
            "Kubernetes did not confirm the Strands Box relay removal.",
          );
        }
      }
      if ((await readObject(context, header)) !== undefined) {
        throw new DependencyUnavailableError("The Strands Box relay removal is pending.");
      }
    }
  }

  private async confirmNoPods(context: SandboxNamespaceContext): Promise<void> {
    const selector = `${APP}=${APP_VALUE},${INSTANCE}=${this.options.installation},${NAMESPACE}=${context.namespace.id}`;
    context.signal.throwIfAborted();
    let list: Record<string, unknown> | undefined;
    try {
      list = record(
        await objects(context).list(
          "v1",
          "Pod",
          context.namespace.name,
          undefined,
          undefined,
          undefined,
          undefined,
          selector,
        ),
      );
    } catch {
      context.signal.throwIfAborted();
      throw new DependencyUnavailableError("Kubernetes did not confirm relay Pod removal.");
    }
    context.signal.throwIfAborted();
    const metadata = record(list?.metadata);
    if (
      !Array.isArray(list?.items) ||
      (metadata?.continue !== undefined && metadata.continue !== "") ||
      (metadata?._continue !== undefined && metadata._continue !== "") ||
      (metadata?.remainingItemCount !== undefined && metadata.remainingItemCount !== 0) ||
      list.items.length !== 0
    ) {
      throw new DependencyUnavailableError(
        "The Strands Box relay Pods are still present or unobservable.",
      );
    }
  }
}

function changed(): DependencyUnavailableError {
  return new DependencyUnavailableError(
    "The Strands Box relay does not name the current execution or its network route has changed.",
  );
}

function exactMeta(
  resource: Record<string, unknown> | undefined,
  header: Header,
  listItem = false,
) {
  const meta = record(resource?.metadata);
  return (resource?.kind === header.kind || (listItem && resource?.kind === undefined)) &&
    (resource?.apiVersion === header.apiVersion ||
      (listItem && resource?.apiVersion === undefined)) &&
    meta?.name === header.metadata.name &&
    meta.namespace === header.metadata.namespace &&
    typeof meta.uid === "string" &&
    meta.uid !== "" &&
    typeof meta.resourceVersion === "string" &&
    meta.resourceVersion !== "" &&
    meta.deletionTimestamp === undefined
    ? meta
    : undefined;
}

function controllerReference(value: unknown, apiVersion: string, kind: string) {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const owner = record(value[0]);
  return owner?.apiVersion === apiVersion &&
    owner.kind === kind &&
    owner.controller === true &&
    typeof owner.name === "string" &&
    owner.name !== "" &&
    typeof owner.uid === "string" &&
    owner.uid !== ""
    ? { name: owner.name, uid: owner.uid }
    : undefined;
}

function templateLabels(
  observed: Record<string, unknown> | undefined,
  expected: Readonly<Record<string, string>>,
  hash: string,
) {
  return isDeepStrictEqual(observed, { ...expected, "pod-template-hash": hash });
}

function sameObjects(before: readonly unknown[], after: readonly unknown[]) {
  return (
    before.length === after.length &&
    before.every((value, index) => {
      const a = record(record(value)?.metadata);
      const b = record(record(after[index])?.metadata);
      return (
        a?.uid !== undefined &&
        a.uid === b?.uid &&
        a.resourceVersion !== undefined &&
        a.resourceVersion === b?.resourceVersion
      );
    })
  );
}

function emptyList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function deploymentMatches(
  observed: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
) {
  const actual = record(observed?.template);
  const desired = record(expected?.template);
  return (
    observed !== undefined &&
    expected !== undefined &&
    observed.replicas === expected.replicas &&
    isDeepStrictEqual(observed.selector, expected.selector) &&
    isDeepStrictEqual(observed.strategy, expected.strategy) &&
    isDeepStrictEqual(record(actual?.metadata)?.labels, record(desired?.metadata)?.labels) &&
    containsProjection(
      record(actual?.metadata)?.annotations,
      record(desired?.metadata)?.annotations,
    ) &&
    podSpecMatches(actual?.spec, desired?.spec)
  );
}

// Allow only known Kubernetes defaults. Everything that can change what the
// relay runs, reads, mounts, reaches, or serves remains an exact comparison.
function podSpecMatches(value: unknown, desired: unknown, scheduled = false): boolean {
  const pod = record(structuredClone(value));
  if (!pod) return false;
  const defaults: Record<string, unknown> = {
    dnsPolicy: "ClusterFirst",
    schedulerName: "default-scheduler",
    serviceAccount: "default",
    serviceAccountName: "default",
    terminationGracePeriodSeconds: 30,
    preemptionPolicy: "PreemptLowerPriority",
    priority: 0,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
  };
  dropDefaults(pod, defaults);
  for (const key of [
    "initContainers",
    "ephemeralContainers",
    "imagePullSecrets",
    "resourceClaims",
  ]) {
    if (emptyList(pod[key])) delete pod[key];
  }
  if (scheduled && typeof pod.nodeName === "string" && pod.nodeName !== "") delete pod.nodeName;
  const tolerations = pod.tolerations;
  if (
    tolerations === undefined ||
    (Array.isArray(tolerations) &&
      tolerations.length <= 2 &&
      tolerations.every((item: unknown) => {
        const t = record(item);
        return (
          (t?.key === "node.kubernetes.io/not-ready" ||
            t?.key === "node.kubernetes.io/unreachable") &&
          isDeepStrictEqual(t, {
            key: t.key,
            operator: "Exists",
            effect: "NoExecute",
            tolerationSeconds: 300,
          })
        );
      }))
  )
    delete pod.tolerations;
  if (!Array.isArray(pod.containers) || pod.containers.length !== 1) return false;
  const relay = record(pod.containers[0]);
  if (!relay) return false;
  dropDefaults(relay, {
    imagePullPolicy: "IfNotPresent",
    terminationMessagePath: "/dev/termination-log",
    terminationMessagePolicy: "File",
  });
  for (const key of ["args", "envFrom", "volumeDevices"]) {
    if (emptyList(relay[key])) delete relay[key];
  }
  const resources = record(relay.resources);
  if (
    resources !== undefined &&
    Object.entries(resources).every(
      ([key, quota]) =>
        (key === "requests" || key === "limits") &&
        record(quota) !== undefined &&
        Object.entries(record(quota)!).every(
          ([resource, quantity]) =>
            ["cpu", "memory", "ephemeral-storage"].includes(resource) &&
            typeof quantity === "string",
        ),
    )
  )
    delete relay.resources;
  const probe = record(relay.readinessProbe);
  if (probe) dropDefaults(probe, { successThreshold: 1, initialDelaySeconds: 0 });
  if (Array.isArray(relay.env)) {
    for (const variable of relay.env) {
      const field = record(record(record(variable)?.valueFrom)?.fieldRef);
      if (field) dropDefaults(field, { apiVersion: "v1" });
    }
  }
  if (Array.isArray(pod.volumes)) {
    for (const volume of pod.volumes) {
      const map = record(record(volume)?.configMap);
      if (map) dropDefaults(map, { defaultMode: 420, optional: false });
    }
  }
  return isDeepStrictEqual(pod, desired);
}

function dropDefaults(
  object: Record<string, unknown>,
  defaults: Readonly<Record<string, unknown>>,
) {
  for (const [key, value] of Object.entries(defaults)) {
    if (isDeepStrictEqual(object[key], value)) delete object[key];
  }
}

// Kubernetes adds defaults and status fields. Only the fields owned by this example
// may be adopted, with exact list order and membership.
function containsProjection(observed: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(observed) &&
      observed.length === expected.length &&
      expected.every((entry, index) => containsProjection(observed[index], entry))
    );
  }
  const object = record(expected);
  if (!object) return isDeepStrictEqual(observed, expected);
  const actual = record(observed);
  return (
    actual !== undefined &&
    Object.entries(object).every(([key, value]) => containsProjection(actual[key], value))
  );
}
