import {
  isName,
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
  type AuthorizationRequest,
  type Namespace,
  type ResourceRef,
  type Secret,
  type SecretConsumers,
  type SecretDetail,
  type SecretDriver,
  type SecretMetadata,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { parseProvisioningPlan } from "./agent-provisioning.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ResourceStateConflictError,
  ScopeViolationError,
  SecretDriverOwnershipError,
  SecretReferencedError,
  SecretStorageDriverError,
  SecretValueError,
} from "./errors.ts";
import { accessBindingsTargeting, type RemovedAccessBinding } from "./iam-policy-cleanup.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export interface CreateSecretInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
}

export interface UpdateSecretInput {
  readonly namespaceId: string;
  readonly secretId: string;
  readonly value: string;
}

interface SecretOperationsDependencies {
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizationDecision" | "canRead" | "holdAuthority"
  >;
  readonly bindCreator: (
    state: PlatformUnitOfWork,
    principalId: string,
    target: ResourceRef & { readonly namespaceId: string },
  ) => Promise<void>;
  readonly getNamespace: (principalId: string, namespaceId: string) => Promise<Readonly<Namespace>>;
  readonly lockNamespaceForPolicyDelete: (
    state: PlatformUnitOfWork,
    principalId: string,
    target: ResourceRef & { readonly namespaceId: string },
  ) => Promise<Readonly<Namespace>>;
  readonly selectDriver: () => SecretDriver;
  readonly nextIdentifier: (kind: "secret") => string;
  readonly timestamp: () => string;
  readonly registerRollback: (compensate: () => Promise<void>) => void;
}

/**
 * The most references a Secret read or delete examines. Each one costs authorization work,
 * so the bound keeps both the response and the IAM work small. Delete makes those decisions
 * while it holds the Namespace and Secret locks, so the bound also limits that lock window.
 */
const SECRET_CONSUMER_LIMIT = 50;
const SECRET_CONSUMER_KINDS = Object.freeze([
  "agents",
  "configurations",
  "credentialSources",
  "provisioningRequests",
] as const);
type SecretReferenceKind = Awaited<
  ReturnType<PlatformReadView["secrets"]["listReferences"]>
>["references"][number]["kind"];
const SECRET_CONSUMER_FIELDS: Readonly<
  Record<SecretReferenceKind, (typeof SECRET_CONSUMER_KINDS)[number]>
> = Object.freeze({
  agent: "agents",
  configuration: "configurations",
  credential_source: "credentialSources",
  provisioning_request: "provisioningRequests",
});

function validateSecretValue(value: unknown): asserts value is string {
  const message = "The Secret value must be nonempty UTF-8, without NUL, and at most 65536 bytes.";
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new SecretValueError("INVALID_VALUE", message);
  }
  if (Buffer.byteLength(value, "utf8") > 65_536) {
    throw new SecretValueError("TOO_LONG", message);
  }
}

function secretMetadata(secret: Secret): Readonly<SecretMetadata> {
  return immutableCopy({
    id: secret.id,
    namespaceId: secret.namespaceId,
    name: secret.name,
    ref: { kind: "secret", namespaceId: secret.namespaceId, id: secret.id },
  });
}

/** Secret SDK error bodies can contain request bytes; never propagate their message or cause. */
export async function secretOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ResourceConflictError) {
      throw new ResourceConflictError(
        "The Secret backend identity or concurrency precondition conflicts.",
      );
    }
    if (error instanceof ScopeViolationError) {
      throw new ScopeViolationError("The Secret backend ownership could not be verified.");
    }
    throw new DependencyUnavailableError(
      "The Secret storage operation failed or its outcome is unknown.",
    );
  }
}

export function sameSecretBackend(left: Secret, right: Secret): boolean {
  return (
    left.id === right.id &&
    left.namespaceId === right.namespaceId &&
    left.driverId === right.driverId &&
    left.backendRef.uid === right.backendRef.uid &&
    left.backendRef.name === right.backendRef.name &&
    left.backendRef.namespaceName === right.backendRef.namespaceName &&
    left.backendRef.key === right.backendRef.key
  );
}

