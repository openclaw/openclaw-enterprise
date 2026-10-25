import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  openShellProfileMessage,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
  type OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import { wirePolicy } from "./openshell-wire-policy.ts";

const hosts = ["github.com", "api.github.com"] as const;
const owner = "openclaw.dev/joint-git-recipient";
const positive = /^[1-9]\d*$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Host = (typeof hosts)[number];
type Grant = Readonly<{ id: string; generation: string; scope: string }>;
interface Recipient {
  readonly host: Host;
  readonly providerName: string;
  readonly providerId: string;
  readonly profileVersion: string;
  readonly resourceVersion: string;
  readonly profile: OpenShellProviderProfile;
}
export class JointGitRecipientChangedError extends Error {
  constructor() {
    super("OpenShell joint Git recipient is not current.");
  }
}
function refuse(): never {
  throw new JointGitRecipientChangedError();
}

// A 256-bit digest fits in 50 base-36 digits; the provider name is only a lookup key.
function recipientLabels(fingerprint: string) {
  return {
    [owner]: BigInt("0x" + fingerprint)
      .toString(36)
      .padStart(50, "0"),
  };
}

export function jointTokenEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    return refuse();
  }
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.pathname !== "/token/git" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password ||
    u.href !== value
  ) {
    return refuse();
  }
  return u.href;
}

/** Compare the actual Gateway profile with its producer. A zero TTL is meaningful:
 * a missing duration enables credential caching, unlike an explicit zero. */
export async function verifyJointProfile(
  client: OpenShellGatewayClient,
  workspace: string,
  profile: OpenShellProviderProfile,
  signal: AbortSignal,
) {
  const stored = await client.getProviderProfile(workspace, profile.id, signal);
  if (
    !stored ||
    stored.id !== profile.id ||
    !positive.test(stored.resourceVersion) ||
    !stored.definition
  ) {
    return refuse();
  }
  const {
    resource_version: _rv,
    scope: _scope,
    source: _source,
    ...definition
  } = stored.definition;
  const expected = openShellProfileMessage(profile);
  if (!isDeepStrictEqual(wirePolicy(definition), wirePolicy(expected))) {
    // A present, empty protobuf Duration represents zero; normalize only that field.
    const credentials = definition.credentials;
    const expectedCredentials = expected.credentials;
    if (
      !Array.isArray(credentials) ||
      credentials.length !== 1 ||
      !Array.isArray(expectedCredentials) ||
      expectedCredentials.length !== 1
    ) {
      return refuse();
    }
    const actualGrant = asRecord(asRecord(credentials[0])?.token_grant);
    const expectedGrant = asRecord(asRecord(expectedCredentials[0])?.token_grant);
    const ttl = asRecord(actualGrant?.cache_ttl);
    if (
      !expectedGrant ||
      !actualGrant ||
      !ttl ||
      String(ttl.seconds ?? 0) !== "0" ||
      (ttl.nanos ?? 0) !== 0
    ) {
      return refuse();
    }
    const normalized = {
      ...definition,
      credentials: [
        {
          ...asRecord(credentials[0]),
          token_grant: { ...actualGrant, cache_ttl: expectedGrant.cache_ttl },
        },
      ],
    };
    if (!isDeepStrictEqual(wirePolicy(normalized), wirePolicy(expected))) {
      return refuse();
    }
  }
  if (
    profile.credentials[0]?.tokenGrant &&
    (!Array.isArray(definition.credentials) ||
      !asRecord(asRecord(asRecord(definition.credentials[0])?.token_grant)?.cache_ttl))
  ) {
    return refuse();
  }
  return stored.resourceVersion;
}

/** This owner provisions no stored credential or workload alias. A failed write is retained
 * by the caller's fenced bootstrap, including loss of either provider's acknowledgement. */
