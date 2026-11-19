import { NETWORK_PROFILE_LABEL, ORDINARY_NETWORK_PROFILE } from "./resources/network.ts";
import type { AgentRevision, NetworkDestinationRule } from "@openclaw-enterprise/contracts";
import { asRecord, readCappedBody, sha256Hex } from "@openclaw-enterprise/utils";
import type { KubernetesObject, KubernetesObjectApi, V1ObjectMeta } from "@kubernetes/client-node";
import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { ChannelRoutingRequirements } from "../../channel/routing.ts";
import {
  CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS,
  CHANNEL_EGRESS_IMAGE,
  CHANNEL_EGRESS_FORWARD_CLUSTER,
  channelEgressFilterChain,
  type ChannelEgressOptions,
} from "./channel-egress-policy.ts";

const API = "gateway.envoyproxy.io/v1alpha1";
const RECORD = "openclaw.dev/channel-egress-binding";
const FLEET = "openclaw.dev/channel-egress-fleet";
export const CHANNEL_EGRESS_BINDING_LABEL = "openclaw.dev/channel-egress-binding";

interface Resource extends KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta & { name: string };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface ChannelEgressBinding {
  readonly id: string;
  readonly namespaceId: string;
  readonly namespace: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly policyHash: string;
  readonly port: number;
  readonly state: "reserved" | "active" | "revoking";
}

export interface PreparedChannelRouting extends ChannelRoutingRequirements {
  binding?: ChannelEgressBinding;
  proxyUrl?: string;
}

type Request = <T>(
  operation: (api: KubernetesObjectApi) => Promise<T>,
  mutating?: boolean,
) => Promise<T>;

function statusCode(error: unknown): number | undefined {
  const value = asRecord(error);
  return typeof value?.code === "number"
    ? value.code
    : typeof value?.statusCode === "number"
      ? value.statusCode
      : undefined;
}

function samePolicy(left: Resource["spec"], right: Resource["spec"]): boolean {
  // The SDK returns typed model instances. Compare their wire fields, not their
  // prototypes, while retaining every selector, peer and port in the comparison.
  const fields = (spec: Resource["spec"]): unknown =>
    JSON.parse(
      JSON.stringify({ ...spec, ingress: spec?.ingress ?? [], egress: spec?.egress ?? [] }),
    );
  return isDeepStrictEqual(fields(left), fields(right));
}

// The generic SDK maps the reserved JSON field `from` to `_from` in its models.
// Keep wire-form policies inside Compute and translate only at that SDK boundary.
function networkPolicyFields(resource: Resource, toSdk: boolean): Resource {
  if (resource.kind !== "NetworkPolicy" || !Array.isArray(resource.spec?.ingress)) {
    return resource;
  }
  return {
    ...resource,
    spec: {
      ...resource.spec,
      ingress: resource.spec.ingress.map((value) => {
        const rule = { ...asRecord(value) };
        const source = toSdk ? "from" : "_from";
        const target = toSdk ? "_from" : "from";
        if (Object.hasOwn(rule, source)) {
          rule[target] = rule[source];
          delete rule[source];
        }
        return rule;
      }),
    },
  };
}

// Envoy omits protobuf default enum values and empty maps in config_dump. Restore
// only those known defaults; unexpected filters, routes or policy fields remain differences.
function canonicalEnvoy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalEnvoy);
  }
  const object = asRecord(value);
  if (!object) {
    return value;
  }
  const result = Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, canonicalEnvoy(item)]),
  );
  if (object["@type"] === "type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC") {
    const rules = asRecord(result.rules);
    if (rules) {
      result.rules = { action: "ALLOW", policies: {}, ...rules };
    }
  }
  if (
    object["@type"] ===
    "type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig"
  ) {
    const subclusters = asRecord(result.sub_clusters_config);
    if (subclusters) {
      result.sub_clusters_config = { lb_policy: "ROUND_ROBIN", ...subclusters };
    }
  }
  return result;
}

