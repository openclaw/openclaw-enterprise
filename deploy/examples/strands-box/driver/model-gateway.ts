/**
 * The package's Credential Gateway view for the protected Harness model (O1 in the protected
 * inference design note). It offers one source type, an OpenAI API key for the configured model
 * route, and keeps the value in one Kubernetes Secret per source that this package owns ("S1"):
 * the API process writes it at register, update and removal; the Worker reads it once per Box
 * model request, answers that request, and keeps nothing. Box injects the value; the workload
 * holds only Box's placeholder. Values are never logged; only their digests leave this module.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import type {
  CredentialAttachmentStatus,
  CredentialGatewayContext,
  CredentialGatewayDriver,
  CredentialRevisionContext,
  CredentialSourceAttachment,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceStatus,
  CredentialSourceType,
  CredentialWithdrawalContext,
  DriverImplementation,
} from "@openclaw-enterprise/contracts";
import { DependencyUnavailableError, ScopeViolationError } from "@openclaw-enterprise/occ";
import { record } from "./control.ts";

/** The one source type: an OpenAI-compatible API key for the configured model route. */
export const MODEL_SOURCE_TYPE = "openai";
/** The attachment ref the host accepts: this prefix and the source ID, nothing secret. */
export const MODEL_ATTACHMENT_PREFIX = "strands-box-model:";
const AUTHORIZED_BASE_URL = "authorized_base_url";
const SECRET_KEY = "api_key";
/** The host's cap on a released value (host/credential-source.ts). */
const MAX_KEY_BYTES = 4_096;
const SOURCE_ANNOTATION = "openclaw.dev/credential-source-id";
const NAMESPACE_ANNOTATION = "openclaw.dev/namespace-id";
const MANAGED_BY = "openclaw-strands-box";
const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";
const KUBE_TIMEOUT_MS = 5_000;
const KUBE_REPLY_BYTES = 256 * 1024;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ModelGatewayConfiguration {
  /** The Kubernetes namespace that holds one Secret per model source, and nothing else. */
  readonly secretNamespace: string;
  /**
   * The Kubernetes API this package calls. Omit it inside the cluster: the API and Worker Pods
   * use their own ServiceAccount token and CA, read again for each call.
   */
  readonly kubernetes?: {
    readonly url: string;
    readonly caFile: string;
    readonly tokenFile: string;
  };
}

export const modelGatewaySchema: NonNullable<DriverImplementation["configurationSchema"]> = {
  type: "object",
  additionalProperties: false,
  required: ["secretNamespace"],
  properties: {
    secretNamespace: { type: "string", pattern: DNS_LABEL.source },
    kubernetes: {
      type: "object",
      additionalProperties: false,
      required: ["url", "caFile", "tokenFile"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 256 },
        caFile: { type: "string", minLength: 1, maxLength: 1024 },
        tokenFile: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
  },
};

export const modelSourceType: CredentialSourceType = Object.freeze({
  type: MODEL_SOURCE_TYPE,
  config: Object.freeze([
    Object.freeze({
      name: AUTHORIZED_BASE_URL,
      required: true,
      description:
        "The model route's base URL, exactly as the Sandbox configuration names it (controlledInference.modelBaseUrl).",
    }),
  ]),
  secrets: Object.freeze([
    Object.freeze({ name: SECRET_KEY, required: true, description: "The model API key." }),
  ]),
  rotation: "none",
  harnessAuth: Object.freeze({ modelProvider: "openai", loginMode: "api_key" as const }),
});

export function modelAttachmentRef(sourceId: string): string {
  return `${MODEL_ATTACHMENT_PREFIX}${sourceId}`;
}

/** SHA-256 of a value, for evidence and logs; never the value. */
export function valueDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Printable ASCII without spaces, as Box and the host accept a released value. */
function checkedKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_KEY_BYTES ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new ScopeViolationError(
      "The model API key must be 1 to 4096 printable characters without spaces.",
    );
  }
  return value;
}

/** One named Secret per source: a digest of the OCE Namespace and source IDs. */
export function modelSecretName(namespaceId: string, sourceId: string): string {
  return `strands-box-model-${createHash("sha256")
    .update(`${namespaceId}\0${sourceId}`)
    .digest("hex")
    .slice(0, 40)}`;
}

interface KubeReply {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
}

interface StoredKey {
  readonly value: string;
  readonly resourceVersion: string;
  readonly uid: string;
}

