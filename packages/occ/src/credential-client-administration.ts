import { isDeepStrictEqual } from "node:util";
import {
  ConnectionTemplateValidationError,
  type AuditEvent,
  type CredentialClient,
  type CredentialClientSecretInstance,
  type OAuthClient,
  type OAuthClientSecretInstance,
  type TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { driverOperation } from "./driver-operation.ts";
import {
  DependencyUnavailableError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type { StoredCredentialClient } from "./ports/credential-clients.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import { lockNamespace } from "./resource-scope.ts";

export type CreateCredentialClientInput = Pick<CredentialClient, "displayName" | "namespaceId"> &
  (
    | (Pick<
        OAuthClient,
        "kind" | "clientId" | "tokenEndpointAuthMethod" | "issuer" | "tokenUrl" | "revocationUrl"
      > & { readonly clientSecret?: string })
    | { readonly kind: "github-app"; readonly appId: string; readonly privateKey: string }
  );
export type RotateCredentialClientInput =
  | { readonly kind: "oauth2"; readonly clientSecret: string }
  | { readonly kind: "github-app"; readonly privateKey: string };

function clientMetadata({
  tokenServiceInstanceId: _owner,
  ...metadata
}: StoredCredentialClient): CredentialClient {
  return immutableCopy(metadata);
}

interface CredentialClientAdministrationDependencies {
  readonly installationId: string;
  readonly transactions: Pick<
    ControllerTransactions,
    "read" | "transact" | "requireIndependentMutation"
  >;
  readonly authority: Pick<ControllerAuthority, "authorize">;
  readonly tokenServiceDriver: (expectedInstanceId?: string) => TokenServiceDriver;
  readonly tokenServiceInstanceId: () => string;
  readonly tokenServiceTimeoutMs: number;
  readonly now: () => Date;
  readonly timestamp: () => string;
}

export function createCredentialClientAdministration({
  installationId,
  transactions,
  authority,
  tokenServiceDriver,
  tokenServiceInstanceId,
  tokenServiceTimeoutMs,
  now,
  timestamp,
}: CredentialClientAdministrationDependencies) {
  const { read, transact, requireIndependentMutation } = transactions;

  async function authorizeAdministration(principalId: string): Promise<void> {
    await authority.authorize(principalId, "administer", {
      kind: "installation",
      id: installationId,
    });
  }

  async function listCredentialClients(principalId: string) {
    await authorizeAdministration(principalId);
    const clients = await read((view) => view.credentialClients.list());
    return Object.freeze(clients.map(clientMetadata));
  }

  function selectedClientOwner(kind: CredentialClient["kind"], namespaceId?: string) {
    const driver = tokenServiceDriver();
    const scope = namespaceId === undefined ? "installation" : "namespace";
    if (!driver.clientScopes[kind]?.includes(scope)) {
      throw new DependencyUnavailableError(
        `The selected TokenService does not support ${kind} clients at ${scope} scope.`,
      );
    }
    return driver;
  }

  function clientInstance(client: StoredCredentialClient): CredentialClientSecretInstance {
    const tokenServiceInstanceId = client.tokenServiceInstanceId;
    if (!tokenServiceInstanceId) {
      throw new ResourceStateConflictError("This client has no private material.");
    }
    const owner = {
      id: client.id,
      tokenServiceInstanceId,
      ...(client.namespaceId !== undefined && { namespaceId: client.namespaceId }),
    };
    return client.kind === "github-app"
      ? { ...owner, kind: client.kind, appId: client.appId }
      : { ...owner, kind: client.kind, tokenUrl: client.tokenUrl };
  }

  function signal() {
    return AbortSignal.timeout(tokenServiceTimeoutMs);
  }

  function checkedOAuthUrl(field: "issuer" | "tokenUrl" | "revocationUrl", value: string) {
    if (
      !/^https:\/\/[^/?#@\s\\]+(?:[/?][^#\s\\]*)?$/.test(value) ||
      !URL.canParse(value) ||
      (field === "issuer" && value.includes("?"))
    ) {
      throw new ConnectionTemplateValidationError(field, `${field} must be an approved HTTPS URL.`);
    }
  }

  async function createCredentialClient(
    principalId: string,
    input: CreateCredentialClientInput,
    audit?: (id: string) => AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    requireIndependentMutation("Credential client registration");
    await authorizeAdministration(principalId);
    if (
      !isNonEmptyString(input.displayName) ||
      input.displayName !== input.displayName.trim() ||
      input.displayName.length > 200
    ) {
      throw new ConnectionTemplateValidationError("displayName", "Provide a client name.");
    }
    const id = `ccr_${crypto.randomUUID()}`;
    const common = {
      id,
      displayName: input.displayName,
      createdAt: timestamp(),
      ...(input.namespaceId !== undefined && { namespaceId: input.namespaceId }),
    };
    let client: CredentialClient;
    let material: string | undefined;
    if (input.kind === "github-app") {
      if (!/^[1-9][0-9]{0,15}$/.test(input.appId) || !Number.isSafeInteger(Number(input.appId))) {
        throw new ConnectionTemplateValidationError("appId", "Provide a valid GitHub App ID.");
      }
      if (!isNonEmptyString(input.privateKey)) {
        throw new ConnectionTemplateValidationError("privateKey", "Provide the App private key.");
      }
      client = {
        ...common,
        kind: "github-app",
        appId: input.appId,
      };
      material = input.privateKey;
    } else {
      const oauth = input;
      checkedOAuthUrl("issuer", oauth.issuer);
      checkedOAuthUrl("tokenUrl", oauth.tokenUrl);
      if (oauth.revocationUrl !== undefined) {
        checkedOAuthUrl("revocationUrl", oauth.revocationUrl);
      }
      if (
        !/^[!-~]{1,256}$/.test(oauth.clientId) ||
        !["none", "client_secret_basic", "client_secret_post"].includes(
          oauth.tokenEndpointAuthMethod,
        )
      ) {
        throw new ConnectionTemplateValidationError(
          "clientId",
          "Provide a valid OAuth client identity and authentication method.",
        );
      }
      if (
        oauth.tokenEndpointAuthMethod === "none"
          ? oauth.clientSecret !== undefined
          : !isNonEmptyString(oauth.clientSecret)
      ) {
        throw new ConnectionTemplateValidationError(
          "clientSecret",
          "Provide a secret only for a confidential OAuth client.",
        );
      }
      client = {
        ...common,
        kind: "oauth2",
        clientId: oauth.clientId,
        issuer: oauth.issuer,
        tokenUrl: oauth.tokenUrl,
        tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
        ...(oauth.revocationUrl !== undefined && { revocationUrl: oauth.revocationUrl }),
      };
      material = oauth.clientSecret;
    }
    selectedClientOwner(client.kind, client.namespaceId);
    const registration: StoredCredentialClient =
      material === undefined
        ? client
        : { ...client, tokenServiceInstanceId: tokenServiceInstanceId() };
    await transact(async (state) => {
      await authorizeAdministration(principalId);
      await holdSession?.(state);
      if (
        client.namespaceId !== undefined &&
        (await lockNamespace(state, client.namespaceId)).status === "deleting"
      ) {
        throw new ResourceStateConflictError("The Namespace is being deleted.");
      }
      const cleanupAfter =
        material === undefined ? undefined : new Date(now().getTime() + 5 * 60_000).toISOString();
      await state.credentialClients.create(registration, cleanupAfter);
      if (material === undefined && audit) {
        await state.audit.append(audit(id));
      }
    });
    if (material !== undefined) {
      await transact(async (state) => {
        await authorizeAdministration(principalId);
        await holdSession?.(state);
        const reserved = await state.credentialClients.lockForCleanup(id, false);
        if (!reserved) {
          throw new ResourceStateConflictError(
            "The client reservation expired. Register the client again.",
          );
        }
        const instance = clientInstance(reserved);
        const owner = tokenServiceDriver(instance.tokenServiceInstanceId);
        await driverOperation(
          () => owner.registerClientSecret(instance, material!, signal()),
          "TokenService",
        );
        await state.credentialClients.setCleanup(id, null);
        if (audit) {
          await state.audit.append(audit(id));
        }
      });
    }
    return client;
  }

  async function rotateCredentialClient(
    principalId: string,
    id: string,
    input: RotateCredentialClientInput,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    requireIndependentMutation("Credential client secret rotation");
    await authorizeAdministration(principalId);
    const lockClient = async (state: PlatformUnitOfWork) => {
      const client = await state.credentialClients.lock(id);
      await authorizeAdministration(principalId);
      await holdSession?.(state);
      if (!client) {
        throw new ScopeViolationError("The client does not exist.");
      }
      if (client.kind === "oauth2" && client.tokenEndpointAuthMethod === "none") {
        throw new ResourceStateConflictError("This public client authenticates without a secret.");
      }
      if (client.kind !== input.kind) {
        throw new ConnectionTemplateValidationError(
          "secret",
          "Supply private material for the stored client kind.",
        );
      }
      return client;
    };
    if (audit) {
      await transact(async (state) => {
        await lockClient(state);
        await state.audit.append({
          ...audit,
          id: `aud_${crypto.randomUUID()}`,
          details: { ...audit.details, phase: "requested" },
        });
      });
    }
    return transact(async (state) => {
      const client = await lockClient(state);
      const instance = clientInstance(client);
      const owner = tokenServiceDriver(instance.tokenServiceInstanceId);
      const material = input.kind === "github-app" ? input.privateKey : input.clientSecret;
      await driverOperation(
        () => owner.updateClientSecret(instance, material, signal()),
        "TokenService",
      );
      if (audit) {
        await state.audit.append({ ...audit, occurredAt: timestamp() });
      }
      return clientMetadata(client);
    });
  }

  async function deleteCredentialClient(
    principalId: string,
    id: string,
    audit?: AuditEvent,
    holdSession?: (unit: PlatformUnitOfWork) => Promise<void>,
  ) {
    await authorizeAdministration(principalId);
    await transact(async (state) => {
      const client = await state.credentialClients.lock(id);
      await authorizeAdministration(principalId);
      await holdSession?.(state);
      if (!client) {
        throw new ScopeViolationError("The client does not exist.");
      }
      if (
        !(await state.credentialClients.delete(id, client.tokenServiceInstanceId !== undefined))
      ) {
        throw new ResourceStateConflictError(
          client.kind === "github-app"
            ? "An Agent draft or a Source still references this GitHub App Client."
            : "A Source or pending consent still references this client.",
        );
      }
      if (audit) {
        await state.audit.append(audit);
      }
    });
  }

  async function cleanupCredentialClients(): Promise<void> {
    const ids = await read((view) => view.credentialClients.listCleanups(32));
    for (const id of ids) {
      await transact(async (state) => {
        const client = await state.credentialClients.lockForCleanup(id, true);
        if (!client) {
          return;
        }
        try {
          const instance = clientInstance(client);
          const owner = tokenServiceDriver(instance.tokenServiceInstanceId);
          await driverOperation(() => owner.removeClientSecret(instance, signal()), "TokenService");
        } catch {
          await state.credentialClients.setCleanup(
            id,
            new Date(now().getTime() + 60_000).toISOString(),
          );
          return;
        }
        if (!(await state.credentialClients.delete(id))) {
          throw new ResourceStateConflictError("The client is still referenced.");
        }
      });
    }
  }

  async function withOAuthClientSecret<T>(
    client: Readonly<OAuthClient>,
    use: (secret: string | undefined) => Promise<T>,
  ): Promise<T> {
    const current = await read((view) => view.credentialClients.find(client.id));
    if (
      !current ||
      current.kind !== "oauth2" ||
      !isDeepStrictEqual(clientMetadata(current), client)
    ) {
      throw new ResourceStateConflictError("The approved OAuth client is unavailable.");
    }
    if (current.tokenEndpointAuthMethod === "none") {
      return use(undefined);
    }
    const instance = clientInstance(current) as OAuthClientSecretInstance;
    const owner = tokenServiceDriver(instance.tokenServiceInstanceId);
    const secret = await driverOperation(
      () => owner.resolveClientSecret(instance, signal()),
      "TokenService",
    );
    return use(secret);
  }

  return {
    listCredentialClients,
    createCredentialClient,
    rotateCredentialClient,
    deleteCredentialClient,
    cleanupCredentialClients,
    withOAuthClientSecret,
  };
}