// Unknown labels may be present on the eventual Pod. Treat those selectors as
// potentially matching, rather than overlooking a broader additive grant.
function maySelect(value: unknown, labels: Readonly<Record<string, string>>): boolean {
  const selector = asRecord(value);
  if (!selector) {
    return true;
  }
  for (const [key, expected] of Object.entries(asRecord(selector.matchLabels) ?? {})) {
    if (labels[key] !== undefined && labels[key] !== expected) {
      return false;
    }
  }
  for (const raw of Array.isArray(selector.matchExpressions) ? selector.matchExpressions : []) {
    const expression = asRecord(raw);
    const actual = labels[String(expression?.key)];
    if (actual === undefined) {
      continue;
    }
    if (
      expression?.operator === "DoesNotExist" ||
      (expression?.operator === "In" && !(expression.values as unknown[]).includes(actual)) ||
      (expression?.operator === "NotIn" && (expression.values as unknown[]).includes(actual))
    ) {
      return false;
    }
  }
  return true;
}

function permitsPort(value: unknown, port: number): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return true;
  }
  return value.some((raw) => {
    const item = asRecord(raw);
    return (
      (!item?.protocol || item.protocol === "TCP") &&
      (typeof item?.port !== "number" ||
        (item.port <= port && Number(item.endPort ?? item.port) >= port))
    );
  });
}

/** Kubernetes Compute owns these records, policies and grants as one revision lifecycle. */
export class KubernetesChannelEgress {
  private readonly options: ChannelEgressOptions;
  private readonly request: Request;

  constructor(options: ChannelEgressOptions, request: Request) {
    this.options = structuredClone(options);
    this.request = request;
  }

  private slotName(port: number): string {
    return `channel-egress-${sha256Hex(this.options.gatewayName, 12)}-${port}`;
  }

  private header(kind: string, name: string, namespace: string, apiVersion = API): Resource {
    return { apiVersion, kind, metadata: { name, namespace } };
  }

