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
type Revision = Pick<AgentRevision, "id" | "namespaceId" | "agentId">;
type Authorization = PublicGithubReadAuthorization & { withdrawn?: true };
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
      Buffer.byteLength(bytes) > 1024 * 1024
    ) {
      throw new Error("The public reader authorization registry is unavailable or foreign.");
    }
    const entries = JSON.parse(bytes) as Record<string, Authorization>;
    await authorizationSnapshot({ loadAuthorizations: () => entries });
    return { object, entries };
  }

  private async publish(
    revision: Revision,
    change: (entry: Authorization | undefined) => Authorization | undefined,
  ): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { object, entries } = await this.registry();
      const entry = Object.hasOwn(entries, revision.id) ? entries[revision.id] : undefined;
      if (
        entry &&
        (entry.installationId !== this.options.installationId ||
          entry.namespaceId !== revision.namespaceId ||
          entry.agentId !== revision.agentId)
      ) {
        throw new Error("The public reader authorization belongs to a different Agent.");
      }
      const changed = change(entry);
      if (changed === undefined) {
        delete entries[revision.id];
      } else {
        entries[revision.id] = changed;
      }
      const bytes =
        JSON.stringify(
          Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
        ) + "\n";
      if (Buffer.byteLength(bytes) > 1024 * 1024) {
        throw new Error("The public reader authorization registry is full.");
      }
      if (bytes === object.data![registryKey]) {
        return sha256(bytes);
      }
      try {
        await this.options.core.replaceNamespacedConfigMap({
          namespace: this.options.namespace,
          name: this.options.configMapName,
          body: { ...object, data: { ...object.data, [registryKey]: bytes } },
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
    const capability = await this.capability(revision, namespace);
    const tokenSha256 = sha256(capability);
    const authorizationDigest = await this.publish(revision, (current) => {
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
    return this.publish(revision, (current) => {
      if (!current) {
        return undefined;
      }
      return { ...current, validUntil: "1970-01-01T00:00:00.000Z" };
    });
  }

  async withdraw(revision: Revision): Promise<string> {
    return this.publish(revision, (current) => ({
      ...(current ?? {
        installationId: this.options.installationId,
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        tokenSha256: sha256(`withdrawn:${revision.id}`),
        policy: { mode: "repositories", repositories: [] },
      }),
      validUntil: "1970-01-01T00:00:00.000Z",
      withdrawn: true,
    }));
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
