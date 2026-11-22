import {
  isSecretHarnessAuth,
  isServiceAccountHarnessAuth,
  type Agent,
  type AgentCallerPermissionsResponse,
  type NamespaceCallerPermissionsResponse,
  type PermissionAction,
  type ResourceRef,
} from "@openclaw-enterprise/contracts";
import type { OpenClawController } from "@openclaw-enterprise/occ";
import type { Static } from "typebox";

interface PermissionAdviceContext {
  readonly controller: OpenClawController;
  readonly actorId: string;
  readonly namespaceId: string;
  readonly callerMay: (
    actorId: string,
    action: PermissionAction,
    resource: ResourceRef,
  ) => Promise<boolean>;
}

type AgentPermissionAdviceContext = PermissionAdviceContext & {
  readonly agentId: string;
};

/**
 * The grants each Agent update checks on the sources the Agent binds now, besides its
 * Configuration's Secret bindings (`updateAgent`, finding 2441): operate on each listed
 * credential source and on a Secret or credential source Harness authentication, read on a
 * ServiceAccount one.
 */
function agentBoundSourceGrants(
  namespaceId: string,
  agent: Pick<Agent, "harnessAuth" | "credentialSources">,
): [PermissionAction, ResourceRef][] {
  const grants: [PermissionAction, ResourceRef][] = (agent.credentialSources ?? []).map(
    ({ sourceId }) => ["operate", { kind: "credential_source", namespaceId, id: sourceId }],
  );
  const harnessAuth = agent.harnessAuth;
  if (harnessAuth?.method === "credential_source") {
    grants.push(["operate", { kind: "credential_source", namespaceId, id: harnessAuth.sourceId }]);
  } else if (isSecretHarnessAuth(harnessAuth)) {
    grants.push(["operate", { kind: "secret", namespaceId, id: harnessAuth.source.id }]);
  } else if (isServiceAccountHarnessAuth(harnessAuth)) {
    grants.push(["read", { kind: "service_account", namespaceId, id: harnessAuth.source.id }]);
  }
  return grants;
}

async function getNamespaceCallerPermissions({
  controller,
  actorId,
  namespaceId,
  installationId,
  callerMay,
}: PermissionAdviceContext & { readonly installationId: string }): Promise<
  Static<typeof NamespaceCallerPermissionsResponse>["data"]
> {
  await controller.getNamespace(actorId, namespaceId);
  // Targets match Namespace deletion, operationTarget() for creation, and
  // requireInstallationAdmin. The console reads this answer
  // instead of an Installation-only read, which the API audits when it is refused.
  const [namespaceDelete, agentCreate, secretCreate, installationAdminister] = await Promise.all([
    callerMay(actorId, "delete", { kind: "namespace", id: namespaceId, namespaceId }),
    callerMay(actorId, "create", { kind: "agent", id: namespaceId, namespaceId }),
    callerMay(actorId, "create", { kind: "secret", id: namespaceId, namespaceId }),
    callerMay(actorId, "administer", { kind: "installation", id: installationId }),
  ]);
  return {
    delete: namespaceDelete,
    agents: { create: agentCreate },
    secrets: { create: secretCreate },
    installation: { administer: installationAdminister },
  };
}

async function getNamespaceSecretPermissions({
  controller,
  actorId,
  namespaceId,
  callerMay,
}: PermissionAdviceContext): Promise<{ readonly operateDenied: readonly string[] }> {
  // Namespace read, checked and audited as the Namespace permission answer checks it
  // (finding 2478), so listing the Secrets below is never a refused, audited read.
  await controller.getNamespace(actorId, namespaceId);
  // Agent create authorizes Secret operate on its Harness authentication source and on its
  // Configuration's Secret bindings, and a directory search before it needs the same two
  // grants (finding 2469). Only a caller who may create an Agent here gets an answer, so it
  // reports nothing such a request would not, and only on the Secrets the caller may list.
  // The target matches operationTarget() for createAgent.
  const operateDenied = (await callerMay(actorId, "create", {
    kind: "agent",
    id: namespaceId,
    namespaceId,
  }))
    ? await controller.listSecretsOperateDenied(actorId, namespaceId)
    : [];
  return { operateDenied };
}

