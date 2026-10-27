import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { Agent, WebSocket } from "undici";
import { createKubernetesClientConfiguration } from "../kubernetes/client.ts";
import type { KubernetesAuthentication } from "../kubernetes/authentication.ts";
import { requireWorkspaceSetupConfiguration } from "../compute/workspace-setup-runtime.ts";
import { strandsBoxResources } from "./strands-box-resources.ts";
import { KubernetesObjectApi, type KubernetesObject } from "@kubernetes/client-node";
import { requireConfiguration } from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  ErrorDetail,
  OpenClawConfigurationDocument,
  RevisionHarnessDescriptor,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxHarnessEndpoint,
  SandboxHarnessObservation,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxLogContext,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  SandboxRevisionUnsupportedError,
  SandboxWorkspaceSetupRefusedError,
} from "@openclaw-enterprise/occ";
import { asRecord, sha256Hex, immutableCopy } from "@openclaw-enterprise/utils";
import { setTimeout as delay } from "node:timers/promises";

export interface StrandsBoxOptions {
  readonly kubernetes: {
    readonly seccompProfile: string;
    readonly nodeSelector: Readonly<Record<string, string>>;
    readonly controlPlanePeer: {
      readonly namespace: string;
      readonly podLabels: Readonly<Record<string, string>>;
    };
  };
  readonly policy: {
    readonly network: {
      readonly endpoints: readonly { readonly host: string; readonly ports: readonly number[] }[];
    };
  };
}

