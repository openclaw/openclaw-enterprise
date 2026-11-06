import { createHash, randomBytes } from "node:crypto";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { numericErrorStatus } from "@openclaw-enterprise/utils";
import {
  authorizationSnapshot,
  publicGithubReadAuthorizationDigest,
  publicGithubReadPolicy,
  type PublicGithubReadPolicy,
  type PublicGithubReadAuthorization,
} from "../../repo/github/public-read/access.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const registryKey = "authorizations.json";
const stateKey = "retirement-state.json";
const stateMarker = "openclaw.dev/public-read-state-version";
const byteLimit = 1024 * 1024;
type Revision = Pick<
  AgentRevision,
  "id" | "namespaceId" | "agentId" | "revision" | "compute" | "harness" | "plugins"
>;
type Authorization = PublicGithubReadAuthorization & { withdrawn?: true };
type Identity = Pick<PublicGithubReadAuthorization, "installationId" | "namespaceId" | "agentId">;
type RetirementState = {
  version: 1;
  frontiers: Record<string, number>;
  bindings: Record<string, { lineage: string; ordinal: number }>;
  legacyDenied: Record<string, Identity>;
  unbound: string[];
};
type Lineage = [string, string, string, string, string, string, string, [string, string] | null];

function invalidState(): never {
  throw new Error("The public reader retirement metadata is invalid or missing.");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((key) => Object.hasOwn(value, key))
  );
}
function identity(value: unknown): value is string {
  return typeof value === "string" && /^[a-z\d_-]{1,128}$/i.test(value);
}
function name(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value
  );
}
function ordinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function lineage(value: string, installationId: string): Lineage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidState();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 8 ||
    parsed[0] !== installationId ||
    !parsed.slice(0, 3).every(identity) ||
    !name(parsed[3]) ||
    !name(parsed[4]) ||
    parsed[5] !== "codex" ||
    parsed[6] !== "dedicated" ||
    !(
      parsed[7] === null ||
      (Array.isArray(parsed[7]) && parsed[7].length === 2 && parsed[7].every(name))
    ) ||
    JSON.stringify(parsed) !== value
  ) {
    invalidState();
  }
  return parsed as Lineage;
}
function sameIdentity(entry: Identity, value: Lineage): boolean {
  return (
    entry.installationId === value[0] &&
    entry.namespaceId === value[1] &&
    entry.agentId === value[2]
  );
}
function own<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}
function dataBudget(data: unknown, binaryData: unknown) {
  // JSON includes key names, UTF-8 bytes and base64 overhead, conservatively
  // reserving the Kubernetes limit across every operator-owned data field too.
  if (Buffer.byteLength(JSON.stringify({ data, binaryData })) > byteLimit) {
    throw new Error("The public reader authorization registry is full.");
  }
}
function retirementState(
  raw: string | undefined,
  marker: string | undefined,
  entries: Record<string, Authorization>,
  installationId: string,
): RetirementState {
  if (raw === undefined && marker === undefined) {
    const state: RetirementState = {
      version: 1,
      frontiers: Object.create(null),
      bindings: Object.create(null),
      legacyDenied: Object.create(null),
      unbound: [],
    };
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.withdrawn === true) {
        state.legacyDenied[id] = {
          installationId: entry.installationId,
          namespaceId: entry.namespaceId,
          agentId: entry.agentId,
        };
      } else if (entry.withdrawn === undefined) {
        state.unbound.push(id);
      } else {
        invalidState();
      }
    }
    return state;
  }
  if (raw === undefined || marker !== "1") {
    invalidState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalidState();
  }
  if (
    !exact(parsed, ["version", "frontiers", "bindings", "legacyDenied", "unbound"]) ||
    parsed.version !== 1 ||
    !record(parsed.frontiers) ||
    !record(parsed.bindings) ||
    !record(parsed.legacyDenied) ||
    !Array.isArray(parsed.unbound) ||
    !parsed.unbound.every(identity) ||
    new Set(parsed.unbound).size !== parsed.unbound.length
  ) {
    invalidState();
  }
  const state = parsed as RetirementState;
  state.frontiers = Object.assign(Object.create(null), state.frontiers);
  state.bindings = Object.assign(Object.create(null), state.bindings);
  state.legacyDenied = Object.assign(Object.create(null), state.legacyDenied);
  for (const [key, value] of Object.entries(state.frontiers)) {
    lineage(key, installationId);
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidState();
    }
  }
  const boundOrdinals = new Set<string>();
  for (const [id, binding] of Object.entries(state.bindings)) {
    if (
      !identity(id) ||
      !exact(binding, ["lineage", "ordinal"]) ||
      typeof binding.lineage !== "string" ||
      !ordinal(binding.ordinal)
    ) {
      invalidState();
    }
    const owner = lineage(binding.lineage, installationId);
    const entry = own(entries, id);
    const numberKey = JSON.stringify([binding.lineage, binding.ordinal]);
    if (
      !entry ||
      entry.withdrawn !== undefined ||
      !sameIdentity(entry, owner) ||
      own(state.frontiers, binding.lineage) === undefined ||
      boundOrdinals.has(numberKey)
    ) {
      invalidState();
    }
    boundOrdinals.add(numberKey);
  }
  for (const [id, denied] of Object.entries(state.legacyDenied)) {
    if (
      !identity(id) ||
      !exact(denied, ["installationId", "namespaceId", "agentId"]) ||
      denied.installationId !== installationId ||
      !identity(denied.namespaceId) ||
      !identity(denied.agentId) ||
      own(entries, id)
    ) {
      invalidState();
    }
  }
  for (const [id, entry] of Object.entries(entries)) {
    if (
      entry.withdrawn !== undefined ||
      entry.installationId !== installationId ||
      (own(state.bindings, id) !== undefined) === state.unbound.includes(id)
    ) {
      invalidState();
    }
  }
  if (state.unbound.some((id) => !own(entries, id))) {
    invalidState();
  }
  return state;
}
export interface PublicGithubReadAuthorizationStoreOptions {
  readonly core: CoreV1Api;
  readonly namespace: string;
  readonly configMapName: string;
  readonly installationId: string;
  readonly driverId: string;
}