  private async read(header: Resource): Promise<Resource | undefined> {
    try {
      return networkPolicyFields(await this.request((api) => api.read<Resource>(header)), false);
    } catch (error) {
      if (statusCode(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private verifySlot(resource: Resource, port: number, fleetUid: string): void {
    if (
      !Number.isInteger(port) ||
      port < this.options.listenerPortStart ||
      port > this.options.listenerPortEnd ||
      resource.metadata.name !== this.slotName(port) ||
      resource.metadata.namespace !== this.options.gatewayNamespace ||
      resource.metadata.labels?.[FLEET] !== this.options.gatewayName ||
      resource.metadata.annotations?.["openclaw.dev/channel-egress-gateway-uid"] !== fleetUid ||
      !resource.metadata.uid ||
      !resource.metadata.resourceVersion
    ) {
      throw new Error("Channel egress listener ownership cannot be established.");
    }
  }

  private binding(resource: Resource): ChannelEgressBinding | undefined {
    const encoded = resource.metadata.annotations?.[RECORD];
    if (encoded === "idle") {
      return undefined;
    }
    let value: Record<string, unknown> | undefined;
    try {
      value = asRecord(JSON.parse(encoded ?? ""));
    } catch {
      throw new Error("Channel egress listener has an invalid ownership record.");
    }
    if (
      !value ||
      ["id", "namespaceId", "namespace", "agentId", "revisionId", "policyHash"].some(
        (key) => typeof value[key] !== "string" || value[key] === "",
      ) ||
      !Number.isInteger(value.port) ||
      Number(value.port) < this.options.listenerPortStart ||
      Number(value.port) > this.options.listenerPortEnd ||
      !["reserved", "active", "revoking"].includes(String(value.state))
    ) {
      throw new Error("Channel egress listener has an invalid ownership record.");
    }
    return value as unknown as ChannelEgressBinding;
  }

  private peerLabels(): Record<string, string> {
    return {
      "gateway.envoyproxy.io/owning-gateway-name": this.options.gatewayName,
      "gateway.envoyproxy.io/owning-gateway-namespace": this.options.gatewayNamespace,
      "app.kubernetes.io/name": "envoy",
    };
  }

  private async fleet(): Promise<{ uid: string; pods: Resource[] }> {
    const gateway = await this.read(
      this.header(
        "Gateway",
        this.options.gatewayName,
        this.options.gatewayNamespace,
        "gateway.networking.k8s.io/v1",
      ),
    );
    if (
      !gateway?.metadata.uid ||
      gateway.metadata.labels?.[FLEET] !== this.options.gatewayName ||
      gateway.metadata.deletionTimestamp
    ) {
      throw new Error("The managed channel egress Gateway is unavailable.");
    }
    const service = await this.read(
      this.header("Service", this.options.serviceName, this.options.envoyNamespace, "v1"),
    );
    const serviceLabels = asRecord(service?.spec?.selector);
    const ports = service?.spec?.ports;
    if (
      !service?.metadata.uid ||
      service.metadata.labels?.[FLEET] !== this.options.gatewayName ||
      !Object.entries(this.peerLabels()).every(([key, value]) => serviceLabels?.[key] === value) ||
      !Array.isArray(ports)
    ) {
      throw new Error("The channel egress Service does not select the exact dedicated fleet.");
    }
    for (
      let port = this.options.listenerPortStart;
      port <= this.options.listenerPortEnd;
      port += 1
    ) {
      if (
        !ports.some(
          (entry) => asRecord(entry)?.port === port && asRecord(entry)?.targetPort === port,
        )
      ) {
        throw new Error(
          "Each channel Service port must target its own actual Envoy listener port.",
        );
      }
    }
    const selector = Object.entries(this.peerLabels())
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    const listed = await this.request((api) =>
      api.list<Resource>(
        "v1",
        "Pod",
        this.options.envoyNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        selector,
      ),
    );
    if (listed.metadata?._continue || listed.items.length === 0) {
      throw new Error("The complete channel egress Pod fleet is unavailable.");
    }
    for (const pod of listed.items) {
      if (
        pod.spec?.hostNetwork === true ||
        pod.spec?.hostPID === true ||
        pod.spec?.hostIPC === true
      ) {
        throw new Error(
          "Channel egress requires isolated Pod namespaces with enforcing NetworkPolicies.",
        );
      }
      const envoy = Array.isArray(pod.spec?.containers)
        ? pod.spec.containers.map(asRecord).find((container) => container?.name === "envoy")
        : undefined;
      if (envoy?.image !== CHANNEL_EGRESS_IMAGE) {
        throw new Error("Channel egress requires the qualified Envoy image on every Pod.");
      }
      const ready =
        Array.isArray(pod.status?.conditions) &&
        pod.status.conditions.some(
          (condition) =>
            asRecord(condition)?.type === "Ready" && asRecord(condition)?.status === "True",
        );
      if (
        !pod.metadata.uid ||
        pod.metadata.deletionTimestamp ||
        !ready ||
        typeof pod.status?.podIP !== "string" ||
        !isIP(pod.status.podIP)
      ) {
        throw new Error(
          "Every channel egress Pod must be ready before changing listener ownership.",
        );
      }
    }
    return { uid: gateway.metadata.uid, pods: listed.items };
  }

  async available(): Promise<boolean> {
    try {
      await this.fleet();
      return true;
    } catch {
      return false;
    }
  }

  private async inspect(pod: Resource): Promise<Record<string, unknown>[]> {
    const address = String(pod.status!.podIP);
    const host = isIP(address) === 6 ? `[${address}]` : address;
    const response = await fetch(`http://${host}:${this.options.inspectionPort}/config_dump`, {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error("Channel egress configuration inspection failed.");
    }
    const bytes = await readCappedBody(response.body, 16 * 1024 * 1024);
    if (!bytes) {
      throw new Error("Channel egress configuration inspection exceeded its response limit.");
    }
    const body = asRecord(JSON.parse(bytes.toString("utf8")));
    const clusters = Array.isArray(body?.configs)
      ? body.configs
          .map(asRecord)
          .find(
            (config) =>
              config?.["@type"] === "type.googleapis.com/envoy.admin.v3.ClustersConfigDump",
          )
      : undefined;
    const forwarding = Array.isArray(clusters?.dynamic_active_clusters)
      ? clusters.dynamic_active_clusters
          .map((entry) => asRecord(asRecord(entry)?.cluster))
          .filter((cluster) => cluster?.name === CHANNEL_EGRESS_FORWARD_CLUSTER.name)
      : [];
    if (
      forwarding.length !== 1 ||
      !isDeepStrictEqual(
        canonicalEnvoy(forwarding[0]),
        canonicalEnvoy({
          "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
          ...CHANNEL_EGRESS_FORWARD_CLUSTER,
        }),
      )
    ) {
      throw new Error(
        "Channel egress forwarding does not use the qualified strict-DNS cluster configuration.",
      );
    }
    const dump = Array.isArray(body?.configs)
      ? body.configs
          .map(asRecord)
          .find(
            (config) =>
              config?.["@type"] === "type.googleapis.com/envoy.admin.v3.ListenersConfigDump",
          )
      : undefined;
    if (!Array.isArray(dump?.dynamic_listeners)) {
      throw new Error("Channel egress returned no installed listener generations.");
    }
    return dump.dynamic_listeners.map((listener) => {
      const value = asRecord(listener);
      if (!value) {
        throw new Error("Channel egress returned an invalid listener generation.");
      }
      return value;
    });
  }

  private listenerName(port: number): string {
    return `${this.options.gatewayNamespace}/${this.options.gatewayName}/agent-${port}`;
  }

  private policy(
    port: number,
    fleetUid: string,
    binding: ChannelEgressBinding | undefined,
    destinations: readonly NetworkDestinationRule[],
    previous?: Resource,
  ): Resource {
    const generation =
      binding === undefined
        ? `idle-${port}`
        : binding.state === "active"
          ? binding.id
          : `${binding.id}-denied`;
    return {
      apiVersion: API,
      kind: "EnvoyPatchPolicy",
      metadata: {
        ...previous?.metadata,
        name: this.slotName(port),
        namespace: this.options.gatewayNamespace,
        labels: { [FLEET]: this.options.gatewayName },
        annotations: {
          "openclaw.dev/channel-egress-gateway-uid": fleetUid,
          [RECORD]: binding ? JSON.stringify(binding) : "idle",
        },
      },
      spec: {
        type: "JSONPatch",
        targetRef: {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: this.options.gatewayName,
        },
        jsonPatches: [
          {
            type: "type.googleapis.com/envoy.config.listener.v3.Listener",
            name: this.listenerName(port),
            operation: {
              op: "replace",
              path: "/default_filter_chain",
              value: channelEgressFilterChain(
                generation,
                binding?.state === "active" ? destinations : [],
                this.options,
              ),
            },
          },
        ],
      },
    };
  }

  private async slotResources(): Promise<Resource[]> {
    const listed = await this.request((api) =>
      api.list<Resource>(
        API,
        "EnvoyPatchPolicy",
        this.options.gatewayNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `${FLEET}=${this.options.gatewayName}`,
      ),
    );
    if (listed.metadata?._continue) {
      throw new Error("Channel listener inventory is incomplete.");
    }
    return listed.items.filter((resource) =>
      resource.metadata.name.startsWith(
        `channel-egress-${sha256Hex(this.options.gatewayName, 12)}-`,
      ),
    );
  }

  private async slots(fleetUid: string): Promise<Map<number, Resource>> {
    const result = new Map<number, Resource>();
    for (const resource of await this.slotResources()) {
      const port = Number(resource.metadata.name.split("-").at(-1));
      this.verifySlot(resource, port, fleetUid);
      const binding = this.binding(resource);
      if (binding && binding.port !== port) {
        throw new Error("Channel listener port does not match its ownership record.");
      }
      result.set(port, resource);
    }
    return result;
  }

  // TODO(workload identity): replace per-Agent slots with authenticated shared
  // listeners once verified Gateway workload identities are available.
  private async reserve(
    revision: AgentRevision,
    namespace: string,
    requirements: ChannelRoutingRequirements,
    fleetUid: string,
  ): Promise<ChannelEgressBinding> {
    const policyHash = sha256Hex(
      JSON.stringify({
        drivers: requirements.drivers,
        destinations: requirements.destinations,
        excludedCidrs: [...this.options.excludedCidrs].sort(),
      }),
      32,
    );
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const slots = await this.slots(fleetUid);
      for (const resource of slots.values()) {
        const binding = this.binding(resource);
        if (
          binding?.namespaceId === revision.namespaceId &&
          binding.agentId === revision.agentId &&
          binding.revisionId === revision.id &&
          binding.policyHash === policyHash &&
          binding.namespace === namespace &&
          binding.state !== "revoking"
        ) {
          return binding;
        }
      }
      let collided = false;
      for (
        let port = this.options.listenerPortStart;
        port <= this.options.listenerPortEnd;
        port += 1
      ) {
        const previous = slots.get(port);
        if (previous && this.binding(previous)) {
          continue;
        }
        const binding: ChannelEgressBinding = {
          id: randomUUID(),
          namespaceId: revision.namespaceId,
          namespace,
          agentId: revision.agentId,
          revisionId: revision.id,
          policyHash,
          port,
          state: "reserved",
        };
        const desired = this.policy(port, fleetUid, binding, [], previous);
        try {
          await this.request(
            (api) => (previous ? api.replace(desired) : api.create(desired)),
            true,
          );
          return binding;
        } catch (error) {
          if (statusCode(error) !== 409) {
            throw error;
          }
          collided = true;
          break;
        }
      }
      if (!collided) {
        throw new Error("The managed channel egress listener capacity is exhausted.");
      }
    }
    throw new Error("Channel egress listener allocation conflicted; retry the deployment.");
  }

  private async transition(
    binding: ChannelEgressBinding,
    state: ChannelEgressBinding["state"],
    destinations: readonly NetworkDestinationRule[],
    fleetUid: string,
  ): Promise<ChannelEgressBinding> {
    const previous = await this.read(
      this.header("EnvoyPatchPolicy", this.slotName(binding.port), this.options.gatewayNamespace),
    );
    if (!previous) {
      throw new Error("Channel egress binding disappeared; refusing to recreate it.");
    }
    this.verifySlot(previous, binding.port, fleetUid);
    const current = this.binding(previous);
    if (current?.id !== binding.id || (current.state === "revoking" && state !== "revoking")) {
      throw new Error("Channel egress binding was revoked or reassigned.");
    }
    const next = { ...current, state };
    const desired = this.policy(binding.port, fleetUid, next, destinations, previous);
    if (!isDeepStrictEqual(previous.spec, desired.spec) || current.state !== state) {
      await this.request((api) => api.replace(desired), true);
    }
    return next;
  }

  private async waitInstalled(
    binding: ChannelEgressBinding,
    fleetUid: string,
    destinations: readonly NetworkDestinationRule[] = [],
  ): Promise<void> {
    const expected = binding.state === "active" ? binding.id : `${binding.id}-denied`;
    const expectedChain = canonicalEnvoy(
      channelEgressFilterChain(
        expected,
        binding.state === "active" ? destinations : [],
        this.options,
      ),
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const before = await this.fleet();
      if (before.uid !== fleetUid) {
        throw new Error("The channel egress Gateway was replaced during reconciliation.");
      }
      const dumps = await Promise.all(before.pods.map((pod) => this.inspect(pod)));
      const installed = dumps.every((listeners) => {
        const listener = listeners.find((entry) => entry.name === this.listenerName(binding.port));
        const active = asRecord(asRecord(listener?.active_state)?.listener);
        return (
          isDeepStrictEqual(canonicalEnvoy(active?.default_filter_chain), expectedChain) &&
          !listener?.warming_state &&
          !listener?.draining_state &&
          !listener?.error_state
        );
      });
      const after = await this.fleet();
      if (
        installed &&
        after.uid === fleetUid &&
        JSON.stringify(before.pods.map((pod) => pod.metadata.uid).sort()) ===
          JSON.stringify(after.pods.map((pod) => pod.metadata.uid).sort())
      ) {
        return;
      }
      await delay(250);
    }
    throw new Error(
      "The exact channel listener generation is not installed and drained on every egress Pod.",
    );
  }

  private grants(binding: ChannelEgressBinding): Resource[] {
    const source = {
      "openclaw.dev/namespace": binding.namespaceId,
      "openclaw.dev/agent": binding.agentId,
      "openclaw.dev/revision": binding.revisionId,
      "openclaw.dev/workload-role": "gateway",
      [NETWORK_PROFILE_LABEL]: ORDINARY_NETWORK_PROFILE,
      [CHANNEL_EGRESS_BINDING_LABEL]: binding.id,
    };
    const peer = {
      namespaceSelector: {
        matchLabels: { "kubernetes.io/metadata.name": this.options.envoyNamespace },
      },
      podSelector: { matchLabels: this.peerLabels() },
    };
    const name = this.slotName(binding.port);
    const common = { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy" };
    const metadata = {
      name,
      labels: { [FLEET]: this.options.gatewayName, [CHANNEL_EGRESS_BINDING_LABEL]: binding.id },
      annotations: { [RECORD]: JSON.stringify(binding) },
    };
    return [
      {
        ...common,
        metadata: { ...metadata, name: `${name}-source`, namespace: binding.namespace },
        spec: {
          podSelector: { matchLabels: source },
          policyTypes: ["Egress"],
          egress: [{ to: [peer], ports: [{ protocol: "TCP", port: binding.port }] }],
        },
      },
      {
        ...common,
        metadata: { ...metadata, name: `${name}-ingress`, namespace: this.options.envoyNamespace },
        spec: {
          podSelector: { matchLabels: this.peerLabels() },
          policyTypes: ["Ingress"],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: { "kubernetes.io/metadata.name": binding.namespace },
                  },
                  podSelector: { matchLabels: source },
                },
              ],
              ports: [{ protocol: "TCP", port: binding.port }],
            },
          ],
        },
      },
    ];
  }