export async function provisionJointGit(
  input: {
    client: OpenShellGatewayClient;
    workspace: string;
    workspaceId: string;
    sandbox: string;
    revisionId: string;
    bindingId: string;
    installationId: string;
    grant: Grant;
    tokenEndpoint: string;
    projectedAssertion?: boolean;
    binaries: readonly string[];
    signal: AbortSignal;
  } & (
    | { restore: readonly Omit<Recipient, "profile">[]; beforeWrite?: never }
    | { restore?: never; beforeWrite: () => Promise<void> }
  ),
) {
  const {
    client,
    workspace,
    workspaceId,
    sandbox,
    revisionId,
    bindingId,
    grant,
    binaries,
    signal,
  } = input;
  const endpoint = jointTokenEndpoint(input.tokenEndpoint);
  if (
    !workspaceId ||
    !positive.test(input.installationId) ||
    !grant.id ||
    !grant.scope ||
    !positive.test(grant.generation)
  ) {
    return refuse();
  }
  const recipients: Recipient[] = [];
  for (const host of hosts) {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          workspaceId,
          workspace,
          sandbox,
          revisionId,
          bindingId,
          input.installationId,
          grant.id,
          grant.generation,
          grant.scope,
          host,
          endpoint,
          binaries,
          ...(input.projectedAssertion ? ["kubernetes-projected-token"] : []),
        ]),
      )
      .digest("hex");
    const name = "oce-joint-git-" + fingerprint.slice(0, 32);
    const labels = recipientLabels(fingerprint);
    const profile: OpenShellProviderProfile = {
      id: name,
      displayName: "GitHub installation " + host,
      category: "PROVIDER_PROFILE_CATEGORY_OTHER",
      credentials: [
        {
          name: "installation_token",
          envVars: [],
          required: true,
          authStyle: host === "github.com" ? "basic" : "bearer-required",
          headerName: "Authorization",
          tokenGrant: {
            ...(input.projectedAssertion && {
              assertion_source:
                "PROVIDER_CREDENTIAL_ASSERTION_SOURCE_KUBERNETES_PROJECTED_TOKEN" as const,
            }),
            token_endpoint: endpoint,
            audience: "https://" + host,
            jwt_svid_audience: endpoint,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            grant_type: "PROVIDER_CREDENTIAL_TOKEN_GRANT_TYPE_CLIENT_CREDENTIALS",
            cache_ttl: { seconds: "0", nanos: 0 },
          },
        },
      ],
      endpoints: [
        {
          host,
          port: 443,
          protocol: "rest",
          path: "/**",
          access:
            host === "github.com"
              ? "NETWORK_ACCESS_PRESET_READ_WRITE"
              : "NETWORK_ACCESS_PRESET_FULL",
        },
      ],
      binaries,
      inferenceCapable: false,
      annotations: { [owner]: fingerprint },
    };
    let provider;
    let profileVersion;
    if (input.restore) {
      const saved = input.restore[recipients.length];
      if (
        !saved ||
        saved.host !== host ||
        saved.providerName !== name ||
        input.restore.length !== hosts.length
      ) {
        return refuse();
      }
      profileVersion = await verifyJointProfile(client, workspace, profile, signal);
      provider = await client.getProvider(workspace, name, signal);
      if (
        !provider ||
        provider.id !== saved.providerId ||
        profileVersion !== saved.profileVersion ||
        provider.resourceVersion !== saved.resourceVersion
      ) {
        return refuse();
      }
    } else {
      if (
        (await client.getProviderProfile(workspace, name, signal)) ||
        (await client.getProvider(workspace, name, signal))
      ) {
        return refuse();
      }
      await input.beforeWrite();
      signal.throwIfAborted();
      await client.importProviderProfile(workspace, profile, signal);
      profileVersion = await verifyJointProfile(client, workspace, profile, signal);
      await input.beforeWrite();
      signal.throwIfAborted();
      provider = await client.createProvider(
        { workspace, name, type: name, labels, credentials: {} },
        signal,
      );
    }
    if (
      !provider.id ||
      provider.workspace !== workspace ||
      provider.profileWorkspace !== workspace ||
      provider.type !== name ||
      provider.name !== name ||
      !positive.test(provider.resourceVersion) ||
      !isDeepStrictEqual(provider.labels, labels) ||
      Object.keys(provider.config).length
    ) {
      return refuse();
    }
    recipients.push({
      host,
      providerName: name,
      providerId: provider.id,
      resourceVersion: provider.resourceVersion,
      profileVersion,
      profile,
    });
  }
  if (recipients[0]!.providerId === recipients[1]!.providerId) {
    return refuse();
  }
  return { client, workspace, workspaceId, sandbox, revisionId, bindingId, grant, recipients };
}
export type PreparedJointGit = Awaited<ReturnType<typeof provisionJointGit>>;

