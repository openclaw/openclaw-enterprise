import type {
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
  StaticCredentialSource,
} from "@openclaw-enterprise/contracts";
import {
  DependencyUnavailableError,
  OpenClawController,
  PostgresPlatformState,
  ResourceConflictError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import type { Backend } from "@openclaw-enterprise/contracts";
import type { ChatGPTClient } from "../../backends/chatgpt.ts";

interface ServiceAccountBinding {
  readonly backendId: string;
  readonly driverId: string;
  readonly externalAccountId: string;
  readonly externalCredentialId: string | null;
  readonly workspaceId: string;
}

export class ChatGPTServiceAccountDriver implements ServiceAccountDriver {
  readonly capability = "service_account" as const;
  readonly implementation = "chatgpt";
  readonly id: string;
  private readonly backendId: string;
  private readonly client: ChatGPTClient;
  private readonly controller: OpenClawController;
  private readonly state: PostgresPlatformState;

  constructor(
    backend: Backend<ChatGPTClient>,
    controller: OpenClawController,
    state: PostgresPlatformState,
  ) {
    const id = backend.drivers.service_account;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("The ChatGPT Backend must declare its ServiceAccount Driver.");
    }
    this.client = backend.client;
    this.controller = controller;
    this.state = state;
    this.backendId = backend.id;
    this.id = id;
  }

  async create(account: ServiceAccount): Promise<void> {
    const suffix = `-${account.id}`;
    // Cut by whole characters within the 200 UTF-16 code unit budget, so the cut never
    // leaves half of a surrogate pair.
    let prefix = "";
    for (const character of account.name) {
      if (prefix.length + character.length > 200 - suffix.length) {
        break;
      }
      prefix += character;
    }
    const external = await this.client.createServiceAccount({ name: `${prefix}${suffix}` });
    this.controller.registerRollback(() => this.client.deleteServiceAccount(external.id));
    await this.query(
      `INSERT INTO occ.service_account_driver_bindings
         (service_account_id, namespace_id, backend_id, driver_id, external_account_id, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        account.id,
        account.namespaceId,
        this.backendId,
        this.id,
        external.id,
        this.client.workspaceId,
      ],
    );
  }

  async createCredential(account: ServiceAccount): Promise<ServiceAccountCredential> {
    let linked = await this.findBinding(account);
    if (linked === undefined) {
      throw new ScopeViolationError("The service account has no exact backend binding.");
    }
    if (account.credential !== undefined) {
      throw new ResourceConflictError("The service account already has a credential.");
    }
    const originalCredentialId = linked.externalCredentialId;
    if (linked.externalCredentialId !== null) {
      await this.client.deleteCredential({
        accountId: linked.externalAccountId,
        credentialId: linked.externalCredentialId,
      });
      await this.query(
        `UPDATE occ.service_account_driver_bindings SET external_credential_id = NULL
         WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3
           AND external_credential_id = $4`,
        [account.id, account.namespaceId, this.id, linked.externalCredentialId],
      );
      linked = { ...linked, externalCredentialId: null };
    }
    const owner = this.controller.selectedDriver("credential_service");
    const credential = await this.client.createCredential({
      accountId: linked.externalAccountId,
      name: `occ-${account.id}`,
    });
    let source: StaticCredentialSource | undefined = undefined;
    // The provider owns revocation. Never remove custody before revocation is confirmed.
    this.controller.registerRollback(async () => {
      try {
        await this.client.deleteCredential({
          accountId: linked.externalAccountId,
          credentialId: credential.id,
        });
      } catch (error) {
        // A known failed compensation must retain the exact private issuer ID.
        await this.state.transact(async (unit) => {
          const retained = await this.state.queryInTransaction(
            unit,
            `UPDATE occ.service_account_driver_bindings SET external_credential_id = $4
             WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3
               AND external_credential_id IS NOT DISTINCT FROM $5`,
            [account.id, account.namespaceId, this.id, credential.id, originalCredentialId],
          );
          if (retained.rowCount !== 1) {
            throw new DependencyUnavailableError(
              "The exact ServiceAccount issuer receipt could not be retained.",
            );
          }
          if (source) {
            await unit.serviceAccounts.updateCredential(account.namespaceId, account.id, {
              kind: "access_token",
              sourceId: source.id,
            });
          }
        });
        throw error;
      }
      if (source) {
        await this.removeSource(source);
      }
    });
    const created = await owner.createSource(
      {
        type: "static",
        namespaceId: account.namespaceId,
        name: `${account.name.slice(0, 145)} managed token ${account.id}`,
        lifecycleConfig: { settings: {} },
        secret: credential.accessToken,
        config: { provider_preset: "codex-pat" },
      },
      AbortSignal.timeout(30_000),
    );
    if (
      created.ownerCapability !== "credential_service" ||
      created.type !== "static" ||
      created.namespaceId !== account.namespaceId ||
      created.state !== "ready" ||
      created.config.provider_preset !== "codex-pat"
    ) {
      throw new DependencyUnavailableError(
        "The selected CredentialService returned an invalid Source.",
      );
    }
    source = created;

    const result = await this.query(
      `UPDATE occ.service_account_driver_bindings
       SET external_credential_id = $4
       WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3`,
      [account.id, account.namespaceId, this.id, credential.id],
    );
    if (result.rowCount !== 1) {
      throw new DependencyUnavailableError("The exact service-account Driver binding is missing.");
    }
    return { kind: "access_token", sourceId: source.id };
  }

  async delete(account: ServiceAccount): Promise<void> {
    const linked = await this.findBinding(account);
    if (linked === undefined) {
      return;
    }
    if (linked.externalCredentialId !== null) {
      await this.client.deleteCredential({
        accountId: linked.externalAccountId,
        credentialId: linked.externalCredentialId,
      });
    }
    await this.client.deleteServiceAccount(linked.externalAccountId);
  }

  private async removeSource(source: StaticCredentialSource): Promise<void> {
    await this.controller.transact(async (unit) => {
      await unit.credentialSources.markCredentialSourceDeleting(source.namespaceId, source.id);
    });
    await this.controller.selectedDriver("credential_service").removeSource(
      {
        sourceRef: { kind: "credential_source", namespaceId: source.namespaceId, id: source.id },
        credentialServiceInstanceId: source.credentialServiceInstanceId,
      },
      AbortSignal.timeout(30_000),
    );
  }

  private async findBinding(account: ServiceAccount): Promise<ServiceAccountBinding | undefined> {
    const result = await this.query(
      `SELECT driver_id AS "driverId", external_account_id AS "externalAccountId",
              backend_id AS "backendId", external_credential_id AS "externalCredentialId",
              workspace_id AS "workspaceId"
       FROM occ.service_account_driver_bindings
       WHERE service_account_id = $1 AND namespace_id = $2`,
      [account.id, account.namespaceId],
    );
    if (result.rows.length === 0) {
      return undefined;
    }
    const linked = result.rows[0] as ServiceAccountBinding;
    if (linked.backendId !== this.backendId) {
      throw new DependencyUnavailableError("The service-account Backend does not match.");
    }
    if (linked.driverId !== this.id) {
      throw new DependencyUnavailableError("The service-account backend Driver does not match.");
    }
    if (linked.workspaceId !== this.client.workspaceId) {
      throw new DependencyUnavailableError("The service-account backend workspace does not match.");
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

export function createChatGPTServiceAccountDriverFactory(backend: Backend<ChatGPTClient>) {
  return (controller: OpenClawController, state: PostgresPlatformState): void => {
    const driver = new ChatGPTServiceAccountDriver(backend, controller, state);
    controller.registerDriver(driver);
    if (controller.selectDriver("service_account", driver.id) !== driver) {
      throw new Error("The configured ServiceAccount Driver was not selected correctly.");
    }
  };
}