/** A verifier-only projection lets the reader avoid Kubernetes credentials. */
export class KubernetesPublicGithubReadAuthorizationStore {
  private readonly options: PublicGithubReadAuthorizationStoreOptions;
  constructor(options: PublicGithubReadAuthorizationStoreOptions) {
    this.options = options;
  }

  secretName(revision: Revision): string {
    return `public-github-read-${sha256(revision.id).slice(0, 24)}`;
  }

  private lineage(revision: Revision): string {
    const pin = revision.plugins?.driver;
    if (
      !identity(revision.id) ||
      !identity(revision.namespaceId) ||
      !identity(revision.agentId) ||
      !ordinal(revision.revision) ||
      revision.compute?.id !== this.options.driverId ||
      !name(revision.compute.implementation) ||
      revision.harness?.id !== "codex" ||
      revision.harness.mode !== "dedicated" ||
      (pin !== undefined && (!name(pin.id) || !name(pin.implementation)))
    ) {
      throw new Error(
        "The public reader revision identity, ordinal or admission lineage is invalid.",
      );
    }
    const key = JSON.stringify([
      this.options.installationId,
      revision.namespaceId,
      revision.agentId,
      revision.compute.id,
      revision.compute.implementation,
      revision.harness.id,
      revision.harness.mode,
      pin === undefined ? null : [pin.id, pin.implementation],
    ]);
    lineage(key, this.options.installationId);
    return key;
  }

  private async registry() {
    const object = await this.options.core.readNamespacedConfigMap({
      namespace: this.options.namespace,
      name: this.options.configMapName,
    });
    const bytes = object.data?.[registryKey];
    if (
      !object.metadata?.resourceVersion ||
      object.metadata.deletionTimestamp ||
      object.immutable === true ||
      object.metadata.labels?.["openclaw.dev/public-read-installation"] !==
        sha256(this.options.installationId).slice(0, 32) ||
      typeof bytes !== "string" ||
      Buffer.byteLength(bytes) > byteLimit
    ) {
      throw new Error("The public reader authorization registry is unavailable or foreign.");
    }
    dataBudget(object.data, object.binaryData);
    const parsed = JSON.parse(bytes) as Record<string, Authorization>;
    await authorizationSnapshot({ loadAuthorizations: () => parsed });
    const entries = Object.assign(Object.create(null), parsed) as Record<string, Authorization>;
    const state = retirementState(
      object.data?.[stateKey],
      object.metadata.annotations?.[stateMarker],
      entries,
      this.options.installationId,
    );
    return { object, entries, state };
  }

  private check(
    revision: Revision,
    key: string,
    entries: Record<string, Authorization>,
    state: RetirementState,
  ) {
    const entry = own(entries, revision.id);
    const denied = own(state.legacyDenied, revision.id);
    const owner = lineage(key, this.options.installationId);
    if ((entry && !sameIdentity(entry, owner)) || (denied && !sameIdentity(denied, owner))) {
      throw new Error("The public reader authorization belongs to a different Agent.");
    }
    const binding = own(state.bindings, revision.id);
    if (binding && (binding.lineage !== key || binding.ordinal !== revision.revision)) {
      throw new Error("The frozen public reader identity, ordinal or lineage cannot be changed.");
    }
    if (
      Object.entries(state.bindings).some(
        ([id, value]) =>
          id !== revision.id && value.lineage === key && value.ordinal === revision.revision,
      )
    ) {
      throw new Error("The public reader ordinal belongs to a different revision identity.");
    }
    return { entry, denied };
  }

