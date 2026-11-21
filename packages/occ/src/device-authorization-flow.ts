import type {
  AuditEvent,
  CredentialGatewayDriver,
  CredentialRefreshDriver,
  CredentialSource,
  CredentialSourceContext,
  CredentialSourceDeviceAuthorization,
  CredentialSourceDeviceAuthorizationResult,
  CredentialSourceMetadata,
  ResourceRef,
} from "@openclaw-enterprise/contracts";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
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
import { exactNamespace, lockNamespace } from "./resource-scope.ts";

type SourceAudit = (source: Readonly<CredentialSourceMetadata>) => AuditEvent;
export type DeviceAuthorizationAudit = (
  source: Readonly<CredentialSourceMetadata>,
  phase: "source_registering" | "source_ready" | "session_pending",
) => AuditEvent;

type GatewaySourceContext = {
  readonly gateway: CredentialGatewayDriver;
  readonly context: CredentialSourceContext;
};

interface DeviceAuthorizationDependencies {
  readonly installationId: string;
  readonly cipher: ReturnType<typeof deviceAuthorizationCipher> | undefined;
  readonly gatewayTimeoutMs: number;
  readonly nextSessionId: () => string;
  readonly timestamp: () => string;
  readonly transactions: Pick<ControllerTransactions, "read" | "transact">;
  readonly authority: Pick<ControllerAuthority, "authorize" | "holdAuthority">;
  readonly hasDriver: (capability: "credential_gateway" | "credential_refresh") => boolean;
  readonly credentialGatewayDriver: () => CredentialGatewayDriver;
  readonly credentialRefreshDriver: () => CredentialRefreshDriver;
  readonly credentialGatewayOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly credentialSourceContext: (
    namespaceId: string,
    id: string,
  ) => Promise<GatewaySourceContext>;
  readonly authorizedCredentialSource: (
    principalId: string,
    namespaceId: string,
    id: string,
  ) => Promise<GatewaySourceContext>;
  readonly createSource: (
    principalId: string,
    input: Pick<CredentialSource, "namespaceId" | "name" | "type">,
    audit?: SourceAudit,
    registrationAudit?: SourceAudit,
  ) => Promise<Readonly<CredentialSourceMetadata>>;
  readonly credentialSourceMetadata: (
    source: Readonly<CredentialSource>,
  ) => Readonly<CredentialSourceMetadata>;
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