/** These are creation/attachment facts for the verifier, not an enrollment or readiness.
 * The authenticated supplier separately proves active credentials, rule digests and signer. */
export async function observeJointGit(
  entry: PreparedJointGit,
  box: OpenShellSandboxResponse,
  runtimeProvider: string,
  signal: AbortSignal,
) {
  if (
    box.spec?.restart_policy !== "SANDBOX_RESTART_POLICY_NEVER" ||
    !box.id ||
    box.name !== entry.sandbox ||
    box.workspace !== entry.workspace ||
    box.annotations["openclaw.dev/revision-id"] !== entry.revisionId ||
    !isDeepStrictEqual(box.spec?.providers, [
      runtimeProvider,
      ...entry.recipients.map((r) => r.providerName),
    ]) ||
    typeof box.spec?.provider_attachment_epoch !== "string" ||
    !uuid.test(box.spec.provider_attachment_epoch)
  ) {
    return refuse();
  }
  const epoch = box.spec.provider_attachment_epoch;
  const recipients = [];
  for (const r of entry.recipients) {
    const provider = await entry.client.getProvider(entry.workspace, r.providerName, signal);
    if (
      !provider ||
      provider.id !== r.providerId ||
      provider.resourceVersion !== r.resourceVersion ||
      provider.name !== r.providerName ||
      provider.type !== r.profile.id ||
      provider.workspace !== entry.workspace ||
      provider.profileWorkspace !== entry.workspace ||
      !isDeepStrictEqual(provider.labels, recipientLabels(r.profile.annotations[owner]!)) ||
      Object.keys(provider.config).length ||
      (await verifyJointProfile(entry.client, entry.workspace, r.profile, signal)) !==
        r.profileVersion
    ) {
      return refuse();
    }
    recipients.push({
      host: r.host,
      providerName: r.providerName,
      providerId: r.providerId,
      attachmentEpoch: epoch,
    });
  }
  signal.throwIfAborted();
  return { grant: entry.grant, runtimeProvider, recipients };
}

/** Each registered worker owns one set of live supervisor observations for its joint routes. */
export class JointGitSupervisorPods {
  private readonly locations = new Map<
    string,
    { uid?: string; lifetime: AbortController; generation: number }
  >();

  async read(
    namespace: string,
    sandboxId: string,
    read: (id: string, signal: AbortSignal) => Promise<string | undefined>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const key = JSON.stringify([namespace, sandboxId]);
    const before = this.locations.get(key) ?? { lifetime: new AbortController(), generation: 0 };
    this.locations.set(key, before);
    let uid: string | undefined;
    try {
      uid = await read(sandboxId, signal);
    } finally {
      // Each conflicting or failed Pod observation cancels the old permits, including
      // any waiting for a receipt. A stale read cannot replace a subsequent observation.
      if (!signal.aborted && !before.lifetime.signal.aborted && (!uid || uid !== before.uid)) {
        this.locations.set(key, {
          ...(uid && { uid }),
          lifetime: new AbortController(),
          generation: before.generation + 1,
        });
        before.lifetime.abort();
      }
    }
    const now = this.locations.get(key);
    // Concurrent confirmations of the very same transition can share its lifetime;
    // crossing two transitions (even back to the same UID) cannot revalidate a read.
    if (uid && now?.uid === uid && now.generation <= before.generation + 1 && !signal.aborted) {
      return { uid, lifetime: now.lifetime.signal };
    }
  }
  clear() {
    for (const location of this.locations.values()) {
      location.lifetime.abort();
    }
    this.locations.clear();
  }
}
