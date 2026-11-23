import {
  credentialSourceMatchesSnapshot,
  revisionCredentialSourceSnapshot,
  type AuditEvent,
  type CredentialProxyDriver,
  type CredentialSourceReference,
  type PushAgentCredentialsBody,
  type PushAgentCredentialsResponse,
  type TokenServiceDriver,
} from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";

import type { ControllerAuthority } from "./controller-authority.ts";
import type { ControllerTransactions } from "./controller-transactions.ts";
import { isManagedTokenServiceSource } from "./credential-source-metadata.ts";
import {
  AgentDeletingError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  NoActiveAgentRevisionError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "./errors.ts";
import { lockNamespace, namespaceIdentity } from "./resource-scope.ts";

export type AgentCredentialPushResult = PushAgentCredentialsResponse["data"]["results"][number];

export interface PushAgentCredentialsInput {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly sources: PushAgentCredentialsBody["sources"];
}

export interface AgentCredentialPushAudit {
  readonly started: () => AuditEvent;
  readonly empty: () => AuditEvent;
  readonly result: (result: AgentCredentialPushResult) => AuditEvent;
}

interface RetryDependencies {
  readonly transactions: Pick<ControllerTransactions, "transact" | "requireIndependentMutation">;
  readonly authority: Pick<
    ControllerAuthority,
    "authorize" | "authorizeAgentPrincipal" | "holdAuthority"
  >;
  readonly proxy: () => CredentialProxyDriver;
  readonly tokenService: (instanceId: string) => TokenServiceDriver;
  readonly timeoutMs: number;
}

interface SelectedSource {
  readonly sourceRef: CredentialSourceReference;
  readonly tokenServiceInstanceId: string;
}

export function createAgentCredentialRetry(dependencies: RetryDependencies) {
  async function pushAgentCredentials(
    principalId: string,
    input: PushAgentCredentialsInput,
    audit: AgentCredentialPushAudit,
  ): Promise<readonly AgentCredentialPushResult[]> {
    dependencies.transactions.requireIndependentMutation("Agent credential delivery retry");
    namespaceIdentity(input.namespaceId);
    if (!isNonEmptyString(input.agentId)) {
      throw new ScopeViolationError("The exact Agent identity is missing.");
    }

    const { sources, proxyDriverId } = await dependencies.transactions.transact(async (state) => {
      await dependencies.authority.holdAuthority(state);
      await dependencies.authority.authorize(principalId, "operate", {
        kind: "agent",
        id: input.agentId,
        namespaceId: input.namespaceId,
      });
      const namespace = await lockNamespace(state, input.namespaceId);
      if (namespace.status !== "ready") {
        throw new NamespaceNotReadyError();
      }
      const agent = await state.agents.lockAgent(namespace.id, input.agentId);
      if (agent === undefined) {
        throw new ScopeViolationError("The Agent does not belong to the exact Namespace.");
      }
      if (agent.status !== "active") {
        throw new AgentDeletingError();
      }
      if (!isNonEmptyString(agent.activeRevisionId)) {
        throw new NoActiveAgentRevisionError(agent.desiredRuntimeState !== "running");
      }
      if (agent.desiredRuntimeState !== "running") {
        throw new ResourceStateConflictError("The Agent is stopping or stopped.");
      }
      const revision = await state.revisions.findRevision(
        namespace.id,
        agent.id,
        agent.activeRevisionId,
      );
      if (revision === undefined) {
        throw new DependencyUnavailableError("The active Agent revision is unavailable.");
      }
      const deployment = revision.credentialDeployment;
      const withdrawn = new Set(
        (await state.credentialSources.listCredentialWithdrawals(namespace.id, revision.id)).map(
          ({ credentialSourceId }) => credentialSourceId,
        ),
      );
      const eligible = new Map<string, CredentialSourceReference>();
      for (const { sourceRef } of deployment?.bindings ?? []) {
        if (sourceRef.namespaceId === namespace.id && !withdrawn.has(sourceRef.id)) {
          eligible.set(sourceRef.id, sourceRef);
        }
      }
      const ids = input.sources === "all" ? [...eligible.keys()] : input.sources;
      const selected: SelectedSource[] = [];
      for (const id of ids) {
        const sourceRef = eligible.get(id);
        if (sourceRef === undefined) {
          throw new ResourceStateConflictError(
            "The selected source has no effective Credential Proxy binding in the deployed Agent revision.",
          );
        }
        await dependencies.authority.authorize(principalId, "update", sourceRef);
        await dependencies.authority.authorizeAgentPrincipal(
          principalId,
          agent,
          "operate",
          sourceRef,
        );
        const source = await state.credentialSources.lockCredentialSource(namespace.id, id);
        if (
          !isManagedTokenServiceSource(source) ||
          source.state !== "ready" ||
          !credentialSourceMatchesSnapshot(source, revisionCredentialSourceSnapshot(revision, id))
        ) {
          throw new ResourceStateConflictError(
            "The deployed credential source is unavailable or has changed owner.",
          );
        }
        selected.push({ sourceRef, tokenServiceInstanceId: source.tokenServiceInstanceId });
      }
      // External delivery cannot roll back with PostgreSQL. Record the authorized attempt before it starts.
      await state.audit.append(selected.length === 0 ? audit.empty() : audit.started());
      return { sources: selected, proxyDriverId: deployment?.proxyDriverId };
    });

    const results: AgentCredentialPushResult[] = [];
    for (const source of sources) {
      let outcome: AgentCredentialPushResult["outcome"] = "succeeded";
      let resolutionFailed = false;
      try {
        const proxy = dependencies.proxy();
        if (proxy.id !== proxyDriverId || proxy.notifyCredentialUpdated === undefined) {
          throw new DependencyUnavailableError(
            "The deployed Credential Proxy cannot retry delivery.",
          );
        }
        const signal = AbortSignal.timeout(dependencies.timeoutMs);
        await proxy.notifyCredentialUpdated(
          { sourceRef: source.sourceRef },
          async () => {
            try {
              return await dependencies
                .tokenService(source.tokenServiceInstanceId)
                .resolveCredential(
                  {
                    sourceRef: source.sourceRef,
                    tokenServiceInstanceId: source.tokenServiceInstanceId,
                  },
                  signal,
                );
            } catch (error) {
              resolutionFailed = true;
              throw error;
            }
          },
          signal,
        );
        if (resolutionFailed) {
          outcome = "resolution_failed";
        }
      } catch {
        outcome = resolutionFailed ? "resolution_failed" : "delivery_failed";
      }
      const result: AgentCredentialPushResult = { sourceId: source.sourceRef.id, outcome };
      await dependencies.transactions.transact((state) => state.audit.append(audit.result(result)));
      results.push(result);
    }
    return results;
  }

  return { pushAgentCredentials };
}
