import type {
  AuditEvent,
  CredentialSourceDeviceAuthorization,
  OAuthCredentialSource,
  ResourceRef,
  TokenServiceDeviceAuthorizationContext,
  TokenServiceDriver,
} from "@openclaw-enterprise/contracts";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import type { PlatformUnitOfWork } from "./ports/platform-unit-of-work.ts";
import {
  cancelledDeviceAuthorization,
  deviceAuthorizationScope,
  type DeviceAuthorizationSession,
  type deviceAuthorizationCipher,
} from "./device-authorization.ts";
import {
  AgentDeletingError,
  DeviceAuthorizationScopeMismatchError,
  DeviceAuthorizationStartError,
  NamespaceNotReadyError,
  NotImplementedError,
  ResourceStateConflictError,
  RetryLaterError,
  ScopeViolationError,
} from "./errors.ts";
import { CONNECTION_OPERATION_TIMEOUT_MS } from "./oauth-consent.ts";
import { exactNamespace, lockNamespace } from "./resource-scope.ts";

export type DeviceAuthorizationAudit = (source: Readonly<OAuthCredentialSource>) => AuditEvent;

interface DeviceAuthorizationDependencies {
  readonly installationId: string;
  readonly cipher: ReturnType<typeof deviceAuthorizationCipher> | undefined;
  readonly nextSessionId: () => string;
  readonly timestamp: () => string;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly hasTokenService: () => boolean;
  readonly ownedTokenServiceDriver: (instanceId?: string) => TokenServiceDriver;
  readonly currentTokenServiceInstanceId: () => string;
  readonly bindCreator: (
    state: PlatformUnitOfWork,
    principalId: string,
    resource: ResourceRef & { readonly namespaceId: string },
  ) => Promise<void>;
}