  private preparing(
    revision: Revision,
    key: string,
    entries: Record<string, Authorization>,
    state: RetirementState,
  ) {
    const { entry, denied } = this.check(revision, key, entries, state);
    if (
      denied ||
      entry?.withdrawn ||
      (!entry && revision.revision <= (own(state.frontiers, key) ?? 0))
    ) {
      throw new Error(
        "The frozen public reader authorization cannot be restored after retirement.",
      );
    }
    return entry;
  }

  private async publish(
    revision: Revision,
    operation: "prepare" | "suspend" | "withdraw",
    change: (entry: Authorization | undefined) => Authorization | undefined,
  ): Promise<string> {
    const key = this.lineage(revision);
    for (let attempt = 0; attempt < 10; attempt++) {
      const { object, entries, state } = await this.registry();
      const { entry, denied } = this.check(revision, key, entries, state);
      for (const id of Object.keys(state.legacyDenied)) {
        delete entries[id];
      }
      if (operation === "prepare") {
        this.preparing(revision, key, entries, state);
      }
      const changed = operation === "withdraw" || denied ? undefined : change(entry);
      if (operation === "withdraw") {
        state.frontiers[key] = Math.max(own(state.frontiers, key) ?? 0, revision.revision);
        delete state.bindings[revision.id];
      } else if (changed !== undefined) {
        state.frontiers[key] ??= 0;
        state.bindings[revision.id] = { lineage: key, ordinal: revision.revision };
      }
      if (changed !== undefined || operation === "withdraw") {
        state.unbound = state.unbound.filter((id) => id !== revision.id);
      }
      if (changed === undefined) {
        delete entries[revision.id];
      } else {
        entries[revision.id] = changed;
      }
      const bytes =
        JSON.stringify(
          Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
        ) + "\n";
      const sorted = <T>(values: Record<string, T>) =>
        Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
      const stateBytes =
        JSON.stringify({
          version: 1,
          frontiers: sorted(state.frontiers),
          bindings: sorted(state.bindings),
          legacyDenied: sorted(state.legacyDenied),
          unbound: state.unbound.sort(),
        }) + "\n";
      const data = { ...object.data, [registryKey]: bytes, [stateKey]: stateBytes };
      dataBudget(data, object.binaryData);
      // Validate the complete publication before committing either authority plane.
      retirementState(stateBytes, "1", entries, this.options.installationId);
      if (
        bytes === object.data![registryKey] &&
        stateBytes === object.data![stateKey] &&
        object.metadata!.annotations?.[stateMarker] === "1"
      ) {
        return sha256(bytes);
      }
      try {
        await this.options.core.replaceNamespacedConfigMap({
          namespace: this.options.namespace,
          name: this.options.configMapName,
          body: {
            ...object,
            metadata: {
              ...object.metadata,
              annotations: { ...object.metadata?.annotations, [stateMarker]: "1" },
            },
            data,
          },
        });
        return sha256(bytes);
      } catch (error) {
        if (numericErrorStatus(error) !== 409) {
          throw error;
        }
      }
    }
    throw new Error("The public reader authorization registry changed repeatedly.");
  }