async function getAgentCallerPermissions({
  controller,
  actorId,
  namespaceId,
  agentId,
  callerMay,
  callerDecision,
}: AgentPermissionAdviceContext & {
  readonly callerDecision: (
    actorId: string,
    action: PermissionAction,
    resource: ResourceRef,
  ) => Promise<{ allowed: boolean; restricted: boolean }>;
}): Promise<Static<typeof AgentCallerPermissionsResponse>["data"]> {
  // Route authorization already required Agent read; the read also proves the Agent
  // exists before the mutating actions are probed.
  const agent = await controller.getAgentForBrowsing(actorId, namespaceId, agentId);
  const target: ResourceRef = { kind: "agent", id: agentId, namespaceId };
  // The Agent read names its Configuration, so its update bit discloses nothing new.
  const configuration: ResourceRef = {
    kind: "configuration",
    id: agent.configurationId,
    namespaceId,
  };
  // The Agent's network policy and its suggestions authorize read on the Agent's own
  // sandbox_policy resource, which no other answer covers; the console skips both reads
  // for a caller without it (finding 2454).
  const sandboxPolicy: ResourceRef = {
    kind: "sandbox_policy",
    id: `sbp_${agentId.slice(4)}`,
    namespaceId,
  };
  const [
    [
      update,
      deploy,
      operate,
      remove,
      // Native admin UI access authorizes Agent administer on the exact Agent, so the console
      // skips its audited probe for a caller without it.
      administer,
      configurationUpdate,
      configurationRead,
      sandboxPolicyRead,
    ],
    readLogsDecision,
  ] = await Promise.all([
    Promise.all([
      callerMay(actorId, "update", target),
      callerMay(actorId, "deploy", target),
      callerMay(actorId, "operate", target),
      callerMay(actorId, "delete", target),
      callerMay(actorId, "administer", target),
      callerMay(actorId, "update", configuration),
      callerMay(actorId, "read", configuration),
      callerMay(actorId, "read", sandboxPolicy),
    ]),
    callerDecision(actorId, "read_logs", target),
  ]);
  // Log text authorizes Agent read_logs or, without a Restriction on read_logs, Agent
  // administer in its place, as the runtime log read decides it. The console skips that
  // audited read for a caller without either (finding D758).
  const readLogs = readLogsDecision.allowed || (!readLogsDecision.restricted && administer);
  // One IAM call per distinct grant, shared by the answers below. A Secret bound to several
  // names is one decision.
  const decisions = new Map<string, Promise<boolean>>();
  const decide = (action: PermissionAction, resource: ResourceRef) => {
    const key = JSON.stringify([action, resource.kind, resource.namespaceId, resource.id]);
    let decision = decisions.get(key);
    if (decision === undefined) {
      decision = callerMay(actorId, action, resource);
      decisions.set(key, decision);
    }
    return decision;
  };
  const callerMayAll = async (grants: readonly [PermissionAction, ResourceRef][]) =>
    (await Promise.all(grants.map(([action, resource]) => decide(action, resource)))).every(
      Boolean,
    );
  // Each Configuration save authorizes Secret operate on every Secret it binds, so
  // Configuration update alone does not say a save can succeed (finding 2437); each Agent
  // update checks them too (finding 2441). Only a caller who may read the Configuration and
  // update it or the Agent gets an answer: the bindings are visible to them, and a save
  // would report the same decision.
  const boundSecrets: [string, ResourceRef][] =
    configurationRead && (configurationUpdate || update)
      ? Object.entries(
          await controller.getConfigurationSecretBindingSources(
            actorId,
            namespaceId,
            agent.configurationId,
          ),
        )
      : [];
  const bindingGrants = boundSecrets.map(([, source]): [PermissionAction, ResourceRef] => [
    "operate",
    source,
  ]);
  // A save that submits bindings is checked only on those, so one that rebinds each name
  // listed here to a Secret the caller may operate needs nothing on the Secrets they bind
  // now (finding 2444). Names only: the caller reads them on the Configuration already.
  const configurationSecretsOperateDeniedBindings =
    configurationUpdate && configurationRead
      ? (
          await Promise.all(
            boundSecrets.map(async ([name, source]) =>
              (await decide("operate", source)) ? [] : [name],
            ),
          )
        )
          .flat()
          .sort()
      : [];
  const configurationSecretsOperate =
    configurationUpdate &&
    configurationRead &&
    configurationSecretsOperateDeniedBindings.length === 0;
  // An Agent update needs Configuration read and checks the sources the Agent binds now,
  // which the Agent read shows. Unreadable saved settings leave it unanswered.
  const agentSourcesOperate =
    update &&
    configurationRead &&
    !("configurationReadError" in agent) &&
    (await callerMayAll([...bindingGrants, ...agentBoundSourceGrants(namespaceId, agent)]));
  return {
    update,
    deploy,
    operate,
    delete: remove,
    administer,
    configurationUpdate,
    configurationRead,
    configurationSecretsOperate,
    configurationSecretsOperateDeniedBindings,
    agentSourcesOperate,
    sandboxPolicyRead,
    readLogs,
  };
}