export function createDeviceAuthorizationFlow(deps: DeviceAuthorizationDependencies) {
  const { read, transact } = deps.transactions;
  const { authorize, holdAuthority } = deps.authority;
  async function authorizeScope(
    principalId: string,
    namespaceId: string,
    agentId?: string,
  ): Promise<void> {
    const target: ResourceRef = {
      kind: "agent",
      id: agentId === undefined ? namespaceId : agentId,
      namespaceId,
    };
    const [firstAction, ...additionalActions] =
      agentId === undefined ? (["create"] as const) : (["read", "update"] as const);
    await authorize(principalId, firstAction, target);
    for (const action of additionalActions) {
      await authorize(principalId, action, target);
    }
    await read(async (state) => {
      const namespace = await exactNamespace(state, namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      if (agentId !== undefined) {
        const agent = await state.agents.findAgent(namespaceId, agentId);
        if (agent === undefined) {
          throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
        }
        if (agent.status !== "active") {
          throw new AgentDeletingError();
        }
        if (agent.executionMode !== "dedicated") {
          throw new NotImplementedError(
            "agent_device_authorization",
            "Device login requires a dedicated Agent.",
          );
        }
      }
    });
  }

  function sourceTarget(namespaceId: string): ResourceRef {
    return { kind: "credential_source", id: namespaceId, namespaceId };
  }

  function context(
    session: Pick<DeviceAuthorizationSession, "namespaceId" | "actorId" | "harnessId">,
  ): TokenServiceDeviceAuthorizationContext {
    return {
      namespaceId: session.namespaceId,
      ownerPrincipalId: session.actorId,
      harnessId: session.harnessId,
    };
  }

  async function start(
    principalId: string,
    namespaceId: string,
    harnessId: string,
    agentId?: string,
    audit?: AuditEvent,
  ) {
    await authorizeScope(principalId, namespaceId, agentId);
    await authorize(principalId, "create", sourceTarget(namespaceId));
    if (!deps.hasTokenService()) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device authorization is unavailable without a selected TokenService.",
      );
    }
    const owner = deps.ownedTokenServiceDriver();
    const tokenServiceInstanceId = deps.currentTokenServiceInstanceId();
    const cipher = deps.cipher;
    if (!owner.startDeviceAuthorization || !owner.pollDeviceAuthorization || !cipher) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device authorization is unavailable for the selected TokenService.",
      );
    }
    let started: CredentialSourceDeviceAuthorization;
    try {
      started = await owner.startDeviceAuthorization(
        { namespaceId, ownerPrincipalId: principalId, harnessId },
        AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
      );
    } catch (error) {
      throw error instanceof DeviceAuthorizationStartError
        ? error
        : new DeviceAuthorizationStartError("unavailable");
    }
    await authorizeScope(principalId, namespaceId, agentId);
    const { privateState, intervalSeconds, userCode, verificationUrl } = started;
    const expiresAt = new Date(started.expiresAt).toISOString();
    const sessionId = deps.nextSessionId();
    const session: DeviceAuthorizationSession = {
      actorId: principalId,
      namespaceId,
      ...(agentId === undefined ? {} : { agentId }),
      harnessId,
      tokenServiceInstanceId,
      phase: "pending",
      expiresAt,
      nextPollAt: new Date(Date.parse(deps.timestamp()) + intervalSeconds * 1000).toISOString(),
      intervalSeconds,
    };
    const encrypted = cipher.seal(
      privateState,
      deviceAuthorizationScope(deps.installationId, sessionId, session, "provider_handle"),
    );
    const encryptedChallenge = cipher.seal(
      JSON.stringify({ verificationUrl, userCode }),
      deviceAuthorizationScope(deps.installationId, sessionId, session, "challenge"),
    );
    await transact(async (state) => {
      await holdAuthority(state);
      const namespace = await lockNamespace(state, namespaceId);
      await authorize(principalId, "create", sourceTarget(namespaceId));
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      deps.ownedTokenServiceDriver(tokenServiceInstanceId);
      await state.authenticationStates.create({
        ...session,
        kind: "device_authorization",
        id: sessionId,
        version: 1,
        encryptedChallenge,
        privateState: encrypted,
      });
      if (audit) {
        await state.audit.append(audit);
      }
    });
    return {
      session: { id: sessionId, namespaceId },
      status: "pending" as const,
      expiresAt,
      intervalSeconds,
      userCode,
      verificationUrl,
    };
  }

  async function poll(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
    audit?: DeviceAuthorizationAudit,
  ) {
    const session = await readSession(principalId, namespaceId, sessionId, agentId);
    const { version } = session;
    if (
      session.phase === "cancelled" ||
      Date.parse(session.expiresAt) <= Date.parse(deps.timestamp())
    ) {
      if (session.phase !== "cancelled") {
        await replaceSession(sessionId, version, cancelledDeviceAuthorization(session));
      }
      throw new ResourceStateConflictError("Device login expired or was cancelled. Connect again.");
    }
    const owner = deps.ownedTokenServiceDriver(session.tokenServiceInstanceId);
    const cipher = deps.cipher;
    if (!owner.pollDeviceAuthorization || !cipher || !session.encryptedChallenge) {
      throw new ResourceStateConflictError(
        "This login is no longer available in OCE. Connect again.",
      );
    }
    const challenge = JSON.parse(
      cipher.open(
        session.encryptedChallenge,
        deviceAuthorizationScope(deps.installationId, sessionId, session, "challenge"),
      ),
    ) as Pick<CredentialSourceDeviceAuthorization, "verificationUrl" | "userCode">;
    const response = (
      status: "pending" | "ready",
      expiresAt = session.expiresAt,
      sourceId?: string,
    ) => ({
      session: { id: sessionId, namespaceId },
      ...(sourceId === undefined
        ? {}
        : { source: { kind: "credential_source" as const, namespaceId, id: sourceId } }),
      status,
      expiresAt,
      intervalSeconds: session.intervalSeconds,
      ...challenge,
    });
    if (session.phase === "ready") {
      if (session.sourceId === undefined) {
        throw new ResourceStateConflictError("The completed login has no Source.");
      }
      await authorize(principalId, "operate", {
        kind: "credential_source",
        namespaceId,
        id: session.sourceId,
      });
      return response("ready", session.expiresAt, session.sourceId);
    }
    if (
      session.phase === "polling" ||
      Date.parse(session.nextPollAt) > Date.parse(deps.timestamp())
    ) {
      return response("pending");
    }
    if (!audit) {
      throw new ResourceStateConflictError("Source creation requires audit evidence.");
    }
    if (!session.privateState) {
      throw new ResourceStateConflictError(
        "This login is no longer available in OCE. Connect again.",
      );
    }
    const handle = cipher.open(
      session.privateState,
      deviceAuthorizationScope(deps.installationId, sessionId, session, "provider_handle"),
    );
    if (!(await replaceSession(sessionId, version, { ...session, phase: "polling" }))) {
      return response("pending");
    }
    const claimedVersion = version + 1;
    let callbackError: unknown;
    let result: Awaited<ReturnType<NonNullable<TokenServiceDriver["pollDeviceAuthorization"]>>>;
    try {
      result = await owner.pollDeviceAuthorization(
        context(session),
        handle,
        async () => {
          try {
            await authorizeScope(principalId, namespaceId, agentId);
            await authorize(principalId, "create", sourceTarget(namespaceId));
            deps.ownedTokenServiceDriver(session.tokenServiceInstanceId);
            const claimed = await read((state) =>
              state.authenticationStates.findDevice(namespaceId, sessionId),
            );
            if (
              !claimed ||
              claimed.version !== claimedVersion ||
              claimed.phase !== "polling" ||
              claimed.actorId !== principalId ||
              claimed.agentId !== agentId ||
              claimed.harnessId !== session.harnessId ||
              claimed.tokenServiceInstanceId !== session.tokenServiceInstanceId ||
              Date.parse(claimed.expiresAt) <= Date.parse(deps.timestamp())
            ) {
              throw new ResourceStateConflictError(
                "The login changed while authorizing. Connect again.",
              );
            }
          } catch (error) {
            callbackError = error;
            throw error;
          }
        },
        AbortSignal.timeout(CONNECTION_OPERATION_TIMEOUT_MS),
      );
    } catch (error) {
      // An uncertain external exchange must not be retried with the same handle.
      await replaceSession(sessionId, claimedVersion, cancelledDeviceAuthorization(session));
      if (callbackError === error) {
        throw error;
      }
      throw new RetryLaterError("deviceLoginFailed", error);
    }
    if (result.status === "pending") {
      if (Date.parse(session.expiresAt) <= Date.parse(deps.timestamp())) {
        await replaceSession(sessionId, claimedVersion, cancelledDeviceAuthorization(session));
        throw new ResourceStateConflictError(
          "Device login expired or was cancelled. Connect again.",
        );
      }
      const next: DeviceAuthorizationSession = {
        ...session,
        phase: "pending",
        nextPollAt: new Date(
          Date.parse(deps.timestamp()) + session.intervalSeconds * 1000,
        ).toISOString(),
      };
      if (!(await replaceSession(sessionId, claimedVersion, next))) {
        throw new ResourceStateConflictError("The login changed while polling. Connect again.");
      }
      return response("pending");
    }
    const source = result.source;
    if (
      source.ownerCapability !== "token_service" ||
      source.type !== "oauth2-refresh-token" ||
      source.state !== "ready" ||
      source.namespaceId !== namespaceId ||
      source.tokenServiceInstanceId !== session.tokenServiceInstanceId ||
      source.connectionTemplateId !== undefined ||
      source.consent.kind !== "builtin_codex" ||
      source.consent.ownerPrincipalId !== principalId
    ) {
      await replaceSession(sessionId, claimedVersion, cancelledDeviceAuthorization(session));
      throw new ResourceStateConflictError("TokenService returned an invalid OAuth Source.");
    }
    const { privateState: _handle, encryptedChallenge: _challenge, ...metadata } = session;
    const ready: DeviceAuthorizationSession = {
      ...metadata,
      sourceId: source.id,
      phase: "ready",
      expiresAt: new Date(Date.parse(deps.timestamp()) + 24 * 60 * 60 * 1000).toISOString(),
    };
    const completed = {
      ...ready,
      encryptedChallenge: cipher.seal(
        JSON.stringify(challenge),
        deviceAuthorizationScope(deps.installationId, sessionId, ready, "challenge"),
      ),
    };
    let settled: boolean;
    try {
      settled = await transact(async (state) => {
        await holdAuthority(state);
        const ref = { kind: "credential_source" as const, namespaceId, id: source.id };
        await deps.bindCreator(state, principalId, ref);
        await state.audit.append(audit(source));
        if (Date.parse(session.expiresAt) <= Date.parse(deps.timestamp())) {
          await state.authenticationStates.replaceDevice(
            namespaceId,
            sessionId,
            claimedVersion,
            cancelledDeviceAuthorization(session),
          );
          return false;
        }
        return state.authenticationStates.replaceDevice(
          namespaceId,
          sessionId,
          claimedVersion,
          completed,
        );
      });
    } catch (error) {
      await replaceSession(sessionId, claimedVersion, cancelledDeviceAuthorization(session));
      throw error;
    }
    if (!settled) {
      throw new ResourceStateConflictError("The login changed while completing. Connect again.");
    }
    await authorize(principalId, "operate", {
      kind: "credential_source",
      namespaceId,
      id: source.id,
    });
    return response("ready", ready.expiresAt, source.id);
  }

  async function cancel(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ): Promise<void> {
    const session = await readSession(principalId, namespaceId, sessionId, agentId);
    if (
      !(await replaceSession(sessionId, session.version, cancelledDeviceAuthorization(session)))
    ) {
      throw new ResourceStateConflictError("The login session changed. Refresh and retry.");
    }
  }

  function replaceSession(id: string, version: number, session: DeviceAuthorizationSession) {
    return transact((state) =>
      state.authenticationStates.replaceDevice(session.namespaceId, id, version, session),
    );
  }

  async function readSession(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ) {
    await authorizeScope(principalId, namespaceId, agentId);
    const stored = await read((state) =>
      state.authenticationStates.findDevice(namespaceId, sessionId),
    );
    if (stored === undefined) {
      throw new ScopeViolationError("The login does not belong to the exact Namespace.");
    }
    if (stored.actorId !== principalId || stored.agentId !== agentId) {
      throw new DeviceAuthorizationScopeMismatchError();
    }
    return stored;
  }

  return { start, poll, cancel };
}