  async function start(
    principalId: string,
    namespaceId: string,
    harnessId: string,
    agentId?: string,
    audit?: DeviceAuthorizationAudit,
  ) {
    await authorizeScope(principalId, namespaceId, agentId);
    const sourceTarget: ResourceRef = {
      kind: "credential_source",
      id: namespaceId,
      namespaceId,
    };
    // A missing grant must return its audited denial before checking Driver availability.
    // Source registration checks the grant again before writing the source.
    await authorize(principalId, "create", sourceTarget);
    if (!deps.hasDriver("credential_gateway") || !deps.hasDriver("credential_refresh")) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device login needs a Credential Gateway and a Credential Refresh Driver, and this Installation does not select both. Ask an Installation administrator to select them; see the credential lifecycle guide.",
      );
    }
    const gateway = deps.credentialGatewayDriver();
    const refresh = deps.credentialRefreshDriver();
    const cipher = deps.cipher;
    if (!refresh.startDeviceAuthorization || !refresh.pollDeviceAuthorization || !cipher) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device authorization is unavailable for the selected Drivers.",
      );
    }
    const types = await deps.credentialGatewayOperation(() =>
      gateway.listSourceTypes({ signal: AbortSignal.timeout(deps.gatewayTimeoutMs) }),
    );
    const supported = types.filter(
      (type) => type.rotation === "refresh" && type.deviceAuthorization?.harnessId === harnessId,
    );
    if (supported.length !== 1) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "The Credential Gateway must provide one device-login source for this Harness.",
      );
    }
    // Persist the source before external login. Failed or abandoned attempts remain visible
    // in credential-source management; closing a login must never revoke an Agent's source.
    const source = await deps.createSource(
      principalId,
      {
        namespaceId,
        name: `Device login ${crypto.randomUUID()}`,
        type: supported[0]!.type,
      },
      audit === undefined ? undefined : (source) => audit(source, "source_ready"),
      audit === undefined ? undefined : (source) => audit(source, "source_registering"),
    );
    const { context } = await deps.credentialSourceContext(namespaceId, source.id);
    // Registration can outlive an IAM change; check the start authority again before provider I/O.
    await authorizeScope(principalId, namespaceId, agentId);
    await authorize(principalId, "create", sourceTarget);
    let started: CredentialSourceDeviceAuthorization;
    try {
      started = await refresh.startDeviceAuthorization(context);
    } catch (error) {
      throw error instanceof DeviceAuthorizationStartError
        ? error
        : new DeviceAuthorizationStartError("unavailable");
    }
    await authorizeScope(principalId, namespaceId, agentId);
    const { privateState, intervalSeconds, userCode, verificationUrl } = started;
    const expiresAt = new Date(started.expiresAt).toISOString();
    const sessionId = deps.nextSessionId();
    const handle = { id: sessionId, namespaceId };
    const session: DeviceAuthorizationSession = {
      actorId: principalId,
      namespaceId,
      ...(agentId === undefined ? {} : { agentId }),
      harnessId,
      credentialGatewayId: gateway.id,
      credentialRefreshId: refresh.id,
      sourceId: source.id,
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
      await authorize(principalId, "create", sourceTarget);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      await state.authenticationStates.create({
        ...session,
        kind: "device_authorization",
        id: sessionId,
        version: 1,
        encryptedChallenge,
        privateState: encrypted,
      });
      if (audit !== undefined) {
        await state.audit.append(audit(source, "session_pending"));
      }
    });
    return {
      session: handle,
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
  ) {
    const session = await readSession(principalId, namespaceId, sessionId, agentId);
    const { version } = session;
    await authorize(principalId, "operate", {
      kind: "credential_source",
      namespaceId,
      id: session.sourceId,
    });
    if (
      session.phase === "cancelled" ||
      Date.parse(session.expiresAt) <= Date.parse(deps.timestamp())
    ) {
      if (session.phase !== "cancelled") {
        // Expiry closes the login handle; the separately managed credential source survives.
        await replaceSession(sessionId, version, cancelledDeviceAuthorization(session));
      }
      throw new ResourceStateConflictError("Device login expired or was cancelled. Connect again.");
    }
    const { gateway, context } = await deps.credentialSourceContext(namespaceId, session.sourceId);
    const refresh = deps.hasDriver("credential_refresh")
      ? deps.credentialRefreshDriver()
      : undefined;
    if (
      gateway.id !== session.credentialGatewayId ||
      refresh?.id !== session.credentialRefreshId ||
      !refresh.pollDeviceAuthorization
    ) {
      throw new ResourceStateConflictError("The login Driver changed. Connect again.");
    }
    const cipher = deps.cipher;
    if (!cipher) {
      throw new NotImplementedError(
        "agent_device_authorization",
        "Device login session encryption is unavailable.",
      );
    }
    if (!session.encryptedChallenge) {
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
    const response = (status: "pending" | "ready", expiresAt = session.expiresAt) => ({
      session: { id: sessionId, namespaceId },
      ...(status === "ready" ? { source: deps.credentialSourceMetadata(context.source).ref } : {}),
      status,
      expiresAt,
      intervalSeconds: session.intervalSeconds,
      ...challenge,
    });
    if (session.phase === "ready") {
      return response("ready");
    }
    if (
      session.phase === "polling" ||
      Date.parse(session.nextPollAt) > Date.parse(deps.timestamp())
    ) {
      return response("pending");
    }
    const { privateState, ...metadata } = session;
    if (!privateState) {
      throw new ResourceStateConflictError(
        "This login is no longer available in OCE. Connect again.",
      );
    }
    const handle = cipher.open(
      privateState,
      deviceAuthorizationScope(deps.installationId, sessionId, session, "provider_handle"),
    );
    if (!(await replaceSession(sessionId, version, { ...session, phase: "polling" }))) {
      return response("pending");
    }
    const claimedVersion = version + 1;
    let result: CredentialSourceDeviceAuthorizationResult;
    try {
      result = await refresh.pollDeviceAuthorization(context, handle);
    } catch (error) {
      // An uncertain external exchange is not replayed. The source remains visible for recovery.
      await replaceSession(sessionId, claimedVersion, cancelledDeviceAuthorization(session));
      throw new RetryLaterError("deviceLoginFailed", error);
    }
    await authorizeScope(principalId, namespaceId, agentId);
    const current = await deps.authorizedCredentialSource(
      principalId,
      namespaceId,
      session.sourceId,
    );
    if (
      current.gateway.id !== session.credentialGatewayId ||
      !deps.hasDriver("credential_refresh") ||
      deps.credentialRefreshDriver().id !== session.credentialRefreshId
    ) {
      throw new ResourceStateConflictError("The login Driver changed. Connect again.");
    }
    if (Date.parse(session.expiresAt) <= Date.parse(deps.timestamp())) {
      await replaceSession(sessionId, claimedVersion, cancelledDeviceAuthorization(session));
      throw new ResourceStateConflictError("Device login expired or was cancelled. Connect again.");
    }
    const next: DeviceAuthorizationSession =
      result.status === "pending"
        ? {
            ...session,
            phase: "pending",
            nextPollAt: new Date(
              Date.parse(deps.timestamp()) + session.intervalSeconds * 1000,
            ).toISOString(),
          }
        : {
            ...metadata,
            phase: "ready",
            expiresAt: new Date(Date.parse(deps.timestamp()) + 24 * 60 * 60 * 1000).toISOString(),
          };
    if (!(await replaceSession(sessionId, claimedVersion, next))) {
      throw new ResourceStateConflictError("The login changed while completing. Connect again.");
    }
    return response(result.status, next.expiresAt);
  }

  async function cancel(
    principalId: string,
    namespaceId: string,
    sessionId: string,
    agentId?: string,
  ): Promise<void> {
    const session = await readSession(principalId, namespaceId, sessionId, agentId);
    const { version } = session;
    // Local discard must never revoke a shared upstream login session.
    if (!(await replaceSession(sessionId, version, cancelledDeviceAuthorization(session)))) {
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