/**
 * The S1 store: the package's own Kubernetes Secrets, through the process's ServiceAccount. The
 * Role in `deploy/examples/strands-box/model-gateway-rbac.yaml` grants exactly the verbs used here
 * in the one namespace.
 */
export class ModelKeyStore {
  private readonly configuration: ModelGatewayConfiguration;

  constructor(configuration: ModelGatewayConfiguration) {
    this.configuration = configuration;
  }

  private async access(): Promise<{ url: URL; ca: string; token: string }> {
    const configured = this.configuration.kubernetes;
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT;
    const url =
      configured?.url ??
      (host === undefined || port === undefined
        ? undefined
        : `https://${host.includes(":") ? `[${host}]` : host}:${port}`);
    if (url === undefined) {
      throw new DependencyUnavailableError("The model key store has no Kubernetes API.");
    }
    try {
      const [ca, token] = await Promise.all([
        readFile(configured?.caFile ?? `${SERVICE_ACCOUNT}/ca.crt`, "utf8"),
        readFile(configured?.tokenFile ?? `${SERVICE_ACCOUNT}/token`, "utf8"),
      ]);
      return { url: new URL(url), ca, token: token.trim() };
    } catch {
      throw new DependencyUnavailableError("The model key store cannot read its credentials.");
    }
  }

  private async call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    name: string | undefined,
    body: unknown,
    signal: AbortSignal,
  ): Promise<KubeReply> {
    const { url, ca, token } = await this.access();
    const path =
      `/api/v1/namespaces/${this.configuration.secretNamespace}/secrets` +
      (name === undefined ? "" : `/${name}`);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    try {
      return await new Promise<KubeReply>((resolve, reject) => {
        const outgoing = request(
          {
            protocol: "https:",
            hostname: url.hostname.replace(/^\[|\]$/g, ""),
            port: url.port || 443,
            method,
            path,
            ca,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(payload === undefined
                ? {}
                : { "Content-Type": "application/json", "Content-Length": payload.length }),
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(KUBE_TIMEOUT_MS)]),
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > KUBE_REPLY_BYTES) {
                response.destroy(new Error("reply too large"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
              const text = Buffer.concat(chunks);
              chunks.forEach((chunk) => chunk.fill(0));
              let parsed: Record<string, unknown> | undefined;
              try {
                parsed = record(JSON.parse(text.toString("utf8")) as unknown);
              } catch {
                parsed = undefined;
              }
              text.fill(0);
              resolve({ status: response.statusCode ?? 0, body: parsed });
            });
          },
        );
        outgoing.on("error", reject);
        outgoing.end(payload);
      });
    } catch {
      signal.throwIfAborted();
      // Never carries the reply or the request: either may hold a value.
      throw new DependencyUnavailableError("The Kubernetes API did not answer the model key store.");
    } finally {
      payload?.fill(0);
    }
  }

  private owned(body: Record<string, unknown> | undefined, namespaceId: string, sourceId: string) {
    const annotations = record(record(body?.metadata)?.annotations);
    return (
      annotations?.[SOURCE_ANNOTATION] === sourceId &&
      annotations[NAMESPACE_ANNOTATION] === namespaceId
    );
  }

  /** The stored value, `undefined` when there is none, or a refusal when another owner holds it. */
  async read(
    namespaceId: string,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<StoredKey | undefined> {
    const reply = await this.call("GET", modelSecretName(namespaceId, sourceId), undefined, signal);
    if (reply.status === 404) return undefined;
    if (reply.status !== 200) {
      throw new DependencyUnavailableError("The Kubernetes API refused the model key read.");
    }
    if (!this.owned(reply.body, namespaceId, sourceId)) {
      throw new ScopeViolationError("The model key Secret is not owned by this source.");
    }
    const data = record(reply.body?.data);
    const encoded = data?.[SECRET_KEY];
    const metadata = record(reply.body?.metadata);
    const resourceVersion = metadata?.resourceVersion;
    const uid = metadata?.uid;
    if (
      typeof encoded !== "string" ||
      typeof resourceVersion !== "string" ||
      typeof uid !== "string"
    ) {
      throw new DependencyUnavailableError("The model key Secret has no value.");
    }
    return { value: Buffer.from(encoded, "base64").toString("utf8"), resourceVersion, uid };
  }

  private manifest(namespaceId: string, sourceId: string, value: string, version?: string) {
    return {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: modelSecretName(namespaceId, sourceId),
        namespace: this.configuration.secretNamespace,
        labels: { "app.kubernetes.io/managed-by": MANAGED_BY },
        annotations: { [SOURCE_ANNOTATION]: sourceId, [NAMESPACE_ANNOTATION]: namespaceId },
        ...(version === undefined ? {} : { resourceVersion: version }),
      },
      data: { [SECRET_KEY]: Buffer.from(value).toString("base64") },
    };
  }

  /** Create the source's Secret; a replay after an uncertain create replaces this source's own. */
  async create(
    namespaceId: string,
    sourceId: string,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    const reply = await this.call(
      "POST",
      undefined,
      this.manifest(namespaceId, sourceId, value),
      signal,
    );
    if (reply.status === 201 || reply.status === 200) return;
    if (reply.status === 409 && (await this.replace(namespaceId, sourceId, value, signal))) return;
    throw new DependencyUnavailableError("The Kubernetes API refused the model key Secret.");
  }

  /** Replace this source's value. False when the source has no Secret. */
  async replace(
    namespaceId: string,
    sourceId: string,
    value: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const current = await this.read(namespaceId, sourceId, signal);
    if (current === undefined) return false;
    const reply = await this.call(
      "PUT",
      modelSecretName(namespaceId, sourceId),
      this.manifest(namespaceId, sourceId, value, current.resourceVersion),
      signal,
    );
    if (reply.status !== 200) {
      throw new DependencyUnavailableError("The Kubernetes API refused the model key update.");
    }
    return true;
  }

  /**
   * Idempotent: an absent Secret is removed; another owner's Secret is never touched. The DELETE
   * carries the read's `uid` and `resourceVersion` as preconditions (finding 3302), so a Secret
   * replaced or changed after the ownership check is never deleted on that check: a conflict
   * reads again, checks ownership again, and retries a bounded number of times.
   */
  async remove(namespaceId: string, sourceId: string, signal: AbortSignal): Promise<void> {
    const name = modelSecretName(namespaceId, sourceId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.read(namespaceId, sourceId, signal);
      if (current === undefined) return;
      const reply = await this.call(
        "DELETE",
        name,
        {
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: current.uid, resourceVersion: current.resourceVersion },
        },
        signal,
      );
      if (reply.status === 409) continue;
      if (reply.status !== 200 && reply.status !== 202 && reply.status !== 404) {
        throw new DependencyUnavailableError("The Kubernetes API refused the model key removal.");
      }
      if ((await this.read(namespaceId, sourceId, signal)) !== undefined) {
        throw new DependencyUnavailableError("The model key Secret was not removed.");
      }
      return;
    }
    throw new DependencyUnavailableError("The model key Secret kept changing during removal.");
  }
}

