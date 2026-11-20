import assert from "node:assert/strict";

import type {
  Agent,
  AuthorizationRequest,
  Permission,
  Principal,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import {
  IAMAccessBindingListResponse,
  IAMAccessBindingResponse,
  IAMRoleListResponse,
  IAMRoleResponse,
  NamespaceResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { AuthPrincipalSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import type { createFixtureResponse } from "./console-fixture-response.ts";
import { bindRole, grantRole, type principalIAMState } from "./iam-grants.ts";

type MutablePolicy = Omit<ReturnType<typeof principalIAMState>, "roles"> & {
  roles: ReturnType<typeof grantRole>["role"][];
};
type Grant = readonly [Permission["action"], Permission["resourceKind"]];
type GrantAgent = Pick<Agent, "id" | "namespaceId" | "servicePrincipalId">;
type GrantSecret = Pick<SecretReference, "id">;
type GrantOptions = { listed?: boolean | undefined; modelGrant?: boolean | undefined };
type FixtureRequest = (
  method: "GET" | "POST",
  path: string,
  options?: { body?: unknown },
) => Promise<{ status: number; body: unknown }>;
type PolicyDependencies<Account> = {
  policy: MutablePolicy;
  principalId: string;
  request: FixtureRequest;
  fixtureResponse: ReturnType<typeof createFixtureResponse>;
  getController: () => OpenClawController | undefined;
  iamDriver: NativeIAMDriver;
  createAccountWithPolicy: (
    label: string,
    configurePolicy: (principal: Principal) => void,
  ) => Promise<Account>;
};

export function createConsoleFixturePolicy(seed: AuthPrincipalSeed): MutablePolicy {
  return {
    identities: [seed.principal],
    groups: [],
    memberships: [],
    roles: seed.roles.map((role) => ({
      ...role,
      permissions: role.permissions.map((item) => ({ ...item })),
    })),
    bindings: seed.bindings.map((binding) => ({ ...binding })),
    restrictions: [],
  };
}

export function createConsoleFixturePolicyHelpers<Account>({
  policy,
  principalId,
  request,
  fixtureResponse,
  getController,
  iamDriver,
  createAccountWithPolicy,
}: PolicyDependencies<Account>) {
  // The listed bindings createAgent adds for each Agent's model credential (finding 2260).
  const modelGrantBindingIds = new Set<string>();

  async function createNamespace(name: string, { ready = false }: { ready?: boolean } = {}) {
    const result = await request("POST", "/namespaces", { body: { name } });
    const namespace = fixtureResponse(result, 201, NamespaceResponse, "create Namespace").data;
    if (ready) {
      await makeNamespaceReady(namespace.id);
      const current = await request("GET", `/namespaces/${namespace.id}`);
      return fixtureResponse(current, 200, NamespaceResponse, "read ready Namespace").data;
    }
    return namespace;
  }

  async function makeNamespaceReady(namespaceId: string) {
    const controller = getController();
    assert.ok(controller, "bootstrap must create the controller before Namespace lifecycle runs");
    const updated = await controller.handleNamespaceLifecycle(principalId, namespaceId, "ready");
    assert.equal(updated?.status, "ready");
    return updated;
  }

  // Grants the Agent operate on one Secret, as an Installation administrator's console does. The
  // Agent's service principal and its role are added on the first grant; a repeat changes nothing.
  // The evaluator reads this fixture policy, while the Namespace's IAM API lists only what it
  // stored, so a `listed` grant is also written through that API: the console's policy reads
  // then see it, as they see a production grant (finding 1920).
  async function grantAgentSecretOperate(
    agent: GrantAgent,
    source: GrantSecret,
    { listed = true, modelGrant = false }: GrantOptions = {},
  ): Promise<void> {
    const roleId = `auth-${agent.id}`;
    const bindingId = `${roleId}-${source.id}`;
    if (policy.bindings.some((binding) => binding.id === bindingId)) {
      return;
    }
    if (!policy.identities.some((identity) => identity.id === agent.servicePrincipalId)) {
      policy.identities.push({
        id: agent.servicePrincipalId,
        kind: "service_principal",
        namespaceId: agent.namespaceId,
        agentId: agent.id,
      });
    }
    if (!policy.roles.some((role) => role.id === roleId)) {
      policy.roles.push({
        id: roleId,
        namespaceId: agent.namespaceId,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      });
    }
    bindRole(policy, agent.servicePrincipalId, {
      id: bindingId,
      namespaceId: agent.namespaceId,
      roleId,
      resource: { kind: "secret", id: source.id },
    });
    if (listed) {
      const binding = await listSecretOperate(agent, source);
      if (modelGrant) {
        modelGrantBindingIds.add(binding.id);
      }
    }
  }

  // The Namespace's listed access bindings, without the model-credential grants createAgent
  // lists: what the console or the test itself granted since.
  async function addedAccessBindings(namespaceId: string) {
    const result = await request("GET", `/namespaces/${namespaceId}/iam/access-bindings`);
    const bindings = fixtureResponse(
      result,
      200,
      IAMAccessBindingListResponse,
      "list Namespace access bindings",
    ).data;
    return bindings.filter(({ id }) => !modelGrantBindingIds.has(id));
  }

  async function listSecretOperate(agent: GrantAgent, source: GrantSecret) {
    const iamPath = `/namespaces/${agent.namespaceId}/iam`;
    const permissions: Permission[] = [{ action: "operate", resourceKind: "secret" }];
    const result = await request("GET", `${iamPath}/roles`);
    const roles = fixtureResponse(result, 200, IAMRoleListResponse, "list Namespace Roles").data;
    let listedRole = roles.find(({ name }) => name === "Fixture Agent Secret operate");
    if (!listedRole) {
      const created = await request("POST", `${iamPath}/roles`, {
        body: { name: "Fixture Agent Secret operate", permissions },
      });
      listedRole = fixtureResponse(
        created,
        201,
        IAMRoleResponse,
        "create Secret operate Role",
      ).data;
    }
    const binding = await request("POST", `${iamPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: listedRole.id,
        resourceKind: "secret",
        resourceId: source.id,
      },
    });
    return fixtureResponse(binding, 201, IAMAccessBindingResponse, "create Secret operate binding")
      .data;
  }

  // Runs the callback while the real IAM Driver throws on the selected authorization decisions.
  async function withIamOutage<T>(
    failing: (request: AuthorizationRequest) => boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    const authorize = iamDriver.authorize;
    iamDriver.authorize = async (request) => {
      if (failing(request)) {
        throw new Error("IAM outage");
      }
      return authorize.call(iamDriver, request);
    };
    try {
      return await run();
    } finally {
      iamDriver.authorize = authorize;
    }
  }

  // A Namespace member has exactly these grants and no Installation access.
  function createNamespaceMember(label: string, namespaceId: string, grants: readonly Grant[]) {
    return createAccountWithPolicy(label, (principal) => {
      grantRole(policy, principal.id, {
        id: `role-${label}`,
        bindingId: `binding-${label}`,
        namespaceId,
        permissions: grants.map(([action, resourceKind]) => ({ action, resourceKind })),
      });
    });
  }

  return {
    createNamespace,
    grantAgentSecretOperate,
    addedAccessBindings,
    withIamOutage,
    createNamespaceMember,
  };
}

// Tests change a member's Role in place after sign-in; State reads the policy on each request.
export function memberRole(fixture: { policy: Pick<MutablePolicy, "roles"> }, label: string) {
  const role = fixture.policy.roles.find(({ id }) => id === `role-${label}`);
  assert.ok(role, `member ${label} has a Role`);
  return role;
}

export function grantMember(
  fixture: { policy: Pick<MutablePolicy, "roles"> },
  label: string,
  grants: readonly Grant[],
) {
  memberRole(fixture, label).permissions.push(
    ...grants.map(([action, resourceKind]) => ({ action, resourceKind })),
  );
}
