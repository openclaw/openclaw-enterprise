import {
  isName,
  type ComputeDriver,
  type Namespace,
  type ResourceRef,
  type ServiceAccount,
  type ServiceAccountCredential,
  type ServiceAccountDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { driverOperation } from "./driver-operation.ts";
import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import {
  DependencyUnavailableError,
  ResourceStateConflictError,
  ScopeViolationError,
  ServiceAccountDriverNotConfiguredError,
} from "./errors.ts";
import { accessBindingsTargeting, type RemovedAccessBinding } from "./iam-policy-cleanup.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { exactNamespace, lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export interface CreateServiceAccountInput {
  readonly namespaceId: string;
  readonly name: string;
}

/** The result of a ServiceAccount deletion. */
export interface ServiceAccountDeletion {
  readonly removedAccessBindings: readonly RemovedAccessBinding[];
  /**
   * Set only when a forced deletion removed an account whose issued access token no
   * ServiceAccount Driver could revoke. The token itself is never read. Its Backend binding
   * is absent when OCC has no record of it.
   */
  readonly unrevokedCredential?: {
    readonly backendId?: string;
    readonly workspaceId?: string;
    /** The provider account the credential belongs to; the provider revokes by both IDs. */
    readonly externalAccountId?: string;
    readonly credentialId?: string;
  };
}

interface ServiceAccountOperationsDependencies {
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority" | "readableListRows">;
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
  readonly hasSelection: () => boolean;
  readonly selectDriver: () => ServiceAccountDriver;
  readonly computeDriver: () => ComputeDriver;
  readonly configuredDriverId: string | undefined;
  readonly nextIdentifier: (kind: "service_account") => string;
}

export async function exactServiceAccount(
  state: PlatformReadView,
  namespaceId: string,
  serviceAccountId: string,
): Promise<Readonly<ServiceAccount>> {
  const account = await state.serviceAccounts.findServiceAccount(namespaceId, serviceAccountId);
  if (account === undefined) {
    throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
  }
  return account;
}

async function lockServiceAccount(
  state: Pick<PlatformUnitOfWork, "serviceAccounts">,
  namespaceId: string,
  serviceAccountId: string,
): Promise<Readonly<ServiceAccount>> {
  const account = await state.serviceAccounts.lockServiceAccount(namespaceId, serviceAccountId);
  if (account === undefined) {
    throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
  }
  return account;
}