/** The normalized model base URL, or `undefined`: HTTPS, no credentials, query or fragment. */
export function modelBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256 || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  return url.toString().replace(/\/$/, "");
}

/** What the paired Sandbox tells this view about one revision's live Box execution. */
export interface ModelHost {
  /** The host's view of this revision's model attachment, or `undefined` without an execution. */
  attachment(
    revisionId: string,
    signal: AbortSignal,
  ): Promise<{ readonly sourceId: string; readonly revoked: boolean } | undefined>;
  /**
   * Record the host's durable revoke receipt for this revision's source, with or without a live
   * execution of it (finding 3301); `undefined` when the revision is not this host's.
   */
  revoke(
    withdrawal: Pick<CredentialWithdrawalContext, "namespace" | "revision">,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<{ readonly receiptId: string } | undefined>;
}

/**
 * The Gateway view. `route` is the configured model route (`controlledInference.modelBaseUrl`):
 * a source authorizes exactly that route, and a revision's model provider must name it.
 */
export function createModelGateway(
  id: string,
  implementation: string,
  route: string,
  store: ModelKeyStore,
  host: ModelHost,
): CredentialGatewayDriver {
  const own = (source: { driverId?: string; namespaceId: string }, namespaceId: string) =>
    source.driverId === id && source.namespaceId === namespaceId;
  const validate = (input: Pick<CredentialSourceInput, "type" | "config">) => {
    if (input.type !== MODEL_SOURCE_TYPE) {
      throw new ScopeViolationError("This Credential Gateway offers only the model source type.");
    }
    if (
      Object.keys(input.config).some((key) => key !== AUTHORIZED_BASE_URL) ||
      modelBaseUrl(input.config[AUTHORIZED_BASE_URL]) !== route
    ) {
      throw new ScopeViolationError(
        "authorized_base_url must be the Sandbox's configured model route.",
      );
    }
    return Object.freeze({ [AUTHORIZED_BASE_URL]: route });
  };
  const status = async (context: CredentialSourceContext): Promise<CredentialSourceStatus> => {
    try {
      const stored = await store.read(context.namespace.id, context.source.id, context.signal);
      return stored === undefined ? { state: "absent" } : { state: "ready" };
    } catch (error) {
      if (error instanceof ScopeViolationError) {
        return { state: "failed", reason: "The model key Secret is not owned by this source." };
      }
      throw error;
    }
  };
  return {
    id,
    implementation,
    capability: "credential_gateway",
    async listSourceTypes(_context: CredentialGatewayContext) {
      return [modelSourceType];
    },
    validateSourceConfig: validate,
    async registerSource(context, input) {
      validate(input);
      if (!own(context.source, context.namespace.id)) {
        throw new ScopeViolationError("The credential source is not owned by this gateway.");
      }
      await store.create(
        context.namespace.id,
        context.source.id,
        checkedKey(input.secrets[SECRET_KEY]),
        context.signal,
      );
      return { state: "ready" };
    },
    /** Rotation: the next Box model request reads the new value; nothing restarts. */
    async updateSource(context, input) {
      validate(input);
      if (!own(context.source, context.namespace.id)) {
        throw new ScopeViolationError("The credential source is not owned by this gateway.");
      }
      const replaced = await store.replace(
        context.namespace.id,
        context.source.id,
        checkedKey(input.secrets[SECRET_KEY]),
        context.signal,
      );
      return replaced ? { state: "ready" } : { state: "absent" };
    },
    sourceStatus: status,
    async removeSource(context) {
      await store.remove(context.namespace.id, context.source.id, context.signal);
    },
    async attachForRevision(
      context: CredentialRevisionContext,
    ): Promise<readonly CredentialSourceAttachment[]> {
      const { revision } = context;
      const [source] = context.sources;
      const provider = record(record(revision.harness.configuration)?.modelProvider);
      if (
        context.sources.length !== 1 ||
        source === undefined ||
        !own(source, context.namespace.id) ||
        source.type !== MODEL_SOURCE_TYPE ||
        revision.harness.id !== "codex" ||
        revision.harness.mode !== "dedicated" ||
        revision.harnessAuth.method !== "credential_source" ||
        revision.harnessAuth.sourceId !== source.id ||
        modelBaseUrl(source.config[AUTHORIZED_BASE_URL]) !== route ||
        modelBaseUrl(provider?.baseUrl) !== route
      ) {
        throw new ScopeViolationError(
          "This Credential Gateway attaches exactly the dedicated Codex model source for its route.",
        );
      }
      if ((await store.read(context.namespace.id, source.id, context.signal)) === undefined) {
        throw new DependencyUnavailableError("The model source has no stored key.");
      }
      return Object.freeze([
        Object.freeze({ sourceId: source.id, ref: modelAttachmentRef(source.id) }),
      ]);
    },
    async attachmentStatus(context): Promise<readonly CredentialAttachmentStatus[]> {
      const statuses: CredentialAttachmentStatus[] = [];
      for (const source of context.sources) {
        const stored = await store.read(context.namespace.id, source.id, context.signal);
        const live = await host.attachment(context.revision.id, context.signal);
        const state =
          stored === undefined
            ? "absent"
            : live === undefined || live.sourceId !== source.id
              ? "pending"
              : live.revoked
                ? "revoked"
                : "ready";
        statuses.push(Object.freeze({ sourceId: source.id, state }));
      }
      return Object.freeze(statuses);
    },
    /**
     * `revoked` only on the host's receipt: from then on the host refuses this revision's model
     * requests before any byte reaches the provider, and keeps the receipt across its restart.
     * The receipt is written even when no execution of the revision runs now (failed, or the host
     * restarted without one; finding 3301), so a later start of that revision is refused too.
     */
    async withdraw(context: CredentialWithdrawalContext): Promise<CredentialAttachmentStatus> {
      const live = await host.attachment(context.revision.id, context.signal);
      if (live?.sourceId === context.sourceId && live.revoked) {
        return Object.freeze({ sourceId: context.sourceId, state: "revoked" });
      }
      const receipt = await host.revoke(context, context.sourceId, context.signal);
      return Object.freeze({
        sourceId: context.sourceId,
        state: receipt === undefined ? "pending" : "revoked",
      });
    },
  };
}