  private async capability(revision: Revision, namespace: string): Promise<string> {
    const name = this.secretName(revision);
    const labels = {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/public-read-driver": sha256(this.options.driverId).slice(0, 32),
    };
    let secret;
    try {
      secret = await this.options.core.readNamespacedSecret({ namespace, name });
    } catch (error) {
      if (numericErrorStatus(error) !== 404) {
        throw error;
      }
    }
    if (!secret) {
      const capability = `${revision.id}.${randomBytes(32).toString("base64url")}`;
      try {
        secret = await this.options.core.createNamespacedSecret({
          namespace,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { namespace, name, labels },
            immutable: true,
            type: "Opaque",
            data: { capability: Buffer.from(capability).toString("base64") },
          },
        });
      } catch (error) {
        if (numericErrorStatus(error) !== 409) {
          throw error;
        }
        secret = await this.options.core.readNamespacedSecret({ namespace, name });
      }
    }
    if (
      !secret?.metadata?.uid ||
      secret.metadata.deletionTimestamp ||
      secret.immutable !== true ||
      Object.entries(labels).some(([key, value]) => secret!.metadata?.labels?.[key] !== value) ||
      Object.keys(secret.data ?? {}).length !== 1 ||
      typeof secret.data?.capability !== "string"
    ) {
      throw new Error("The public reader capability has invalid ownership or contents.");
    }
    const capability = Buffer.from(secret.data.capability, "base64").toString("utf8");
    if (
      !capability.startsWith(revision.id + ".") ||
      !/^[a-z\d_-]{1,128}\.[A-Za-z\d_-]{43}$/i.test(capability) ||
      Buffer.from(capability).toString("base64") !== secret.data.capability
    ) {
      throw new Error("The public reader capability is invalid.");
    }
    return capability;
  }

  async prepare(revision: Revision, namespace: string, selection: PublicGithubReadPolicy) {
    const policy = publicGithubReadPolicy(selection);
    const key = this.lineage(revision);
    const existing = await this.registry();
    const current = this.preparing(revision, key, existing.entries, existing.state);
    if (current && JSON.stringify(current.policy) !== JSON.stringify(policy)) {
      throw new Error("The frozen public reader authorization cannot be changed or restored.");
    }
    const capability = await this.capability(revision, namespace);
    const tokenSha256 = sha256(capability);
    const authorizationDigest = await this.publish(revision, "prepare", (current) => {
      if (
        current?.withdrawn ||
        (current &&
          (current.tokenSha256 !== tokenSha256 ||
            JSON.stringify(current.policy) !== JSON.stringify(policy)))
      ) {
        throw new Error("The frozen public reader authorization cannot be changed or restored.");
      }
      return {
        installationId: this.options.installationId,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        tokenSha256,
        policy,
        validUntil:
          current && Date.parse(current.validUntil) > Date.now() + 480_000
            ? current.validUntil
            : new Date(Date.now() + 600_000).toISOString(),
      };
    });
    return { capability, secretName: this.secretName(revision), authorizationDigest };
  }

  async suspend(revision: Revision): Promise<string> {
    return this.publish(revision, "suspend", (current) => {
      if (!current) {
        return undefined;
      }
      return { ...current, validUntil: "1970-01-01T00:00:00.000Z" };
    });
  }

  async withdraw(revision: Revision): Promise<string> {
    return this.publish(revision, "withdraw", () => undefined);
  }

  /** Called only after permanent withdrawal is acknowledged and its runtime is fenced. */
  async retireCapability(revision: Revision, namespace: string): Promise<void> {
    const name = this.secretName(revision);
    let secret;
    try {
      secret = await this.options.core.readNamespacedSecret({ namespace, name });
    } catch (error) {
      if (numericErrorStatus(error) === 404) {
        return;
      }
      throw error;
    }
    const labels = {
      "app.kubernetes.io/managed-by": "openclaw-enterprise",
      "openclaw.dev/namespace": revision.namespaceId,
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
      "openclaw.dev/public-read-driver": sha256(this.options.driverId).slice(0, 32),
    };
    if (
      secret.metadata?.name !== name ||
      secret.metadata.namespace !== namespace ||
      !secret.metadata.uid ||
      !secret.metadata.resourceVersion ||
      secret.metadata.deletionTimestamp ||
      secret.immutable !== true ||
      secret.type !== "Opaque" ||
      Object.entries(labels).some(([key, value]) => secret.metadata?.labels?.[key] !== value) ||
      Object.keys(secret.data ?? {}).length !== 1 ||
      typeof secret.data?.capability !== "string"
    ) {
      throw new Error("The retired public reader capability has invalid ownership or contents.");
    }
    const capability = Buffer.from(secret.data.capability, "base64").toString("utf8");
    if (
      !capability.startsWith(revision.id + ".") ||
      !/^[a-z\d_-]{1,128}\.[A-Za-z\d_-]{43}$/i.test(capability) ||
      Buffer.from(capability).toString("base64") !== secret.data.capability
    ) {
      throw new Error("The retired public reader capability is invalid.");
    }
    try {
      await this.options.core.deleteNamespacedSecret({
        namespace,
        name,
        body: {
          preconditions: {
            uid: secret.metadata.uid,
            resourceVersion: secret.metadata.resourceVersion,
          },
        },
      });
    } catch (error) {
      if (numericErrorStatus(error) !== 404) {
        throw error;
      }
    }
  }

  async digest(revision?: Revision): Promise<string> {
    const { object, entries } = await this.registry();
    if (!revision) {
      return sha256(object.data![registryKey]!);
    }
    const snapshot = await authorizationSnapshot({ loadAuthorizations: () => entries });
    return publicGithubReadAuthorizationDigest(snapshot.authorizations[revision.id]);
  }
}