  private async reconcileGrants(binding: ChannelEgressBinding, revoke = false): Promise<void> {
    for (const grant of this.grants(binding)) {
      // A deleted tenant Namespace has no remaining source Pods or grants. The
      // fleet-side fence must still be revoked before the listener can be reused.
      if (
        revoke &&
        grant.metadata.namespace === binding.namespace &&
        !(await this.read(this.header("Namespace", binding.namespace, "", "v1")))
      ) {
        continue;
      }
      const previous = await this.read(grant);
      if (
        previous &&
        (previous.metadata.labels?.[FLEET] !== this.options.gatewayName ||
          ![binding.id, "idle"].includes(
            previous.metadata.labels?.[CHANNEL_EGRESS_BINDING_LABEL] ?? "",
          ) ||
          !previous.metadata.uid ||
          !previous.metadata.resourceVersion)
      ) {
        throw new Error("Channel egress network grant has unexpected ownership.");
      }
      // Read the stable grant BEFORE the slot. Revocation changes the slot first, then
      // the grant's resourceVersion. This fences both delayed reads and delayed writes.
      const slot = await this.read(
        this.header("EnvoyPatchPolicy", this.slotName(binding.port), this.options.gatewayNamespace),
      );
      const current = slot && this.binding(slot);
      if (current?.id !== binding.id || current.state !== (revoke ? "revoking" : "active")) {
        throw new Error("Channel egress grant owner was revoked or reassigned.");
      }
      const desired: Resource = {
        ...grant,
        metadata: {
          ...previous?.metadata,
          ...grant.metadata,
          labels: {
            ...grant.metadata.labels,
            [CHANNEL_EGRESS_BINDING_LABEL]: revoke ? "idle" : binding.id,
          },
          annotations: { [RECORD]: revoke ? "idle" : JSON.stringify(binding) },
        },
        spec: revoke
          ? { ...grant.spec, ...(grant.spec?.egress ? { egress: [] } : { ingress: [] }) }
          : grant.spec!,
      };
      if (
        !previous ||
        !samePolicy(previous.spec, desired.spec) ||
        previous.metadata.labels?.[CHANNEL_EGRESS_BINDING_LABEL] !==
          desired.metadata.labels?.[CHANNEL_EGRESS_BINDING_LABEL]
      ) {
        const encoded = networkPolicyFields(desired, true);
        await this.request((api) => (previous ? api.replace(encoded) : api.create(encoded)), true);
      }
      const observed = await this.read(grant);
      if (
        !observed ||
        !samePolicy(observed.spec, desired.spec) ||
        observed.metadata.labels?.[CHANNEL_EGRESS_BINDING_LABEL] !==
          desired.metadata.labels?.[CHANNEL_EGRESS_BINDING_LABEL]
      ) {
        throw new Error(
          "Channel egress grant readback did not match its exact owner and permissions.",
        );
      }
    }
  }

