import type {
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  OpenClawController,
  PostgresPlatformState,
  ResourceConflictError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import type { Provider } from "@openclaw-enterprise/contracts";
import type { ChatGPTClient } from "../../providers/chatgpt.ts";

type SecretReference = ServiceAccountCredential["secretRef"];

interface CredentialStorage {
  storeServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly accessToken: string;
    readonly workspaceId: string;
  }): Promise<SecretReference>;
  deleteServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly secretRef: SecretReference;
  }): Promise<void>;
}

interface ServiceAccountBinding {
  readonly providerId: string;
  readonly driverId: string;
  readonly externalAccountId: string;
  readonly externalCredentialId: string | null;
  readonly workspaceId: string;
}

export class ChatGPTServiceAccountDriver implements ServiceAccountDriver {
  readonly capability = "service_account" as const;
  readonly implementation = "chatgpt";
  readonly id: string;
  private readonly providerId: string;
  private readonly client: ChatGPTClient;
  private readonly controller: OpenClawController;
  private readonly state: PostgresPlatformState;
  private readonly compute: CredentialStorage;

  constructor(
    provider: Provider<ChatGPTClient>,
    controller: OpenClawController,
    state: PostgresPlatformState,
    compute: CredentialStorage,
  ) {
    const id = provider.drivers.service_account;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("The ChatGPT Provider must declare its ServiceAccount Driver.");
    }
    this.client = provider.client;
    this.controller = controller;
    this.state = state;
    this.compute = compute;
    this.providerId = provider.id;
    this.id = id;
  }

  async create(account: ServiceAccount): Promise<void> {
    const suffix = `-${account.id}`;
    const external = await this.client.createServiceAccount({
      name: `${account.name.slice(0, 200 - suffix.length)}${suffix}`,
    });
    this.controller.registerRollback(() => this.client.deleteServiceAccount(external.id));
    await this.query(
      `INSERT INTO occ.service_account_driver_bindings
         (service_account_id, namespace_id, provider_id, driver_id, external_account_id, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        account.id,
        account.namespaceId,
        this.providerId,
        this.id,
        external.id,
        this.client.workspaceId,
      ],
    );
  }

  async createCredential(account: ServiceAccount): Promise<ServiceAccountCredential> {
    const linked = await this.findBinding(account);
    if (linked === undefined) {
      throw new ScopeViolationError("The service account has no exact provider binding.");
    }
    if (linked.externalCredentialId !== null || account.credential !== undefined) {
      throw new ResourceConflictError("The service account already has a credential.");
    }

    const credential = await this.client.createCredential({
      accountId: linked.externalAccountId,
      name: `occ-${account.id}`,
    });
    this.controller.registerRollback(() =>
      this.client.deleteCredential({
        accountId: linked.externalAccountId,
        credentialId: credential.id,
      }),
    );

    const secretRef = await this.compute.storeServiceAccountCredential({
      namespaceId: account.namespaceId,
      serviceAccountId: account.id,
      accessToken: credential.accessToken,
      workspaceId: linked.workspaceId,
    });
    this.controller.registerRollback(() =>
      this.compute.deleteServiceAccountCredential({
        namespaceId: account.namespaceId,
        serviceAccountId: account.id,
        secretRef,
      }),
    );

    const result = await this.query(
      `UPDATE occ.service_account_driver_bindings
       SET external_credential_id = $4
       WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3`,
      [account.id, account.namespaceId, this.id, credential.id],
    );
    if (result.rowCount !== 1) {
      throw new DependencyUnavailableError("The exact service-account Driver binding is missing.");
    }
    return { kind: "access_token", secretRef };
  }

  async delete(account: ServiceAccount): Promise<void> {
    const linked = await this.findBinding(account);
    if (linked === undefined) {
      return;
    }
    if (linked.externalCredentialId !== null) {
      if (account.credential?.kind !== "access_token") {
        throw new ScopeViolationError("The exact service-account credential is missing.");
      }
      await this.client.deleteCredential({
        accountId: linked.externalAccountId,
        credentialId: linked.externalCredentialId,
      });
      await this.compute.deleteServiceAccountCredential({
        namespaceId: account.namespaceId,
        serviceAccountId: account.id,
        secretRef: account.credential.secretRef,
      });
    }
    await this.client.deleteServiceAccount(linked.externalAccountId);
  }

  private async findBinding(account: ServiceAccount): Promise<ServiceAccountBinding | undefined> {
    const result = await this.query(
      `SELECT driver_id AS "driverId", external_account_id AS "externalAccountId",
              provider_id AS "providerId", external_credential_id AS "externalCredentialId",
              workspace_id AS "workspaceId"
       FROM occ.service_account_driver_bindings
       WHERE service_account_id = $1 AND namespace_id = $2`,
      [account.id, account.namespaceId],
    );
    if (result.rows.length === 0) {
      return undefined;
    }
    const linked = result.rows[0] as ServiceAccountBinding;
    if (linked.providerId !== this.providerId) {
      throw new DependencyUnavailableError("The service-account Provider does not match.");
    }
    if (linked.driverId !== this.id) {
      throw new DependencyUnavailableError("The service-account provider Driver does not match.");
    }
    if (linked.workspaceId !== this.client.workspaceId) {
      throw new DependencyUnavailableError(
        "The service-account provider workspace does not match.",
      );
    }
    return linked;
  }

  private async query(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    return this.controller.transact((unit) =>
      this.state.queryInTransaction(unit, statement, parameters),
    );
  }
}

export function createChatGPTServiceAccountDriverFactory(
  provider: Provider<ChatGPTClient>,
  compute: CredentialStorage,
) {
  return (controller: OpenClawController, state: PostgresPlatformState): void => {
    const driver = new ChatGPTServiceAccountDriver(provider, controller, state, compute);
    controller.registerDriver(driver);
    if (controller.selectDriver("service_account", driver.id) !== driver) {
      throw new Error("The configured ServiceAccount Driver was not selected correctly.");
    }
  };
}
