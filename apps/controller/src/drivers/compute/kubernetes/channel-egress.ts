import { NETWORK_PROFILE_LABEL, ORDINARY_NETWORK_PROFILE } from "./resources/network.ts";
import type {
  AgentNetworkProxy,
  AgentRevision,
  ComputeRevisionContext,
  HarnessExecutionMode,
  NetworkDestinationRule,
} from "@openclaw-enterprise/contracts";
import { validNetworkProxyAuthorization } from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";
import { randomUUID, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { asRecord, readCappedBody, sha256Hex } from "@openclaw-enterprise/utils";
import type { KubernetesObject, KubernetesObjectApi, V1ObjectMeta } from "@kubernetes/client-node";
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
  type ChannelProxyPolicy,
} from "./channel-egress-policy.ts";

const API = "gateway.envoyproxy.io/v1alpha1";
const RECORD = "openclaw.dev/channel-egress-binding";
const REVISION_LABEL = "openclaw.dev/revision";
const FLEET = "openclaw.dev/channel-egress-fleet";
export const CHANNEL_EGRESS_BINDING_LABEL = "openclaw.dev/channel-egress-binding";

function gatewaySourceLabels(
  revision: Pick<AgentRevision, "namespaceId" | "agentId">,
  revisionId: string,
  bindingId: string,
) {
  return {
    "openclaw.dev/namespace": revision.namespaceId,
    "openclaw.dev/agent": revision.agentId,
    [REVISION_LABEL]: revisionId,
    "openclaw.dev/workload-role": "gateway",
    [NETWORK_PROFILE_LABEL]: ORDINARY_NETWORK_PROFILE,
    [CHANNEL_EGRESS_BINDING_LABEL]: bindingId,
  };
}

function dependsOnGeneratedGatewayLabel(value: unknown): boolean {
  const selector = asRecord(value);
  const matchLabels = asRecord(selector?.matchLabels) ?? {};
  if (
    Object.hasOwn(matchLabels, REVISION_LABEL) ||
    Object.hasOwn(matchLabels, CHANNEL_EGRESS_BINDING_LABEL)
  ) {
    return true;
  }
  const expressions = Array.isArray(selector?.matchExpressions) ? selector.matchExpressions : [];
  return expressions.some((raw) => {
    const expression = asRecord(raw);
    return (
      (expression?.key === REVISION_LABEL || expression?.key === CHANNEL_EGRESS_BINDING_LABEL) &&
      (expression.operator === "In" || expression.operator === "NotIn")
    );
  });
}

interface Resource extends KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: V1ObjectMeta & { name: string };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
  type?: string;
}

export interface ChannelProxyAdmission {
  readonly version: 1;
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly gatewayUid: string;
  readonly trust: { readonly caSecretName: string; readonly caKey: string } | null;
}

const PROXY_ENDPOINTS = "openclaw.dev/channel-egress-upstream-proxies";
const PROXY_TRUST = "openclaw.dev/channel-egress-proxy-trust";
const PROXY_CA_PATH = "/etc/openclaw/channel-proxy-ca/ca.pem";

export interface ChannelEgressBinding {
  readonly id: string;
  readonly namespaceId: string;
  readonly namespace: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly policyHash: string;
  readonly port: number;
  readonly state: "reserved" | "active" | "revoking";
  readonly proxy?: ChannelProxyBinding;
}

interface ChannelProxyBinding extends ChannelProxyAdmission {
  readonly credentialSecretId?: string;
  readonly sourceUid?: string;
  readonly sourceVersion?: string;
  readonly slotUid?: string;
}

interface PreparedProxy {
  readonly binding: ChannelProxyBinding;
  /** Transient Kubernetes Secret data; never put this in a policy or ownership record. */
  readonly encodedCredential?: string;
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

export class ChannelPublicEgressPolicyConflict extends Error {
  readonly #uid: string | undefined;
  readonly peerKind: "unspecified-destinations" | "ip-block-outside-allowed-ranges";

  constructor(peerKind: ChannelPublicEgressPolicyConflict["peerKind"], uid: string | undefined) {
    super(
      peerKind === "unspecified-destinations"
        ? "An additive NetworkPolicy grants unrestricted direct destinations to a channel Gateway."
        : "An additive NetworkPolicy permits direct public egress from a channel Gateway.",
    );
    this.peerKind = peerKind;
    // Only operator diagnostics include this locator. Kubernetes-assigned
    // UUIDs are bounded and identify even policies with long or sensitive names.
    this.#uid =
      uid?.length === 36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(uid)
        ? uid
        : undefined;
  }

  operatorMessage(message = this.message): string {
    return this.#uid ? `${message} Inspect NetworkPolicy UID ${this.#uid}.` : message;
  }
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

  private credentialSlotName(port: number): string {
    return `${this.slotName(port)}-credential`;
  }