async function getAgentSecretPermissions({
  controller,
  actorId,
  namespaceId,
  agentId,
  callerMay,
}: AgentPermissionAdviceContext): Promise<{
  readonly operateDenied: readonly string[];
  readonly unreadableOperateDenied: number;
}> {
  // Route authorization already required Agent read, and the read proves the Agent exists.
  const agent = await controller.getAgentForBrowsing(actorId, namespaceId, agentId);
  const configuration: ResourceRef = {
    kind: "configuration",
    id: agent.configurationId,
    namespaceId,
  };
  const agentRef: ResourceRef = { kind: "agent", id: agentId, namespaceId };
  const [update, deploy, configurationUpdate, configurationRead, namespaceRead] = await Promise.all(
    [
      callerMay(actorId, "update", agentRef),
      callerMay(actorId, "deploy", agentRef),
      callerMay(actorId, "update", configuration),
      callerMay(actorId, "read", configuration),
      // Checked first, so listing the Secrets below is never a refused, audited read.
      callerMay(actorId, "read", { kind: "namespace", id: namespaceId, namespaceId }),
    ],
  );
  // Binding a Secret to the Agent's Configuration, or as its Harness authentication source,
  // authorizes Secret operate on it (finding 2453), and so does deploying a draft that binds
  // it (finding 2546). Only a caller who may make such a save or deployment gets an answer,
  // so it reports nothing that request would not, and only on the Secrets the caller may
  // list.
  const mayBind = configurationUpdate || update;
  const reported = namespaceRead && configurationRead && (mayBind || deploy);
  // A deployment checks only the Secrets the draft binds now: its Configuration's Secret
  // bindings and a Secret Harness authentication source.
  const bound = new Set<string>();
  if (reported) {
    for (const source of Object.values(
      await controller.getConfigurationSecretBindingSources(
        actorId,
        namespaceId,
        agent.configurationId,
      ),
    )) {
      if (source.kind === "secret" && source.namespaceId === namespaceId) {
        bound.add(source.id);
      }
    }
    // Unreadable saved settings hide the Agent's sources, so the answer leaves them out.
    if (
      !("configurationReadError" in agent) &&
      isSecretHarnessAuth(agent.harnessAuth) &&
      agent.harnessAuth.source.namespaceId === namespaceId
    ) {
      bound.add(agent.harnessAuth.source.id);
    }
  }
  // One Secret scan answers both: the listed Secrets the caller may read but not operate, and
  // how many bound ones it may neither read nor operate, a count, never their IDs, so a
  // console can hold Deploy without naming them (finding D756).
  const { readable: listed, unreadableCount: unreadableOperateDenied } = reported
    ? await controller.secretsOperateDenied(actorId, namespaceId, bound)
    : { readable: [], unreadableCount: 0 };
  // A caller who may deploy but bind nothing learns only those, which the Agent and
  // Configuration reads already name (finding 2565).
  const operateDenied = mayBind ? listed : listed.filter((id) => bound.has(id));
  return { operateDenied, unreadableOperateDenied };
}

export const permissionAdvice = {
  getNamespaceCallerPermissions,
  getNamespaceSecretPermissions,
  getAgentCallerPermissions,
  getAgentSecretPermissions,
};