export function createSecretOperations(installationId: string, deps: SecretOperationsDependencies) {
  const { read, transact } = deps.transactions;
  const { authorize, authorizationDecision, canRead, holdAuthority } = deps.authority;

  function secretDriver(expectedId?: string): SecretDriver {
    try {
      const driver = deps.selectDriver();
      if (expectedId !== undefined && driver.id !== expectedId) {
        throw new Error("Driver identity mismatch.");
      }
      return driver;
    } catch {
      throw new DependencyUnavailableError(
        "The selected Secret Driver is unavailable or does not own this Secret.",
      );
    }
  }

  /**
   * The selected Secret Driver when it owns a Secret the caller has already been granted and
   * looked up; otherwise the path's own SecretDriverOwnershipError, whose fixed message names
   * that path's fix. Call it only after the grant and the lookup, so it is no existence oracle.
   * No usable selected driver is an outage, not an ownership problem: it keeps the generic 503.
   */
  function ownedSecretDriver(
    driverId: string,
    failure: () => SecretDriverOwnershipError,
  ): SecretDriver {
    const driver = secretDriver();
    if (driver.id !== driverId) {
      throw failure();
    }
    return driver;
  }

  async function createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    validateSecretValue(input.value);
    if (!isName(input.name)) {
      throw new ScopeViolationError("The Secret name is invalid.");
    }
    namespaceIdentity(input.namespaceId);
    return transact(async (state) => {
      await holdAuthority(state);
      const target: ResourceRef = {
        kind: "secret",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await authorize(principalId, "create", target);
      const namespace = await lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await authorize(principalId, "create", target);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const driver = secretDriver();
      const identity = {
        id: deps.nextIdentifier("secret"),
        namespaceId: namespace.id,
        name: input.name,
      };
      const backendRef = await secretOperation(() => driver.create(identity, input.value));
      const secret: Secret = {
        ...identity,
        driverId: driver.id,
        backendRef,
        createdAt: deps.timestamp(),
      };
      // Compensate only a known failed OCC transaction, never an unknown COMMIT outcome.
      deps.registerRollback(() => secretOperation(() => driver.delete(secret)));
      await state.secrets.createSecret(secret);
      await deps.bindCreator(state, principalId, {
        kind: "secret",
        id: secret.id,
        namespaceId: namespace.id,
      });
      return secretMetadata(secret);
    });
  }

  async function readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretDetail>> {
    await authorize(principalId, "read", { kind: "secret", id: secretId, namespaceId });
    return read(async (state) => {
      await exactNamespace(state, namespaceId);
      const secret = await state.secrets.findSecret(namespaceId, secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      return Object.freeze({
        ...secretMetadata(secret),
        consumers: await secretConsumers(state, principalId, namespaceId, secret.id),
      });
    });
  }

  async function listSecrets(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<SecretMetadata>[]> {
    const namespace = await deps.getNamespace(principalId, namespaceId);
    return read(async (state) => {
      const readable: Readonly<SecretMetadata>[] = [];
      for (const secret of await state.secrets.listSecrets(namespace.id)) {
        if (
          await canRead(principalId, {
            kind: "secret",
            id: secret.id,
            namespaceId: namespace.id,
          })
        ) {
          readable.push(secretMetadata(secret));
        }
      }
      return Object.freeze(readable);
    });
  }

  async function secretsOperateDenied(
    principalId: string,
    namespaceId: string,
    unreadableAmong: ReadonlySet<string>,
  ): Promise<{ readonly readable: readonly string[]; readonly unreadableCount: number }> {
    const namespace = await deps.getNamespace(principalId, namespaceId);
    return read(async (state) => {
      const readable: string[] = [];
      let unreadableCount = 0;
      for (const secret of await state.secrets.listSecrets(namespace.id)) {
        const resource: ResourceRef = { kind: "secret", id: secret.id, namespaceId: namespace.id };
        const mayRead = await canRead(principalId, resource);
        if (!mayRead && !unreadableAmong.has(secret.id)) {
          continue;
        }
        if ((await authorizationDecision(principalId, "operate", resource)).decision.allowed) {
          continue;
        }
        if (mayRead) {
          readable.push(secret.id);
        } else {
          unreadableCount += 1;
        }
      }
      return { readable: Object.freeze(readable.sort()), unreadableCount };
    });
  }

  async function updateSecret(
    principalId: string,
    input: UpdateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    validateSecretValue(input.value);
    namespaceIdentity(input.namespaceId);
    return transact(async (state) => {
      await authorize(principalId, "update", {
        kind: "secret",
        id: input.secretId,
        namespaceId: input.namespaceId,
      });
      const namespace = await lockNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const secret = await state.secrets.lockSecret(namespace.id, input.secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      const driver = ownedSecretDriver(
        secret.driverId,
        () => new SecretStorageDriverError("update"),
      );
      // No prior value is read or retained for rollback. Success means stored, not delivered.
      await secretOperation(() => driver.update(secret, input.value));
      return secretMetadata(secret);
    });
  }

  async function deleteSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<readonly RemovedAccessBinding[]> {
    namespaceIdentity(namespaceId);
    return transact(async (state) => {
      const namespace = await deps.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "secret",
        id: secretId,
        namespaceId,
      });
      const secret = await state.secrets.lockSecret(namespace.id, secretId);
      if (!secret) {
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      }
      const consumers = await secretConsumers(state, principalId, namespace.id, secret.id);
      if (
        consumers.unreadable > 0 ||
        SECRET_CONSUMER_KINDS.some((kind) => consumers[kind].length > 0)
      ) {
        throw new SecretReferencedError(consumers);
      }
      const removed = await accessBindingsTargeting(state, namespace.id, "secret", secret.id);
      const driver = ownedSecretDriver(
        secret.driverId,
        () => new SecretStorageDriverError("delete"),
      );
      await secretOperation(() => driver.delete(secret));
      if (!(await state.secrets.deleteSecret(namespace.id, secret.id))) {
        throw new ResourceStateConflictError("The Secret changed during deletion.");
      }
      return removed;
    });
  }

  // GET and DELETE use the same bounded page and cache repeated authorization decisions.
  async function secretConsumers(
    state: Pick<PlatformReadView, "secrets" | "provisioning">,
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretConsumers>> {
    const page = await state.secrets.listReferences(namespaceId, secretId, SECRET_CONSUMER_LIMIT);
    const named: Record<(typeof SECRET_CONSUMER_KINDS)[number], string[]> = {
      agents: [],
      configurations: [],
      credentialSources: [],
      provisioningRequests: [],
    };
    let unreadable = 0;
    const decisions = new Map<string, boolean>();
    const allowed = async (
      action: AuthorizationRequest["action"],
      resource: ResourceRef,
    ): Promise<boolean> => {
      const key = JSON.stringify([action, resource.kind, resource.namespaceId, resource.id]);
      let decision = decisions.get(key);
      if (decision === undefined) {
        decision = (await authorizationDecision(principalId, action, resource)).decision.allowed;
        decisions.set(key, decision);
      }
      return decision;
    };
    for (const reference of page.references) {
      const readable =
        reference.kind === "provisioning_request"
          ? await canReadProvisioningRequest(state, principalId, namespaceId, reference.id, allowed)
          : await allowed("read", { kind: reference.kind, id: reference.id, namespaceId });
      if (!readable) {
        unreadable += 1;
        continue;
      }
      named[SECRET_CONSUMER_FIELDS[reference.kind]].push(reference.id);
    }
    return Object.freeze({
      agents: Object.freeze(named.agents),
      configurations: Object.freeze(named.configurations),
      credentialSources: Object.freeze(named.credentialSources),
      provisioningRequests: Object.freeze(named.provisioningRequests),
      unreadable,
      truncated: page.truncated,
    });
  }

  // A pending request is visible to its initiating actor if they still hold the grants
  // required by the status read. An invalid stored plan is hidden. IAM outages propagate.
  async function canReadProvisioningRequest(
    state: Pick<PlatformReadView, "provisioning">,
    principalId: string,
    namespaceId: string,
    workId: string,
    allowed: (action: AuthorizationRequest["action"], resource: ResourceRef) => Promise<boolean>,
  ): Promise<boolean> {
    const record = await state.provisioning.findByWorkId(workId);
    if (
      record === undefined ||
      record.namespaceId !== namespaceId ||
      record.actorId !== principalId
    ) {
      return false;
    }
    let plan: ReturnType<typeof parseProvisioningPlan>;
    try {
      plan = parseProvisioningPlan(record);
    } catch (error) {
      if (error instanceof DependencyUnavailableError) {
        throw error;
      }
      return false;
    }
    const harnessAuth = plan.harnessAuth;
    const checks: [AuthorizationRequest["action"], ResourceRef][] = [
      ["create", { kind: "agent", namespaceId, id: namespaceId }],
      ["create", { kind: "configuration", namespaceId, id: namespaceId }],
      ["administer", { kind: "installation", id: installationId }],
      ...(record.agentId === undefined
        ? []
        : (["read", "operate", "deploy"] as const).map(
            (action): [AuthorizationRequest["action"], ResourceRef] => [
              action,
              { kind: "agent", namespaceId, id: record.agentId as string },
            ],
          )),
      ...(record.configurationId === undefined
        ? []
        : (["read", "update"] as const).map(
            (action): [AuthorizationRequest["action"], ResourceRef] => [
              action,
              { kind: "configuration", namespaceId, id: record.configurationId as string },
            ],
          )),
      ...Object.values(plan.configuration.secretBindings ?? {}).map(
        (binding): [AuthorizationRequest["action"], ResourceRef] => ["operate", binding.source],
      ),
      ...(isSecretHarnessAuth(harnessAuth)
        ? [["operate", harnessAuth.source] as [AuthorizationRequest["action"], ResourceRef]]
        : []),
      ...(harnessAuth?.method === "credential_source"
        ? [
            ["operate", { kind: "credential_source", namespaceId, id: harnessAuth.sourceId }] as [
              AuthorizationRequest["action"],
              ResourceRef,
            ],
          ]
        : []),
      ...(isServiceAccountHarnessAuth(harnessAuth)
        ? [
            ["read", { kind: "service_account", namespaceId, id: harnessAuth.source.id }] as [
              AuthorizationRequest["action"],
              ResourceRef,
            ],
          ]
        : []),
    ];
    for (const [action, resource] of checks) {
      if (!(await allowed(action, resource))) {
        return false;
      }
    }
    return true;
  }

  return {
    secretDriver,
    ownedSecretDriver,
    createSecret,
    readSecret,
    listSecrets,
    secretsOperateDenied,
    updateSecret,
    deleteSecret,
  };
}

export type SecretOperations = ReturnType<typeof createSecretOperations>;