  private proxyPolicy(binding: ChannelEgressBinding): ChannelProxyPolicy | undefined {
    const proxy = binding.proxy;
    if (!proxy) {
      return undefined;
    }
    const slot = this.credentialSlotName(binding.port);
    return {
      clusterName: `channel-egress-proxy-${binding.id}`,
      addresses: proxy.addresses,
      port: proxy.port,
      ...(proxy.credentialSecretId === undefined
        ? {}
        : {
            credential: {
              filterName: `envoy.filters.http.credential_injector/httproutefilter/${this.options.gatewayNamespace}/${slot}`,
              sdsName: `credential_injector/credential/httproutefilter/${this.options.gatewayNamespace}/${slot}`,
            },
          }),
    };
  }

  private proxyCluster(binding: ChannelEgressBinding): Record<string, unknown> | undefined {
    const proxy = binding.proxy;
    const policy = this.proxyPolicy(binding);
    if (!proxy || !policy) {
      return undefined;
    }
    const tls = proxy.url.startsWith("https://");
    const sanType = isIP(proxy.hostname) === 4 ? "IP_ADDRESS" : "DNS";
    return {
      name: policy.clusterName,
      type: "STATIC",
      connect_timeout: "5s",
      load_assignment: {
        cluster_name: policy.clusterName,
        endpoints: [
          {
            lb_endpoints: proxy.addresses.map((address) => ({
              endpoint: { address: { socket_address: { address, port_value: proxy.port } } },
            })),
          },
        ],
      },
      ...(tls
        ? {
            transport_socket: {
              name: "envoy.transport_sockets.tls",
              typed_config: {
                "@type":
                  "type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext",
                sni: proxy.hostname,
                common_tls_context: {
                  validation_context: {
                    trusted_ca: {
                      filename: proxy.trust ? PROXY_CA_PATH : "/etc/ssl/certs/ca-certificates.crt",
                    },
                    match_typed_subject_alt_names: [
                      { san_type: sanType, matcher: { exact: proxy.hostname } },
                    ],
                  },
                },
              },
            },
          }
        : {}),
    };
  }

  private async prepareProxy(
    revision: AgentRevision,
    namespace: string,
    context: ComputeRevisionContext | undefined,
  ): Promise<PreparedProxy | undefined> {
    if (!revision.networkProxy) {
      if (revision.compute.networkProxyAdmission || context?.networkProxyCredential) {
        throw new Error("Unexpected Gateway channel proxy admission.");
      }
      return undefined;
    }
    const current = await this.admitProxy(revision.networkProxy, {
      executionMode: revision.harness.mode,
      channelsEnabled: true,
    });
    if (current !== revision.compute.networkProxyAdmission) {
      throw new Error("Gateway channel proxy admission changed; deploy a new Agent revision.");
    }
    const admission = JSON.parse(current) as ChannelProxyAdmission;
    const id = revision.networkProxy.credentialSecretId;
    if (!id) {
      if (context?.networkProxyCredential) {
        throw new Error("Unexpected Gateway channel proxy credential.");
      }
      return { binding: admission };
    }
    const projection = context?.networkProxyCredential;
    if (
      !projection ||
      projection.secretId !== id ||
      projection.namespaceId !== revision.namespaceId ||
      projection.agentId !== revision.agentId ||
      projection.backendRef.namespaceName !== namespace
    ) {
      throw new Error("Gateway channel proxy credential identity is unavailable.");
    }
    let source: Resource | undefined;
    try {
      source = await this.read(this.header("Secret", projection.backendRef.name, namespace, "v1"));
    } catch {
      throw new Error("Gateway channel proxy credential source is unavailable.");
    }
    const encoded = source?.data?.[projection.backendRef.key];
    if (
      !source ||
      source.metadata.uid !== projection.backendRef.uid ||
      !source.metadata.resourceVersion ||
      source.metadata.deletionTimestamp ||
      !encoded
    ) {
      throw new Error("Gateway channel proxy credential source is unavailable.");
    }
    const header = Buffer.from(encoded, "base64").toString("utf8");
    if (!validNetworkProxyAuthorization(header)) {
      throw new Error(
        "Gateway channel proxy credential Secret must contain a valid Basic authorization value.",
      );
    }
    return {
      binding: {
        ...admission,
        credentialSecretId: id,
        sourceUid: source.metadata.uid,
        sourceVersion: source.metadata.resourceVersion,
      },
      encodedCredential: encoded,
    };
  }