export function createServiceAccountOperations(deps: ServiceAccountOperationsDependencies) {
  const { read, transact } = deps.transactions;
  const { authorize, holdAuthority, readableListRows } = deps.authority;

  function serviceAccountDriver(): ServiceAccountDriver | undefined {
    if (!deps.hasSelection()) {
      return undefined;
    }
    try {
      return deps.selectDriver();
    } catch {
      throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
    }
  }

  function hasServiceAccountDriver(): boolean {
    return deps.hasSelection() || deps.configuredDriverId !== undefined;
  }

  function serviceAccountDriverId(): string | undefined {
    const driver = serviceAccountDriver();
    if (
      driver !== undefined &&
      deps.configuredDriverId !== undefined &&
      driver.id !== deps.configuredDriverId
    ) {
      throw new DependencyUnavailableError(
        "The selected ServiceAccount Driver does not match Installation configuration.",
      );
    }
    return driver?.id ?? deps.configuredDriverId;
  }

  async function getServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    serviceAccountIdentity(namespaceId, serviceAccountId);
    await authorize(principalId, "read", {
      kind: "service_account",
      id: serviceAccountId,
      namespaceId,
    });
    return read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      return exactServiceAccount(state, namespace.id, serviceAccountId);
    });
  }

  async function listServiceAccounts(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServiceAccount>[]> {
    const namespace = await deps.getNamespace(principalId, namespaceId);
    return read(async (state) =>
      readableListRows(
        principalId,
        namespace.id,
        "service_account",
        await state.serviceAccounts.listServiceAccounts(namespace.id),
      ),
    );
  }

  async function createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>> {
    if (!isName(input.name)) {
      throw new ScopeViolationError("The ServiceAccount name is invalid.");
    }
    namespaceIdentity(input.namespaceId);
    return transact(async (state) => {
      await holdAuthority(state);
      const target: ResourceRef = {
        kind: "service_account",
        id: input.namespaceId,
        namespaceId: input.namespaceId,
      };
      await authorize(principalId, "create", target);
      const namespace = await lockNamespace(state, input.namespaceId);
      // AccessBinding deletes hold this lock: authorize again so a revocation that committed
      // while this write waited stops it before it leaves a durable Owner binding or grant.
      await authorize(principalId, "create", target);
      // Checked after authorization: the conflict names the Namespace state.
      if (namespace.status !== "provisioning" && namespace.status !== "ready") {
        throw new ResourceStateConflictError("The Namespace does not accept new ServiceAccounts.");
      }
      const account = await state.serviceAccounts.createServiceAccount({
        id: deps.nextIdentifier("service_account"),
        namespaceId: namespace.id,
        name: input.name,
      });
      await deps.bindCreator(state, principalId, {
        kind: "service_account",
        id: account.id,
        namespaceId: namespace.id,
      });
      const driver = serviceAccountDriver();
      if (driver !== undefined) {
        await driverOperation(() => driver.create(account), "ServiceAccount");
      }
      return account;
    });
  }

  async function createServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    serviceAccountIdentity(namespaceId, serviceAccountId);
    return transact(async (state) => {
      await authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId,
      });
      const namespace = await exactNamespace(state, namespaceId);
      const account = await lockServiceAccount(state, namespace.id, serviceAccountId);
      if (account.credential !== undefined) {
        throw new ResourceStateConflictError("The ServiceAccount already has a credential.");
      }
      const driver = serviceAccountDriver();
      if (driver === undefined) {
        throw new ServiceAccountDriverNotConfiguredError("issue");
      }
      const credential = await driverOperation(
        () => driver.createCredential(account),
        "ServiceAccount",
      );
      if (credential?.kind !== "access_token") {
        throw new DependencyUnavailableError(
          "The ServiceAccount Driver returned an unsupported credential.",
        );
      }
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined) {
        throw new ResourceStateConflictError(
          "The ServiceAccount credential changed during its update.",
        );
      }
      return updated;
    });
  }

  async function updateServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount>> {
    serviceAccountIdentity(namespaceId, serviceAccountId);
    return transact(async (state) => {
      await authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId,
      });
      const namespace = await exactNamespace(state, namespaceId);
      const account = await lockServiceAccount(state, namespace.id, serviceAccountId);
      if (account.credential?.kind === "access_token" || credential.kind === "access_token") {
        throw new ResourceStateConflictError(
          "A managed ServiceAccount credential cannot be manually updated.",
        );
      }
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined) {
        throw new ResourceStateConflictError(
          "The ServiceAccount credential changed during its update.",
        );
      }
      return updated;
    });
  }

  async function deleteServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<ServiceAccountDeletion> {
    serviceAccountIdentity(namespaceId, serviceAccountId);
    return transact(async (state) => {
      const namespace = await deps.lockNamespaceForPolicyDelete(state, principalId, {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId,
      });
      const account = await lockServiceAccount(state, namespace.id, serviceAccountId);
      if (await state.serviceAccounts.hasReferences(namespace.id, account.id)) {
        throw new ResourceStateConflictError(
          "An Agent draft, active revision, pending deployment, or pending Agent provisioning request still references the ServiceAccount. Remove those references, or let provisioning finish, first.",
        );
      }
      // Decided once, on the locked account row: Driver selection is fixed when the API
      // starts, and issuance takes the same row lock, so no token can appear after this read.
      const driver = serviceAccountDriver();
      let unrevokedCredential: ServiceAccountDeletion["unrevokedCredential"];
      if (account.credential?.kind === "access_token" && driver === undefined) {
        // Only the Backend's Driver can revoke the issued token, so deletion waits for it
        // unless the caller forces it. Only the worker sets a configured Driver id, so the API
        // always answers the 409 (or forces).
        if (deps.configuredDriverId !== undefined) {
          throw new DependencyUnavailableError(
            "The selected ServiceAccount Driver is unavailable.",
          );
        }
        if (options.force !== true) {
          throw new ServiceAccountDriverNotConfiguredError("delete");
        }
        const binding = await state.serviceAccounts.findIssuedCredentialBinding(
          namespace.id,
          account.id,
        );
        await deleteUnrevokedCredentialSecret(account, account.credential);
        unrevokedCredential = binding === undefined ? {} : { ...binding };
      }
      if (driver !== undefined) {
        await driverOperation(() => driver.delete(account), "ServiceAccount");
      }
      const removed = await accessBindingsTargeting(
        state,
        namespace.id,
        "service_account",
        account.id,
      );
      if (!(await state.serviceAccounts.deleteServiceAccount(namespace.id, account.id))) {
        throw new ResourceStateConflictError("The ServiceAccount changed during deletion.");
      }
      return {
        removedAccessBindings: removed,
        ...(unrevokedCredential === undefined ? {} : { unrevokedCredential }),
      };
    });
  }

  // The Compute Driver that stored the account token also owns removal of its Secret.
  async function deleteUnrevokedCredentialSecret(
    account: Readonly<ServiceAccount>,
    credential: ServiceAccountCredential,
  ): Promise<void> {
    const compute = deps.computeDriver();
    const deleteSecret = compute.deleteServiceAccountCredential?.bind(compute);
    if (deleteSecret === undefined) {
      return;
    }
    await driverOperation(
      () =>
        deleteSecret({
          namespaceId: account.namespaceId,
          serviceAccountId: account.id,
          secretRef: credential.secretRef,
        }),
      "Compute",
    );
  }

  function serviceAccountIdentity(namespaceId: string, serviceAccountId: string): void {
    namespaceIdentity(namespaceId);
    if (!isNonEmptyString(serviceAccountId)) {
      throw new ScopeViolationError("The exact ServiceAccount identity is missing.");
    }
  }

  return {
    hasServiceAccountDriver,
    serviceAccountDriverId,
    getServiceAccount,
    listServiceAccounts,
    createServiceAccount,
    createServiceAccountCredential,
    updateServiceAccountCredential,
    deleteServiceAccount,
  };
}

export type ServiceAccountOperations = ReturnType<typeof createServiceAccountOperations>;