export const configurationSchema = Object.freeze({
  type: "object",
  required: ["kubernetes", "policy"],
  additionalProperties: false,
  properties: {
    kubernetes: {
      type: "object",
      required: ["seccompProfile", "nodeSelector", "controlPlanePeer"],
      additionalProperties: false,
      properties: {
        seccompProfile: { type: "string", minLength: 1, maxLength: 240 },
        controlPlanePeer: {
          type: "object",
          required: ["namespace", "podLabels"],
          additionalProperties: false,
          properties: {
            namespace: { type: "string", minLength: 1 },
            podLabels: {
              type: "object",
              minProperties: 1,
              additionalProperties: { type: "string", minLength: 1 },
            },
          },
        },
        nodeSelector: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: "string", minLength: 1 },
        },
      },
    },
    policy: {
      type: "object",
      required: ["network"],
      additionalProperties: false,
      properties: {
        network: {
          type: "object",
          required: ["endpoints"],
          additionalProperties: false,
          properties: {
            endpoints: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                required: ["host", "ports"],
                additionalProperties: false,
                properties: {
                  host: {
                    type: "string",
                    minLength: 1,
                    maxLength: 253,
                    pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
                  },
                  ports: {
                    type: "array",
                    minItems: 1,
                    maxItems: 16,
                    uniqueItems: true,
                    items: { type: "integer", minimum: 1, maximum: 65535 },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

export function validateConfiguration(input: Readonly<StrandsBoxOptions>): readonly ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  const profile = input.kubernetes?.seccompProfile;
  if (
    typeof profile !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(profile) ||
    profile.split("/").some((part) => ["", ".", ".."].includes(part))
  ) {
    errors.push({
      path: "/kubernetes/seccompProfile",
      code: "INVALID_VALUE",
      message: "Use an exact node-local relative profile path without traversal.",
    });
  }
  if (input.kubernetes?.nodeSelector?.["kubernetes.io/arch"] !== "arm64") {
    errors.push({
      path: "/kubernetes/nodeSelector",
      code: "INVALID_VALUE",
      message: "Select explicitly qualified ARM64 nodes.",
    });
  }
  return errors;
}

const MANAGED = "openclaw.dev/strands-box";
const OWNER = "openclaw.dev/namespace";
const AGENT = "openclaw.dev/agent";
const REVISION = "openclaw.dev/revision";
const HASH = "openclaw.dev/strands-box-input-sha256";

function api(context: SandboxNamespaceContext): KubernetesObjectApi {
  if (!(context.kubernetes instanceof KubernetesObjectApi)) {
    throw new Error("Strands Box requires Compute's Kubernetes object client.");
  }
  context.signal.throwIfAborted();
  return context.kubernetes;
}
function missing(error: unknown): boolean {
  const value = asRecord(error);
  return [value?.code, value?.statusCode, asRecord(value?.response)?.statusCode].includes(404);
}
async function read(
  context: SandboxNamespaceContext,
  ref: KubernetesObject,
): Promise<KubernetesObject | undefined> {
  try {
    if (!ref.metadata?.name || !ref.apiVersion || !ref.kind) {
      throw new Error("Invalid resource reference.");
    }
    return await api(context).read({
      apiVersion: ref.apiVersion,
      kind: ref.kind,
      metadata: {
        name: ref.metadata.name,
        ...(ref.metadata.namespace ? { namespace: ref.metadata.namespace } : {}),
      },
    });
  } catch (error) {
    if (missing(error)) {
      return undefined;
    }
    throw error;
  }
}
function name(namespaceId: string, agentId: string, revisionId: string): string {
  return `strands-${sha256Hex(JSON.stringify([namespaceId, agentId, revisionId]), 32)}`;
}
function owned(resource: KubernetesObject, namespaceId: string, driverId: string): void {
  const labels = resource.metadata?.labels;
  if (
    labels?.[MANAGED] !== sha256Hex(driverId, 20) ||
    labels?.[OWNER] !== namespaceId ||
    !labels?.[AGENT] ||
    !labels?.[REVISION] ||
    resource.metadata?.name !== name(namespaceId, labels[AGENT], labels[REVISION])
  ) {
    throw new Error("Strands Box resource ownership does not match the requested scope.");
  }
}

export class StrandsBoxSandboxDriver implements SandboxDriver {
  static readonly configurationSchema = configurationSchema;
  static readonly validateConfiguration = validateConfiguration;
  readonly capability = "sandbox" as const;
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  readonly implementation = "strands-box";
  readonly harnessHome = "/home/node";
  readonly id: string;
  private readonly options: StrandsBoxOptions;
  private readonly authentication: KubernetesAuthentication;
  private observer?: Promise<KubernetesObjectApi>;

  constructor(
    options: StrandsBoxOptions,
    selection: { readonly id: string; readonly authentication: KubernetesAuthentication },
  ) {
    requireConfiguration(StrandsBoxSandboxDriver, options);
    this.options = immutableCopy(options);
    this.id = selection.id;
    this.authentication = immutableCopy(selection.authentication);
  }

  configureAgent(
    configuration: Readonly<OpenClawConfigurationDocument>,
    harness: Readonly<RevisionHarnessDescriptor>,
  ): OpenClawConfigurationDocument {
    this.requireHarness(harness);
    function object(value: unknown): Record<string, unknown> {
      if (value === undefined) {
        return {};
      }
      const record = asRecord(value);
      if (!record) {
        throw new SandboxRevisionUnsupportedError(
          "SANDBOX_HARNESS_UNSUPPORTED",
          "Strands Box requires object-shaped Codex configuration.",
        );
      }
      return record;
    }
    const plugins = object(configuration.plugins);
    const entries = object(plugins.entries);
    const codex = object(entries.codex);
    const config = object(codex.config);
    const { networkProxy: _networkProxy, ...appServer } = object(config.appServer);
    // Box owns process, filesystem and network isolation. A native proxy or
    // workspace-write profile would require a second, unavailable sandbox.
    // Preserve the admitted approval policy and keep its reviewer human-owned.
    return immutableCopy({
      ...configuration,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          codex: {
            ...codex,
            enabled: true,
            config: {
              ...config,
              appServer: {
                ...appServer,
                sandbox: "danger-full-access",
                approvalsReviewer: "user",
              },
            },
          },
        },
      },
    });
  }

  private requireHarness(harness: Readonly<RevisionHarnessDescriptor>): void {
    if (harness.id !== "codex" || harness.mode !== "dedicated") {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "Strands Box currently requires dedicated Codex.",
      );
    }
  }

  harnessResource(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef {
    if (
      context.revision.namespaceId !== context.namespace.id ||
      context.revision.sandboxDriverId !== this.id
    ) {
      throw new Error("Strands Box revision ownership does not match.");
    }
    return {
      namespaceName: context.namespace.name,
      resourceName: name(context.namespace.id, context.revision.agentId, context.revision.id),
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
    };
  }

  async observeHarness(context: SandboxLogContext): Promise<SandboxHarnessObservation> {
    this.harnessResource(context);
    this.observer ??= createKubernetesClientConfiguration(
      this.authentication,
      (message) => new Error(message),
    ).then(({ sdk, clientConfiguration }) => new sdk.KubernetesObjectApi(clientConfiguration));
    const client = await this.observer;
    context.signal.throwIfAborted();
    const selector = Object.entries(this.labels(context))
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    const deployments = await client.list(
      "apps/v1",
      "Deployment",
      context.namespace.name,
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
    );
    if (deployments.items.length === 0) {
      return { state: "lost", code: "SANDBOX_MISSING" };
    }
    if (deployments.items.length !== 1) {
      throw new Error("Ambiguous Strands Box revision resources.");
    }
    owned(deployments.items[0]!, context.namespace.id, this.id);
    if (deployments.items[0]!.metadata?.deletionTimestamp) {
      return { state: "lost", code: "SANDBOX_DELETING" };
    }
    const pods = await client.list(
      "v1",
      "Pod",
      context.namespace.name,
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
    );
    if (pods.items.length !== 1) {
      return { state: "starting" };
    }
    const status = asRecord(asRecord(pods.items[0])?.status);
    const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
    return conditions.some(
      (condition) =>
        asRecord(condition)?.type === "Ready" && asRecord(condition)?.status === "True",
    )
      ? { state: "running" }
      : { state: "starting" };
  }

  async workspaceNodePeerLabels(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const ref = this.harnessResource(context);
    const deployment = await read(context, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { namespace: ref.namespaceName, name: ref.resourceName },
    });
    if (!deployment) {
      return undefined;
    }
    owned(deployment, context.namespace.id, this.id);
    return this.labels(context);
  }

  async harnessPeerLabels(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<Readonly<Record<string, string>> | undefined> {
    return this.workspaceNodePeerLabels(context);
  }

  private labels(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): Readonly<Record<string, string>> {
    return {
      [MANAGED]: sha256Hex(this.id, 20),
      [OWNER]: context.namespace.id,
      [AGENT]: context.revision.agentId,
      [REVISION]: context.revision.id,
      "openclaw.dev/workload-role": "agent",
    };
  }

  validateWorkspaceSetup(
    harness: Readonly<RevisionHarnessDescriptor>,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void {
    this.requireHarness(harness);
    requireWorkspaceSetupConfiguration(
      configuration,
      ["/home/node/.openclaw/workspace", "/home/node/workspace"],
      () =>
        new SandboxWorkspaceSetupRefusedError("Strands Box requires the prepared main workspace."),
    );
  }

  async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    this.requireHarness(context.revision.harness);
    const ref = this.harnessResource(context);
    if (context.requirements.credentialAttachments.length !== 0) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "Strands Box does not support Credential Gateway attachments in this phase.",
      );
    }
    const hash = sha256Hex(JSON.stringify([2, context.requirements, this.options]));
    // A completed preparation is immutable, including its exact input identity.
    // Do not re-read an enrollment Secret that Compute may already have retired.
    const existing = await read(context, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { namespace: ref.namespaceName, name: ref.resourceName },
    });
    if (existing) {
      owned(existing, context.namespace.id, this.id);
      if (existing.metadata?.annotations?.[HASH] !== hash || existing.metadata.deletionTimestamp) {
        throw new Error("Strands Box revision Pod is not adoptable.");
      }
      return ref;
    }
    const transportHash = await this.transportVerifier(context);
    const gateway = await this.gatewayRoute(context);
    const cidrs = [];
    for (const endpoint of this.options.policy.network.endpoints) {
      const addresses = await lookup(endpoint.host, { all: true });
      for (const address of addresses) {
        for (const port of endpoint.ports) {
          cidrs.push({ cidr: `${address.address}/${address.family === 4 ? 32 : 128}`, port });
        }
      }
    }
    const resources = strandsBoxResources(
      context,
      this.options,
      ref.resourceName,
      this.labels(context),
      hash,
      transportHash,
      gateway,
      cidrs,
    );
    // Preflight all names before creating any object. An ownership collision
    // must not partially overwrite an unrelated workload's configuration.
    for (const resource of resources) {
      const current = await read(context, resource);
      if (current) {
        owned(current, context.namespace.id, this.id);
        if (current.metadata?.annotations?.[HASH] !== hash) {
          throw new Error("Strands Box immutable inputs differ.");
        }
      }
    }
    for (const resource of resources) {
      if (await read(context, resource)) {
        continue;
      }
      try {
        await api(context).create(resource);
      } catch (error) {
        const current = await read(context, resource);
        if (!current) {
          throw error;
        }
        owned(current, context.namespace.id, this.id);
        if (current.metadata?.annotations?.[HASH] !== hash) {
          throw error;
        }
      }
    }
    return ref;
  }

  private async transportVerifier(context: SandboxHarnessContext): Promise<string> {
    const variables = context.requirements.environment;
    const verifier = variables.find(({ name }) => name === "APP_TOKEN_SHA");
    if (verifier && "value" in verifier && /^[a-f0-9]{64}$/u.test(verifier.value)) {
      return verifier.value;
    }
    const token = variables.find(({ name }) => name === "APP_SERVER_TOKEN");
    if (!token || !("valueFrom" in token)) {
      throw new Error("Strands Box requires the prepared transport Secret or verifier.");
    }
    const secret = await read(context, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { namespace: context.namespace.name, name: token.valueFrom.secretKeyRef.name },
    });
    const labels = secret?.metadata?.labels;
    if (
      labels?.[OWNER] !== context.namespace.id ||
      labels[AGENT] !== context.revision.agentId ||
      labels[REVISION] !== context.revision.id
    ) {
      throw new Error("Prepared transport Secret must belong to this exact revision.");
    }
    const encoded = asRecord(asRecord(secret)?.data)?.[token.valueFrom.secretKeyRef.key];
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 65536) {
      throw new Error("Prepared transport credential is unavailable.");
    }
    // Preserve Compute's private Secret delivery to the original workload. Only
    // its one-way verifier is included in the supervisor's immutable manifest.
    return sha256Hex(Buffer.from(encoded, "base64").toString("utf8"));
  }

  private async gatewayRoute(
    context: SandboxHarnessContext,
  ): Promise<
    { host: string; port: number; egress: Readonly<Record<string, unknown>> } | undefined
  > {
    const reference = context.requirements.environment.find(
      (entry) => entry.name === "OPENCLAW_NODE_SETUP_CODE",
    );
    if (!reference) {
      return undefined;
    }
    if (!("valueFrom" in reference)) {
      throw new Error("Workspace enrollment must retain its private Secret reference.");
    }
    const secret = await read(context, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { namespace: context.namespace.name, name: reference.valueFrom.secretKeyRef.name },
    });
    if (
      secret?.metadata?.labels?.[AGENT] !== context.revision.agentId ||
      secret.metadata.labels[OWNER] !== context.namespace.id
    ) {
      throw new Error("Workspace setup Secret has different ownership.");
    }
    const encoded = asRecord(asRecord(secret)?.data)?.[reference.valueFrom.secretKeyRef.key];
    if (typeof encoded !== "string" || encoded.length > 100_000) {
      throw new Error("Workspace setup material is unavailable.");
    }
    let endpoint: URL;
    try {
      const code = Buffer.from(encoded, "base64")
        .toString("utf8")
        .trim()
        .replace(/^oc-pair:\/\//iu, "");
      const value = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
      if (
        typeof value.bootstrapToken !== "string" ||
        !value.bootstrapToken ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        value.expiresAtMs <= Date.now()
      ) {
        throw new Error("Invalid enrollment envelope");
      }
      endpoint = new URL(value.url);
    } catch {
      throw new Error("Workspace setup endpoint is invalid.");
    }
    if (
      !["ws:", "wss:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error("Strands Box requires an exact authenticated Gateway route.");
    }
    const port = Number(endpoint.port || (endpoint.protocol === "wss:" ? 443 : 80));
    const serviceHost = /^([a-z0-9-]+)\.([a-z0-9-]+)\.svc(?:\.cluster\.local)?$/u.exec(
      endpoint.hostname,
    );
    if (!serviceHost) {
      throw new Error(
        "Strands Box qualification currently requires an in-cluster Gateway Service endpoint.",
      );
    }
    const service = await read(context, {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: serviceHost[1]!, namespace: serviceHost[2]! },
    });
    const spec = asRecord(asRecord(service)?.spec);
    const selector = asRecord(spec?.selector);
    const ports = Array.isArray(spec?.ports) ? spec.ports : [];
    const selectedPort = ports
      .map(asRecord)
      .find(
        (entry) =>
          entry?.port === port && [undefined, "TCP"].includes(entry.protocol as string | undefined),
      );
    if (
      !selector ||
      Object.keys(selector).length === 0 ||
      !Object.values(selector).every((value) => typeof value === "string") ||
      !selectedPort
    ) {
      throw new Error("Gateway Service must select exact Pods and its prepared TCP port.");
    }
    let targetPort = selectedPort.targetPort ?? port;
    if (typeof targetPort === "string") {
      const query = Object.entries(selector)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(",");
      const pods = await api(context).list(
        "v1",
        "Pod",
        serviceHost[2],
        undefined,
        undefined,
        undefined,
        undefined,
        query,
      );
      const resolved = new Set<number>();
      for (const pod of pods.items) {
        const containers = asRecord(asRecord(pod)?.spec)?.containers;
        for (const container of Array.isArray(containers) ? containers : []) {
          const mappings = asRecord(container)?.ports;
          for (const mapping of Array.isArray(mappings) ? mappings : []) {
            const item = asRecord(mapping);
            if (item?.name === targetPort && typeof item.containerPort === "number") {
              resolved.add(item.containerPort);
            }
          }
        }
      }
      if (resolved.size !== 1) {
        throw new Error("Gateway Service target port is not uniquely resolved.");
      }
      targetPort = [...resolved][0]!;
    }
    if (
      typeof targetPort !== "number" ||
      !Number.isInteger(targetPort) ||
      targetPort < 1 ||
      targetPort > 65535
    ) {
      throw new Error("Invalid Gateway Service target port.");
    }
    return {
      host: endpoint.hostname,
      port,
      egress: {
        to: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": serviceHost[2] } },
            podSelector: { matchLabels: selector },
          },
        ],
        ports: [{ protocol: "TCP", port: targetPort }],
      },
    };
  }

  async harnessEndpoint(context: SandboxHarnessContext): Promise<SandboxHarnessEndpoint> {
    const ref = this.harnessResource(context);
    const service = await read(context, {
      apiVersion: "v1",
      kind: "Service",
      metadata: { namespace: ref.namespaceName, name: ref.resourceName },
    });
    if (!service) {
      throw new Error("Strands Box Harness Service is unavailable.");
    }
    owned(service, context.namespace.id, this.id);
    const expectedPort = context.requirements.environment.find(
      (entry) => entry.name === "APP_SERVER_PORT",
    );
    const port = expectedPort && "value" in expectedPort ? Number(expectedPort.value) : NaN;
    const spec = asRecord(asRecord(service)?.spec);
    const ports = Array.isArray(spec?.ports) ? spec.ports : [];
    if (
      !Number.isInteger(port) ||
      ports.length !== 1 ||
      asRecord(ports[0])?.port !== port ||
      asRecord(ports[0])?.targetPort !== port ||
      !isDeepStrictEqual(spec?.selector, this.labels(context))
    ) {
      throw new Error("Strands Box Harness Service differs from the revision.");
    }
    return {
      url: `ws://${ref.resourceName}.${ref.namespaceName}.svc:${port}`,
      workspaceRoot: "/home/node/workspace",
      codexPermissionProfile: ":danger-full-access",
    };
  }

  async harnessStatus(context: SandboxHarnessStatusContext): Promise<SandboxHarnessStatus> {
    const { url } = await this.harnessEndpoint(context);
    const endpoint = new URL(url.replace(/^ws:/u, "http:"));
    context.signal.throwIfAborted();
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(5000)]);
    const lifetime = new AbortController();
    const dispatcher = new Agent({
      connect: { signal: lifetime.signal },
      webSocket: { maxPayloadSize: 16384 },
    });
    const id = randomUUID();
    // A relay can upgrade a socket while the assigned app-server is stalled.
    // Initialize a new native session without starting a turn or consuming model tokens.
    const socket = new WebSocket(url, {
      dispatcher,
      headers: { authorization: `Bearer ${context.transportToken}` },
    });
    const serving = await new Promise<boolean>((resolve) => {
      const finish = (ready: boolean) => {
        signal.removeEventListener("abort", stop);
        resolve(ready);
      };
      const stop = () => finish(false);
      signal.addEventListener("abort", stop, { once: true });
      socket.addEventListener(
        "open",
        () => {
          socket.send(
            JSON.stringify({
              id,
              method: "initialize",
              params: { clientInfo: { name: "oce_harness_probe", version: "1" } },
            }),
          );
        },
        { once: true },
      );
      socket.addEventListener("message", ({ data }) => {
        if (typeof data !== "string") {
          return stop();
        }
        try {
          const message = asRecord(JSON.parse(data));
          if (message?.id === id) {
            const result = asRecord(message.result);
            finish(
              message.error === undefined &&
                typeof result?.userAgent === "string" &&
                result.userAgent.length > 0,
            );
          }
        } catch {
          stop();
        }
      });
      socket.addEventListener("error", stop, { once: true });
      socket.addEventListener("close", stop, { once: true });
    }).finally(() => {
      socket.close();
      lifetime.abort();
      return dispatcher.destroy();
    });
    context.signal.throwIfAborted();
    if (serving) {
      return { state: "serving" };
    }
    return new Promise<SandboxHarnessStatus>((resolve) => {
      endpoint.pathname = "/openclaw/runtime/status";
      const request = httpRequest(
        endpoint,
        {
          headers: { authorization: `Bearer ${context.transportToken}` },
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
        },
        (response) => {
          let bytes = Buffer.alloc(0);
          response.on("data", (chunk) => {
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.length > 16384) {
              response.destroy();
              resolve({ state: "starting" });
            }
          });
          response.on("error", () => resolve({ state: "starting" }));
          response.on("end", () => {
            try {
              const result = asRecord(JSON.parse(bytes.toString()));
              resolve(
                response.statusCode === 200 && result?.runtimeFailure
                  ? { state: "failed", runtimeFailure: result.runtimeFailure }
                  : { state: "starting" },
              );
            } catch {
              resolve({ state: "starting" });
            }
          });
        },
      );
      request.on("error", () => resolve({ state: "starting" }));
      request.end();
    });
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    const exact =
      context.revision === undefined
        ? undefined
        : this.harnessResource({ namespace: context.namespace, revision: context.revision });
    // Stop the workload before deleting its immutable inputs or exposure. A
    // retry resumes at the same ownership-fenced objects; PVCs are never listed.
    for (const [apiVersion, kind] of [
      ["apps/v1", "Deployment"],
      ["v1", "Service"],
      ["networking.k8s.io/v1", "NetworkPolicy"],
      ["v1", "Secret"],
      ["v1", "ConfigMap"],
    ] as const) {
      const resources = exact
        ? [
            await read(context, {
              apiVersion,
              kind,
              metadata: { namespace: exact.namespaceName, name: exact.resourceName },
            }),
          ].filter((resource): resource is KubernetesObject => resource !== undefined)
        : (
            await api(context).list(
              apiVersion,
              kind === "Secret" ? "ConfigMap" : kind,
              context.namespace.name,
              undefined,
              undefined,
              undefined,
              undefined,
              `${MANAGED}=${sha256Hex(this.id, 20)},${OWNER}=${context.namespace.id}`,
            )
          ).items;
      for (const candidate of resources) {
        const resource =
          !exact && kind === "Secret"
            ? await read(context, { apiVersion, kind, metadata: candidate.metadata! })
            : candidate;
        if (!resource) {
          continue;
        }
        owned(resource, context.namespace.id, this.id);
        const uid = resource.metadata?.uid;
        if (!uid) {
          throw new Error("Cannot remove a Strands Box resource without its exact UID.");
        }
        try {
          await api(context).delete(
            resource,
            undefined,
            undefined,
            undefined,
            undefined,
            "Foreground",
            { preconditions: { uid } },
          );
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
        }
        const deadline = Date.now() + 40_000;
        while (await read(context, resource)) {
          if (Date.now() >= deadline) {
            throw new Error("Strands Box resource deletion is not yet confirmed.");
          }
          await delay(250, undefined, { signal: context.signal });
        }
      }
    }
  }
}