  private async proxyAddresses(hostname: string): Promise<string[]> {
    if (isIP(hostname) === 4) {
      return [hostname];
    }
    if (isIP(hostname) !== 0 || hostname.includes(":")) {
      throw new Error("Channel proxy endpoints require IPv4 addresses.");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Channel proxy DNS timed out.")), 5_000);
        }),
      ]);
      if (result.length === 0 || result.some(({ family }) => family !== 4)) {
        throw new Error("Channel proxy DNS returned unsupported addresses.");
      }
      return [...new Set(result.map(({ address }) => address))].sort();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async verifyProxyTrust(pods: readonly Resource[]): Promise<void> {
    const trust = this.options.proxyTrust;
    if (!trust) {
      return;
    }
    const secret = await this.read(
      this.header("Secret", trust.caSecretName, this.options.envoyNamespace, "v1"),
    );
    const encoded = secret?.data?.[trust.caKey];
    if (!encoded) {
      throw new Error("Channel proxy trust bundle is unavailable.");
    }
    const bundle = Buffer.from(encoded, "base64").toString("utf8");
    const certificates = bundle.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (
      !certificates?.length ||
      certificates.reduce((rest, certificate) => rest.replace(certificate, ""), bundle).trim()
    ) {
      throw new Error("Channel proxy trust must contain public CA certificates only.");
    }
    for (const certificate of certificates) {
      if (!new X509Certificate(certificate).ca) {
        throw new Error("Channel proxy trust must contain CA certificates only.");
      }
    }
    for (const pod of pods) {
      const volumes = Array.isArray(pod.spec?.volumes) ? pod.spec.volumes.map(asRecord) : [];
      const volume = volumes.find((entry) => entry?.name === "channel-proxy-ca");
      const source = asRecord(volume?.secret);
      const items = Array.isArray(source?.items) ? source.items.map(asRecord) : [];
      const containers = Array.isArray(pod.spec?.containers)
        ? pod.spec.containers.map(asRecord)
        : [];
      const mounts = containers.flatMap((container) =>
        Array.isArray(container?.volumeMounts) ? container.volumeMounts.map(asRecord) : [],
      );
      if (
        source?.secretName !== trust.caSecretName ||
        !items.some((item) => item?.key === trust.caKey && item.path === "ca.pem") ||
        !mounts.some(
          (mount) =>
            mount?.name === "channel-proxy-ca" &&
            mount.mountPath === "/etc/openclaw/channel-proxy-ca" &&
            mount.readOnly === true,
        )
      ) {
        throw new Error("The Envoy fleet does not mount the admitted channel proxy trust bundle.");
      }
    }
  }

  async admitProxy(
    selection: Readonly<AgentNetworkProxy>,
    context: { readonly executionMode: HarnessExecutionMode; readonly channelsEnabled: boolean },
  ): Promise<string> {
    if (context.channelsEnabled && context.executionMode !== "dedicated") {
      throw new ConfigurationHarnessError(
        "Gateway channel proxy routing requires dedicated execution. Select dedicated execution or disable the channels.",
      );
    }
    const endpoint = this.options.upstreamProxies?.find(({ url }) => url === selection.url);
    if (!endpoint) {
      throw new ConfigurationHarnessError(
        "The Network proxy endpoint is not configured by the Installation. Select an installed endpoint.",
      );
    }
    const fleet = await this.fleet();
    const gateway = await this.read(
      this.header(
        "Gateway",
        this.options.gatewayName,
        this.options.gatewayNamespace,
        "gateway.networking.k8s.io/v1",
      ),
    );
    let installedEndpoints: unknown;
    let installedTrust: unknown;
    try {
      installedEndpoints = JSON.parse(gateway?.metadata.annotations?.[PROXY_ENDPOINTS] ?? "");
      installedTrust = JSON.parse(gateway?.metadata.annotations?.[PROXY_TRUST] ?? "");
    } catch {
      throw new Error("Installed channel proxy configuration is unavailable.");
    }
    if (
      !isDeepStrictEqual(installedEndpoints, this.options.upstreamProxies ?? []) ||
      !isDeepStrictEqual(installedTrust, this.options.proxyTrust ?? null)
    ) {
      throw new Error("Installation and Helm channel proxy configuration differ.");
    }
    await this.verifyProxyTrust(fleet.pods);
    const parsed = new URL(selection.url);
    const addresses = await this.proxyAddresses(parsed.hostname);
    const approved = new Set(endpoint.addresses.map((cidr) => cidr.slice(0, -3)));
    if (addresses.some((address) => !approved.has(address))) {
      throw new Error("Channel proxy DNS escaped its Installation endpoint scope.");
    }
    const admission: ChannelProxyAdmission = {
      version: 1,
      url: selection.url,
      hostname: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
      addresses,
      gatewayUid: fleet.uid,
      trust: this.options.proxyTrust ?? null,
    };
    return JSON.stringify(admission);
  }

  private async credentialSlot(binding: ChannelEgressBinding): Promise<Resource> {
    let slot: Resource | undefined;
    try {
      slot = await this.read(
        this.header(
          "Secret",
          this.credentialSlotName(binding.port),
          this.options.gatewayNamespace,
          "v1",
        ),
      );
    } catch {
      throw new Error("Channel proxy credential slot is unavailable.");
    }
    if (
      !slot ||
      !slot.metadata.uid ||
      !slot.metadata.resourceVersion ||
      slot.metadata.deletionTimestamp ||
      slot.type !== "Opaque" ||
      slot.metadata.labels?.[FLEET] !== this.options.gatewayName ||
      slot.metadata.labels?.["openclaw.dev/channel-egress-slot"] !== String(binding.port) ||
      (binding.proxy?.slotUid !== undefined && slot.metadata.uid !== binding.proxy.slotUid)
    ) {
      throw new Error("Channel proxy credential slot ownership is invalid.");
    }
    return slot;
  }

  private async replaceCredentialSlot(
    slot: Resource,
    bindingId: string,
    data: Record<string, string>,
  ): Promise<Resource> {
    try {
      return await this.request(
        (api) =>
          api.replace<Resource>({
            ...slot,
            metadata: {
              ...slot.metadata,
              annotations: { ...slot.metadata.annotations, [RECORD]: bindingId },
            },
            data,
          }),
        true,
      );
    } catch {
      // Kubernetes errors can contain the submitted Secret body.
      throw new Error("Channel proxy credential slot update failed.");
    }
  }

  private async fillCredentialSlot(
    binding: ChannelEgressBinding,
    encoded: string,
  ): Promise<ChannelEgressBinding> {
    const slot = await this.credentialSlot(binding);
    const listener = await this.read(
      this.header("EnvoyPatchPolicy", this.slotName(binding.port), this.options.gatewayNamespace),
    );
    if (!listener) {
      throw new Error("Channel listener ownership changed before credential delivery.");
    }
    this.verifySlot(listener, binding.port, binding.proxy!.gatewayUid);
    const current = this.binding(listener);
    if (current?.id !== binding.id || current.state === "revoking") {
      throw new Error("Channel listener ownership changed before credential delivery.");
    }
    const owner = slot.metadata.annotations?.[RECORD];
    const keys = Object.keys(slot.data ?? {});
    if (owner === binding.id) {
      if (keys.length !== 1 || slot.data?.credential !== encoded) {
        throw new Error("Channel proxy credential slot changed during this revision.");
      }
    } else {
      if ((owner !== undefined && owner !== "idle") || keys.length !== 0) {
        throw new Error("Channel proxy credential slot belongs to another binding.");
      }
      await this.replaceCredentialSlot(slot, binding.id, { credential: encoded });
    }
    return {
      ...binding,
      proxy: { ...binding.proxy!, slotUid: slot.metadata.uid! },
    };
  }

  private async verifyCredentialRoute(binding: ChannelEgressBinding): Promise<Resource> {
    const name = this.credentialSlotName(binding.port);
    const route = await this.read(
      this.header("HTTPRoute", name, this.options.gatewayNamespace, "gateway.networking.k8s.io/v1"),
    );
    const filter = await this.read(
      this.header("HTTPRouteFilter", name, this.options.gatewayNamespace),
    );
    const injection = asRecord(filter?.spec?.credentialInjection);
    const reference = asRecord(asRecord(injection?.credential)?.valueRef);
    const parents = Array.isArray(route?.spec?.parentRefs)
      ? route.spec.parentRefs.map(asRecord)
      : [];
    const rules = Array.isArray(route?.spec?.rules) ? route.spec.rules.map(asRecord) : [];
    const rule = rules[0];
    const matches = Array.isArray(rule?.matches) ? rule.matches.map(asRecord) : [];
    const path = asRecord(matches[0]?.path);
    const filters = Array.isArray(rule?.filters) ? rule.filters.map(asRecord) : [];
    const names = filters.map((entry) => asRecord(entry?.extensionRef)?.name);
    if (
      !route ||
      !filter ||
      route.metadata.labels?.[FLEET] !== this.options.gatewayName ||
      filter.metadata.labels?.[FLEET] !== this.options.gatewayName ||
      route.metadata.labels?.["openclaw.dev/channel-egress-slot"] !== String(binding.port) ||
      filter.metadata.labels?.["openclaw.dev/channel-egress-slot"] !== String(binding.port) ||
      reference?.name !== name ||
      reference.namespace !== undefined ||
      injection?.header !== "Proxy-Authorization" ||
      injection.overwrite !== true ||
      parents.length !== 1 ||
      parents[0]?.name !== this.options.gatewayName ||
      parents[0]?.sectionName !== `agent-${binding.port}` ||
      rules.length !== 1 ||
      rule?.backendRefs !== undefined ||
      matches.length !== 1 ||
      path?.type !== "Exact" ||
      path.value !== `/__oce_channel_credential_${binding.port}` ||
      filters.length !== 2 ||
      filters.some((entry) => entry?.type !== "ExtensionRef") ||
      names[0] !== name ||
      names[1] !== `${this.options.gatewayName}-deny`
    ) {
      throw new Error("Channel proxy credential route is not the installed deny-only slot.");
    }
    return route;
  }

  private async waitCredentialRoute(
    binding: ChannelEgressBinding,
    accepted: boolean,
  ): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const route = await this.verifyCredentialRoute(binding);
      const parents = Array.isArray(route.status?.parents)
        ? route.status.parents.map(asRecord)
        : [];
      const parent = parents.find((entry) => {
        const ref = asRecord(entry?.parentRef);
        return (
          ref?.name === this.options.gatewayName && ref.sectionName === `agent-${binding.port}`
        );
      });
      const conditions = Array.isArray(parent?.conditions) ? parent.conditions.map(asRecord) : [];
      if (
        conditions.some(
          (condition) =>
            condition?.type === "Accepted" &&
            condition.status === (accepted ? "True" : "False") &&
            condition.observedGeneration === route.metadata.generation,
        )
      ) {
        return;
      }
      await delay(250);
    }
    throw new Error("Channel proxy credential route did not reach the required state.");
  }

  private async activeSdsNames(pod: Resource): Promise<Set<string>> {
    const resources = await this.inspectedResources(pod, "dynamic_active_secrets&mask=name");
    if (
      resources.some(
        (entry) =>
          typeof entry.name !== "string" ||
          Object.keys(entry).some((key) => key !== "@type" && key !== "name"),
      )
    ) {
      throw new Error("Channel proxy inspection exposed unexpected Secret fields.");
    }
    return new Set(resources.map((entry) => String(entry.name)));
  }

  private async waitSds(binding: ChannelEgressBinding, present: boolean): Promise<void> {
    const name = this.proxyPolicy(binding)?.credential?.sdsName;
    if (!name) {
      return;
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const fleet = await this.fleet();
      const states = await Promise.all(fleet.pods.map((pod) => this.activeSdsNames(pod)));
      if (states.every((names) => names.has(name) === present)) {
        return;
      }
      await delay(250);
    }
    throw new Error("Channel proxy SDS state did not reach the required binding state.");
  }

  private async clearCredentialSlot(binding: ChannelEgressBinding): Promise<void> {
    if (!binding.proxy?.credentialSecretId) {
      return;
    }
    let slot = await this.credentialSlot(binding);
    const owner = slot.metadata.annotations?.[RECORD];
    if (
      owner !== binding.id &&
      !((owner === undefined || owner === "idle") && Object.keys(slot.data ?? {}).length === 0)
    ) {
      throw new Error("Channel proxy credential slot belongs to another binding.");
    }
    // Fence even an empty slot: a former worker may still hold its previous resourceVersion.
    slot = await this.replaceCredentialSlot(slot, binding.id, {});
    await this.waitCredentialRoute(binding, false);
    await this.waitSds(binding, false);
    await this.replaceCredentialSlot(slot, "idle", {});
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
    if (value.proxy !== undefined) {
      const proxy = asRecord(value.proxy);
      const trust = proxy?.trust == null ? null : asRecord(proxy.trust);
      const credential = proxy?.credentialSecretId !== undefined;
      if (
        !proxy ||
        proxy.version !== 1 ||
        typeof proxy.url !== "string" ||
        typeof proxy.hostname !== "string" ||
        typeof proxy.gatewayUid !== "string" ||
        !Number.isInteger(proxy.port) ||
        Number(proxy.port) < 1 ||
        Number(proxy.port) > 65535 ||
        !Array.isArray(proxy.addresses) ||
        proxy.addresses.length === 0 ||
        proxy.addresses.some((address) => typeof address !== "string" || isIP(address) !== 4) ||
        (proxy.trust !== null &&
          (!trust || typeof trust.caSecretName !== "string" || typeof trust.caKey !== "string")) ||
        (credential &&
          (typeof proxy.credentialSecretId !== "string" ||
            typeof proxy.sourceUid !== "string" ||
            typeof proxy.sourceVersion !== "string" ||
            (value.state === "active" && typeof proxy.slotUid !== "string"))) ||
        (!credential &&
          (proxy.sourceUid !== undefined ||
            proxy.sourceVersion !== undefined ||
            proxy.slotUid !== undefined))
      ) {
        throw new Error("Channel egress listener has an invalid proxy ownership record.");
      }
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

  private async inspection(
    pod: Resource,
    path: string,
    limit: number,
  ): Promise<Record<string, unknown>> {
    const address = String(pod.status!.podIP);
    const host = isIP(address) === 6 ? `[${address}]` : address;
    const response = await fetch(`http://${host}:${this.options.inspectionPort}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error("Channel egress configuration inspection failed.");
    }
    const bytes = await readCappedBody(response.body, limit);
    if (!bytes) {
      throw new Error("Channel egress configuration inspection exceeded its response limit.");
    }
    try {
      const body = asRecord(JSON.parse(bytes.toString("utf8")));
      if (body) {
        return body;
      }
    } catch {
      // Inspection failures must not echo response bytes into deployment errors.
    }
    throw new Error("Channel egress returned invalid inspection data.");
  }

  private async drained(pod: Resource): Promise<boolean> {
    const name = "listener_manager.total_filter_chains_draining";
    const query = new URLSearchParams({
      format: "json",
      filter: "^listener_manager\\.total_filter_chains_draining$",
    });
    const body = await this.inspection(pod, `/stats?${query}`, 64 * 1024);
    const values = Array.isArray(body.stats)
      ? body.stats.map(asRecord).filter((stat) => stat?.name === name)
      : [];
    if (
      values.length !== 1 ||
      typeof values[0]?.value !== "number" ||
      !Number.isSafeInteger(values[0].value) ||
      values[0].value < 0
    ) {
      throw new Error("Channel egress did not report its filter-chain drain counter.");
    }
    return values[0].value === 0;
  }

  private async inspectedResources(
    pod: Resource,
    resource: string,
  ): Promise<Record<string, unknown>[]> {
    const body = await this.inspection(pod, `/config_dump?resource=${resource}`, 16 * 1024 * 1024);
    if (!Array.isArray(body.configs) || body.configs.some((entry) => !asRecord(entry))) {
      throw new Error("Channel egress returned invalid inspection resources.");
    }
    return body.configs.map((entry) => asRecord(entry)!);
  }

  private async inspect(pod: Resource): Promise<{
    listeners: Record<string, unknown>[];
    clusters: Record<string, unknown>[];
    staticClusters: Record<string, unknown>[];
  }> {
    const [clusters, staticClusters, dynamic, staticListeners] = await Promise.all([
      this.inspectedResources(pod, "dynamic_active_clusters"),
      this.inspectedResources(pod, "static_clusters"),
      this.inspectedResources(pod, "dynamic_listeners"),
      this.inspectedResources(pod, "static_listeners"),
    ]);
    const forwarding = clusters
      .map((entry) => asRecord(entry.cluster))
      .filter((cluster) => cluster?.name === CHANNEL_EGRESS_FORWARD_CLUSTER.name);
    const staticForwarding = staticClusters.some(
      (entry) => asRecord(entry.cluster)?.name === CHANNEL_EGRESS_FORWARD_CLUSTER.name,
    );
    if (
      staticForwarding ||
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
    const fixed = staticListeners.map((entry) => {
      const listener = asRecord(entry.listener);
      if (!listener) {
        throw new Error("Channel egress returned an invalid static listener.");
      }
      return { name: listener.name, active_state: { listener } };
    });
    return { listeners: [...dynamic, ...fixed], clusters, staticClusters };
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
    const proxy = binding?.state === "active" ? this.proxyPolicy(binding) : undefined;
    const cluster = binding?.state === "active" ? this.proxyCluster(binding) : undefined;
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
          ...(cluster
            ? [
                {
                  type: "type.googleapis.com/envoy.config.cluster.v3.Cluster",
                  name: cluster.name,
                  operation: { op: "add", path: "", value: cluster },
                },
              ]
            : []),
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
                proxy,
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
    proxy?: ChannelProxyBinding,
  ): Promise<ChannelEgressBinding> {
    const template: ChannelEgressBinding = {
      id: "policy",
      namespaceId: revision.namespaceId,
      namespace,
      agentId: revision.agentId,
      revisionId: revision.id,
      policyHash: "policy",
      port: 0,
      state: "active",
      ...(proxy === undefined ? {} : { proxy }),
    };
    const policyHash = sha256Hex(
      JSON.stringify({
        drivers: requirements.drivers,
        // Include the complete effective policy so an implementation or mandatory
        // restriction change also gets a separate generation and serving binding.
        filterChain: channelEgressFilterChain(
          "policy",
          requirements.destinations,
          this.options,
          this.proxyPolicy(template),
        ),
        ...(proxy === undefined ? {} : { proxy, cluster: this.proxyCluster(template) }),
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
          binding.proxy?.sourceVersion !== proxy?.sourceVersion
        ) {
          throw new Error("The Network proxy credential changed; deploy a new Agent revision.");
        }
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
          ...(proxy === undefined ? {} : { proxy }),
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
    const next = {
      ...current,
      ...(binding.proxy === undefined ? {} : { proxy: binding.proxy }),
      state,
    };
    const desired = this.policy(binding.port, fleetUid, next, destinations, previous);
    if (!isDeepStrictEqual(previous.spec, desired.spec) || !isDeepStrictEqual(current, next)) {
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
        binding.state === "active" ? this.proxyPolicy(binding) : undefined,
      ),
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const before = await this.fleet();
      if (before.uid !== fleetUid) {
        throw new Error("The channel egress Gateway was replaced during reconciliation.");
      }
      const dumps = await Promise.all(before.pods.map((pod) => this.inspect(pod)));
      let installed = dumps.every((dump) => {
        const listeners = dump.listeners;
        const cluster = this.proxyCluster(binding);
        if (cluster) {
          const dynamic = dump.clusters
            .map((entry) => asRecord(entry.cluster))
            .filter((entry) => entry?.name === cluster.name);
          if (dump.staticClusters.some((entry) => asRecord(entry.cluster)?.name === cluster.name)) {
            return false;
          }
          if (binding.state === "active") {
            if (
              dynamic.length !== 1 ||
              !isDeepStrictEqual(
                canonicalEnvoy(dynamic[0]),
                canonicalEnvoy({
                  "@type": "type.googleapis.com/envoy.config.cluster.v3.Cluster",
                  ...cluster,
                }),
              )
            ) {
              return false;
            }
          } else if (dynamic.length !== 0) {
            return false;
          }
        }
        const listener = listeners.find((entry) => entry.name === this.listenerName(binding.port));
        const active = asRecord(asRecord(listener?.active_state)?.listener);
        const socket = asRecord(asRecord(active?.address)?.socket_address);
        const bindings = listeners.filter((entry) => {
          const installed = asRecord(asRecord(entry.active_state)?.listener);
          const addresses = [
            installed?.address,
            ...(Array.isArray(installed?.additional_addresses)
              ? installed.additional_addresses.map((value) => asRecord(value)?.address)
              : []),
          ];
          return addresses.some((address) => {
            const socket = asRecord(asRecord(address)?.socket_address);
            return (
              socket?.port_value === binding.port && (!socket.protocol || socket.protocol === "TCP")
            );
          });
        });
        return (
          bindings.length === 1 &&
          bindings[0] === listener &&
          socket?.port_value === binding.port &&
          (!socket.protocol || socket.protocol === "TCP") &&
          ["0.0.0.0", "::"].includes(String(socket.address)) &&
          !active?.filter_chain_matcher &&
          (!Array.isArray(active?.filter_chains) || active.filter_chains.length === 0) &&
          (!Array.isArray(active?.additional_addresses) ||
            active.additional_addresses.length === 0) &&
          isDeepStrictEqual(canonicalEnvoy(active?.default_filter_chain), expectedChain) &&
          !listener?.warming_state &&
          !listener?.draining_state &&
          !listener?.error_state
        );
      });
      if (installed) {
        // Envoy omits in-place filter-chain drains from config_dump. This gauge
        // reaches zero only after every worker has removed the draining chains
        // and their connections. A concurrent fleet drain delays safe reuse.
        const drained = await Promise.all(before.pods.map((pod) => this.drained(pod)));
        // Activation also requires a readable counter, so an unobservable fleet
        // cannot start channels whose later revocation it cannot prove.
        if (binding.state === "revoking") {
          installed = drained.every(Boolean);
        }
      }
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
    const source = gatewaySourceLabels(binding, binding.revisionId, binding.id);
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
      ...(binding.proxy
        ? [
            {
              ...common,
              metadata: {
                ...metadata,
                name: `${name}-proxy`,
                namespace: this.options.envoyNamespace,
              },
              spec: {
                podSelector: { matchLabels: this.peerLabels() },
                policyTypes: ["Egress"],
                egress: [
                  {
                    to: binding.proxy.addresses.map((address) => ({
                      ipBlock: { cidr: `${address}/32` },
                    })),
                    ports: [{ protocol: "TCP", port: binding.proxy.port }],
                  },
                ],
              },
            },
          ]
        : []),
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

  private async listNetworkPolicies(namespace: string): Promise<Resource[]> {
    const policies = await this.request((api) =>
      api.list<Resource>("networking.k8s.io/v1", "NetworkPolicy", namespace),
    );
    if (policies.metadata?._continue) {
      throw new Error("Cannot inspect the complete additive NetworkPolicy set.");
    }
    return policies.items;
  }

  private *egressRules(spec: Resource["spec"]) {
    for (const raw of Array.isArray(spec?.egress) ? spec.egress : []) {
      const rule = asRecord(raw);
      const peers = Array.isArray(rule?.to) && rule.to.length > 0 ? rule.to : [{}];
      yield { rule, peers };
    }
  }

  private isPrivateRange(cidr: string): boolean {
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
  }

  private verifyNoDirectPublicPeer(
    peer: Record<string, unknown>,
    block: Record<string, unknown> | undefined,
    uid: string | undefined,
  ): void {
    if (!block && peer.namespaceSelector === undefined && peer.podSelector === undefined) {
      throw new ChannelPublicEgressPolicyConflict("unspecified-destinations", uid);
    }
    if (block && !this.isPrivateRange(String(block.cidr))) {
      throw new ChannelPublicEgressPolicyConflict("ip-block-outside-allowed-ranges", uid);
    }
  }

  async verifyProspectiveGatewayDirectEgressGuard(
    namespace: string,
    agents: readonly Pick<AgentRevision, "namespaceId" | "agentId">[],
  ): Promise<void> {
    // Both labels are present at activation. Their values are irrelevant to the
    // Worker predicate after deferring selectors that test either generated value.
    const sources = agents.map((agent) => gatewaySourceLabels(agent, "", ""));
    for (const policy of await this.listNetworkPolicies(namespace)) {
      const selector = policy.spec?.podSelector;
      if (
        dependsOnGeneratedGatewayLabel(selector) ||
        !sources.some((source) => maySelect(selector, source))
      ) {
        continue;
      }
      for (const { peers } of this.egressRules(policy.spec)) {
        for (const rawPeer of peers) {
          const peer = asRecord(rawPeer) ?? {};
          this.verifyNoDirectPublicPeer(peer, asRecord(peer.ipBlock), policy.metadata.uid);
        }
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
    for (const namespace of new Set([binding.namespace, this.options.envoyNamespace])) {
      for (const policy of await this.listNetworkPolicies(namespace)) {
        // Kubernetes list entries can omit kind; the list operation fixes it.
        const spec = networkPolicyFields({ ...policy, kind: "NetworkPolicy" }, false).spec;
        if (namespace === binding.namespace && maySelect(spec?.podSelector, source)) {
          for (const { rule, peers } of this.egressRules(spec)) {
            for (const rawPeer of peers) {
              const peer = asRecord(rawPeer) ?? {};
              const block = asRecord(peer.ipBlock);
              this.verifyNoDirectPublicPeer(peer, block, policy.metadata.uid);
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
          if (binding.proxy) {
            for (const { rule, peers } of this.egressRules(spec)) {
              for (const rawPeer of peers) {
                this.verifyFleetProxyEgress(rule ?? {}, asRecord(rawPeer) ?? {});
              }
            }
          }
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

  private verifyFleetProxyEgress(
    rule: Record<string, unknown>,
    peer: Record<string, unknown>,
  ): void {
    const ports = Array.isArray(rule.ports) ? rule.ports.map(asRecord) : [];
    const onlyPort = (port: number): boolean =>
      ports.length === 1 &&
      ports[0]?.port === port &&
      (ports[0]?.protocol === undefined || ports[0]?.protocol === "TCP") &&
      ports[0]?.endPort === undefined;
    const block = asRecord(peer.ipBlock);
    if (block) {
      if (block.cidr === "0.0.0.0/0") {
        const exclusions = new Set(Array.isArray(block.except) ? block.except : []);
        if (
          [...CHANNEL_EGRESS_EXCLUDED_IPV4_CIDRS, ...this.options.excludedCidrs]
            .filter((cidr) => !cidr.includes(":"))
            .every((cidr) => exclusions.has(cidr))
        ) {
          return;
        }
      } else if (
        typeof block.cidr === "string" &&
        (!Array.isArray(block.except) || block.except.length === 0)
      ) {
        for (const endpoint of this.options.upstreamProxies ?? []) {
          const parsed = new URL(endpoint.url);
          const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
          if (endpoint.addresses.includes(block.cidr) && onlyPort(port)) {
            return;
          }
        }
      }
      throw new Error(
        "An additive NetworkPolicy broadens Envoy proxy egress beyond Installation scope.",
      );
    }
    const namespace = asRecord(asRecord(peer.namespaceSelector)?.matchLabels);
    const labels = asRecord(asRecord(peer.podSelector)?.matchLabels);
    if (
      peer.namespaceSelector === undefined &&
      labels?.["control-plane"] === "envoy-gateway" &&
      onlyPort(18000)
    ) {
      return;
    }
    if (
      namespace?.["kubernetes.io/metadata.name"] === "kube-system" &&
      labels?.["k8s-app"] === "kube-dns" &&
      ports.length > 0 &&
      ports.every(
        (entry) =>
          [53, 5353].includes(Number(entry?.port)) &&
          ["TCP", "UDP"].includes(String(entry?.protocol)) &&
          entry?.endPort === undefined,
      )
    ) {
      return;
    }
    throw new Error("An additive NetworkPolicy grants an unscoped private Envoy destination.");
  }

  async prepare(
    revision: AgentRevision,
    namespace: string,
    routing: PreparedChannelRouting,
    context?: ComputeRevisionContext,
  ): Promise<void> {
    const { uid } = await this.fleet();
    const proxy = await this.prepareProxy(revision, namespace, context);
    if (proxy && proxy.binding.gatewayUid !== uid) {
      throw new Error("The admitted channel proxy Gateway was replaced.");
    }
    let binding = await this.reserve(revision, namespace, routing, uid, proxy?.binding);
    await this.verifyPolicySet(binding);
    if (proxy?.encodedCredential) {
      binding = await this.fillCredentialSlot(binding, proxy.encodedCredential);
      await this.waitCredentialRoute(binding, true);
    }
    binding = await this.transition(binding, "active", routing.destinations, uid);
    await this.waitInstalled(binding, uid, routing.destinations);
    await this.waitSds(binding, true);
    await this.reconcileGrants(binding);
    await this.verifyPolicySet(binding);
    routing.binding = binding;
    routing.proxyUrl = `http://${this.options.serviceName}.${this.options.envoyNamespace}.svc:${binding.port}`;
  }

  private async requireStoppedSource(binding: ChannelEgressBinding): Promise<void> {
    if (!(await this.read(this.header("Namespace", binding.namespace, "", "v1")))) {
      return;
    }
    // Policy readback is not CNI acknowledgement. Do not reuse a port while an
    // old source Pod exists or its controllers can still recreate one.
    for (const kind of ["Deployment", "ReplicaSet", "Pod"]) {
      const listed = await this.request((api) =>
        api.list<Resource>(kind === "Pod" ? "v1" : "apps/v1", kind, binding.namespace),
      );
      if (listed.metadata?._continue) {
        throw new Error("Channel source workload inventory is incomplete.");
      }
      for (const resource of listed.items) {
        const labels =
          kind === "Pod"
            ? resource.metadata.labels
            : asRecord(asRecord(asRecord(resource.spec?.template)?.metadata)?.labels);
        if (labels?.[CHANNEL_EGRESS_BINDING_LABEL] !== binding.id) {
          continue;
        }
        if (kind === "Pod" || resource.spec?.replicas !== 0) {
          throw new Error(
            "Channel source workloads must terminate before their listener port is released.",
          );
        }
      }
    }
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
      await this.requireStoppedSource(binding);
      await this.clearCredentialSlot(denied);
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