  private async verifyPolicySet(binding: ChannelEgressBinding): Promise<void> {
    const fleet = await this.fleet();
    const service = await this.read(
      this.header("Service", this.options.serviceName, this.options.envoyNamespace, "v1"),
    );
    const addresses = [
      ...fleet.pods.map((pod) => String(pod.status!.podIP)),
      String(service?.spec?.clusterIP),
    ];
    const contains = (cidr: string, address: string): boolean => {
      const [network, prefix] = cidr.split("/");
      if (isIP(network ?? "") !== 4 || isIP(address) !== 4) {
        return false;
      }
      const block = new BlockList();
      block.addSubnet(network!, Number(prefix), "ipv4");
      return block.check(address, "ipv4");
    };
    const source = asRecord(
      asRecord(this.grants(binding)[0]!.spec?.podSelector)?.matchLabels,
    ) as Record<string, string>;
    const isPrivateRange = (cidr: string): boolean => {
      const [address, prefix] = cidr.split("/");
      if (isIP(address ?? "") !== 4) {
        return false;
      }
      return [...CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS, ...this.options.excludedCidrs].some(
        (excluded) => {
          const [network, bits] = excluded.split("/");
          if (isIP(network ?? "") !== 4 || Number(prefix) < Number(bits)) {
            return false;
          }
          const block = new BlockList();
          block.addSubnet(network!, Number(bits), "ipv4");
          return block.check(address!, "ipv4");
        },
      );
    };
    for (const namespace of new Set([binding.namespace, this.options.envoyNamespace])) {
      const policies = await this.request((api) =>
        api.list<Resource>("networking.k8s.io/v1", "NetworkPolicy", namespace),
      );
      if (policies.metadata?._continue) {
        throw new Error("Cannot inspect the complete additive NetworkPolicy set.");
      }
      for (const policy of policies.items) {
        const spec = networkPolicyFields(policy, false).spec;
        if (namespace === binding.namespace && maySelect(spec?.podSelector, source)) {
          for (const raw of Array.isArray(spec?.egress) ? spec.egress : []) {
            const rule = asRecord(raw);
            const peers = Array.isArray(rule?.to) && rule.to.length > 0 ? rule.to : [{}];
            for (const rawPeer of peers) {
              const peer = asRecord(rawPeer) ?? {};
              const block = asRecord(peer.ipBlock);
              if (
                !block &&
                peer.namespaceSelector === undefined &&
                peer.podSelector === undefined
              ) {
                throw new Error(
                  "An additive NetworkPolicy grants unrestricted direct destinations to a channel Gateway.",
                );
              }
              if (block && !isPrivateRange(String(block.cidr))) {
                throw new Error(
                  "An additive NetworkPolicy permits direct public egress from a channel Gateway.",
                );
              }
              const targetsFleet = block
                ? addresses.some(
                    (address) =>
                      contains(String(block.cidr), address) &&
                      !(Array.isArray(block.except) ? block.except : []).some((cidr) =>
                        contains(String(cidr), address),
                      ),
                  )
                : (peer.namespaceSelector !== undefined
                    ? maySelect(peer.namespaceSelector, {
                        "kubernetes.io/metadata.name": this.options.envoyNamespace,
                      })
                    : namespace === this.options.envoyNamespace ||
                      peer.podSelector === undefined) &&
                  maySelect(peer.podSelector, this.peerLabels());
              if (targetsFleet) {
                if (permitsPort(rule?.ports, binding.port)) {
                  const names = asRecord(asRecord(peer.namespaceSelector)?.matchLabels);
                  const labels = asRecord(asRecord(peer.podSelector)?.matchLabels);
                  if (
                    names?.["kubernetes.io/metadata.name"] !== this.options.envoyNamespace ||
                    !Object.entries(this.peerLabels()).every(
                      ([key, value]) => labels?.[key] === value,
                    )
                  ) {
                    throw new Error(
                      "A channel listener grant must select only the dedicated Envoy fleet.",
                    );
                  }
                }
                for (
                  let port = this.options.listenerPortStart;
                  port <= this.options.listenerPortEnd;
                  port += 1
                ) {
                  if (port !== binding.port && permitsPort(rule?.ports, port)) {
                    throw new Error(
                      "An additive NetworkPolicy permits another Agent's channel listener.",
                    );
                  }
                }
                if (
                  permitsPort(rule?.ports, this.options.inspectionPort) ||
                  permitsPort(rule?.ports, this.options.occListenerPort)
                ) {
                  throw new Error("A channel Gateway must not reach OCC or inspection listeners.");
                }
              }
            }
          }
        }
        if (
          namespace === this.options.envoyNamespace &&
          maySelect(spec?.podSelector, this.peerLabels())
        ) {
          for (const raw of Array.isArray(spec?.ingress) ? spec.ingress : []) {
            const rule = asRecord(raw);
            if (!permitsPort(rule?.ports, binding.port)) {
              continue;
            }
            const peers = Array.isArray(rule?.from) && rule.from.length > 0 ? rule.from : [{}];
            for (const rawPeer of peers) {
              const peer = asRecord(rawPeer);
              const names = asRecord(asRecord(peer?.namespaceSelector)?.matchLabels);
              const labels = asRecord(asRecord(peer?.podSelector)?.matchLabels);
              if (
                names?.["kubernetes.io/metadata.name"] !== binding.namespace ||
                !Object.entries(source).every(([key, value]) => labels?.[key] === value)
              ) {
                throw new Error(
                  "An additive NetworkPolicy broadens channel listener ingress beyond its exact Gateway binding.",
                );
              }
            }
          }
        }
      }
    }
  }

  async prepare(
    revision: AgentRevision,
    namespace: string,
    routing: PreparedChannelRouting,
  ): Promise<void> {
    const { uid } = await this.fleet();
    let binding = await this.reserve(revision, namespace, routing, uid);
    await this.verifyPolicySet(binding);
    binding = await this.transition(binding, "active", routing.destinations, uid);
    await this.waitInstalled(binding, uid, routing.destinations);
    await this.reconcileGrants(binding);
    await this.verifyPolicySet(binding);
    routing.binding = binding;
    routing.proxyUrl = `http://${this.options.serviceName}.${this.options.envoyNamespace}.svc:${binding.port}`;
  }

  async retire(revision: AgentRevision, exceptBinding?: string): Promise<void> {
    // An attempt that failed before allocation has no tunnel to drain. A complete
    // empty binding inventory permits its cleanup even while the fleet is absent.
    if ((await this.slotResources()).length === 0) {
      return;
    }
    const { uid } = await this.fleet();
    for (const resource of (await this.slots(uid)).values()) {
      const binding = this.binding(resource);
      if (
        !binding ||
        binding.namespaceId !== revision.namespaceId ||
        binding.agentId !== revision.agentId ||
        binding.revisionId !== revision.id ||
        binding.id === exceptBinding
      ) {
        continue;
      }
      const denied = await this.transition(binding, "revoking", [], uid);
      await this.waitInstalled(denied, uid);
      // Retain stable empty policies as fencing records. Deleting them would allow a
      // delayed create from an old worker to reopen a port after it was reassigned.
      await this.reconcileGrants(denied, true);
      const current = await this.read(
        this.header("EnvoyPatchPolicy", this.slotName(binding.port), this.options.gatewayNamespace),
      );
      if (
        !current ||
        this.binding(current)?.id !== binding.id ||
        this.binding(current)?.state !== "revoking"
      ) {
        throw new Error("Channel listener ownership changed during cleanup.");
      }
      this.verifySlot(current, binding.port, uid);
      await this.request(
        (api) => api.replace(this.policy(binding.port, uid, undefined, [], current)),
        true,
      );
    }
  }
}
