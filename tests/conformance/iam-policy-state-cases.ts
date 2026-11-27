import assert from "node:assert/strict";
import test from "node:test";
import type { AuthorizationRequest } from "../../packages/contracts/src/index.ts";
import {
  evaluateAuthorization,
  NativeIAMDriver,
  type NativeIAMState,
} from "../../packages/iam/src/index.ts";
import { agentResource } from "./iam-case-fixture.ts";

function readerRequest(): AuthorizationRequest {
  return {
    principalId: "principal-reader-a",
    action: "read",
    resource: agentResource("agent-a"),
  };
}

export function registerPolicyStateCases(state: NativeIAMState): void {
  test("invalid loaded IAM state fails closed", async () => {
    const { roles, bindings, memberships, identities } = state;
    const [role] = roles;
    const [binding] = bindings;
    const [membership] = memberships;
    const [identity] = identities;
    assert.ok(role && binding && membership && identity);
    const invalidStates = {
      "missing groups": { groups: undefined },
      "duplicate role ID": { roles: [...roles, { ...role, permissions: [] }] },
      "binding without subject kind": { bindings: [{ ...binding, subjectKind: undefined }] },
      "binding to unknown role": { bindings: [{ ...binding, roleId: "role-unknown" }] },
      "membership in another namespace": {
        memberships: [{ ...membership, namespaceId: "namespace-b" }],
      },
      // An Installation Group may be bound in a Namespace (RFC-0026 Default users); a Namespace
      // Group bound in another Namespace still fails closed.
      "namespace group bound in another namespace": {
        bindings: [
          {
            ...binding,
            subjectKind: "group",
            subjectId: "group-readers-a",
            namespaceId: "namespace-b",
            roleId: "role-reader-b",
            resourceKind: undefined,
            resourceId: undefined,
          },
        ],
      },
      "restriction with allow effect": {
        restrictions: [
          {
            id: "restriction-invalid",
            action: "read",
            resourceKind: "agent",
            effect: "allow",
          },
        ],
      },
      "installation restriction scoped to a namespace": {
        restrictions: [
          {
            id: "restriction-installation-inside-namespace",
            namespaceId: "namespace-a",
            action: "read",
            resourceKind: "installation",
            effect: "deny",
          },
        ],
      },
      "namespace restriction targeting another namespace": {
        restrictions: [
          {
            id: "restriction-cross-namespace",
            namespaceId: "namespace-a",
            action: "read",
            resourceKind: "namespace",
            resourceId: "namespace-b",
            effect: "deny",
          },
        ],
      },
      "duplicate external identity": {
        identities: [identity, { ...identity, id: "principal-duplicate-external" }],
      },
      "identity with legacy installation ID": {
        identities: [{ ...identity, installationId: "installation-legacy" }],
      },
      "legacy workload identity": {
        identities: [
          ...identities,
          {
            id: "workload-agent-legacy",
            kind: "workload_identity",
            namespaceId: "namespace-a",
            agentId: "agent-legacy",
          },
        ],
      },
      "service principal agent ID without namespace": {
        identities: [
          ...identities,
          { id: "service-principal-unscoped-agent", kind: "service_principal", agentId: "agent-b" },
        ],
      },
      "empty service principal agent ID": {
        identities: [
          ...identities,
          {
            id: "service-principal-empty-agent",
            kind: "service_principal",
            namespaceId: "namespace-a",
            agentId: "",
          },
        ],
      },
      "duplicate service principal agent": {
        identities: [
          ...identities,
          {
            id: "service-principal-duplicate-agent",
            kind: "service_principal",
            namespaceId: "namespace-a",
            agentId: "agent-a",
          },
        ],
      },
    };

    for (const [label, overlay] of Object.entries(invalidStates)) {
      // Neither the loader nor the test validates or repairs these inputs before IAM sees them.
      const invalidState = { ...state, ...overlay } as NativeIAMState;
      const driver = new NativeIAMDriver({ loadNativeIAMState: async () => invalidState });
      assert.equal(
        await driver.lookupIdentity({
          issuer: "https://identity.example.com",
          subject: "reader-a",
        }),
        undefined,
        `${label}: Driver identity lookup`,
      );

      const decision = await driver.authorize(readerRequest());
      assert.equal(decision.allowed, false, `${label}: Driver must deny`);
      assert.match(decision.reason, /policy is invalid/, `${label}: Driver denial reason`);

      const evaluated = evaluateAuthorization(readerRequest(), invalidState);
      assert.equal(evaluated.allowed, false, `${label}: direct evaluator must deny`);
      assert.match(
        evaluated.reason,
        /policy is invalid/,
        `${label}: direct evaluator denial reason`,
      );
    }
  });

  test("the Driver uses current IAM state for every lookup and authorization", async () => {
    const snapshot = structuredClone(state);
    const mutable = {
      ...snapshot,
      roles: snapshot.roles.map((role) => ({ ...role, permissions: [...role.permissions] })),
      bindings: snapshot.bindings.map((binding) => ({ ...binding })),
      identities: snapshot.identities.map((identity) => ({ ...identity })),
    };
    const driver = new NativeIAMDriver({ loadNativeIAMState: async () => mutable });
    const request = readerRequest();
    const identity = { issuer: "https://identity.example.com", subject: "reader-a" };

    assert.equal((await driver.authorize(request)).allowed, true);
    assert.equal((await driver.lookupIdentity(identity))?.id, "principal-reader-a");

    // A replacement Role with the same ID must take effect on the next decision.
    const [readerRole] = mutable.roles;
    const [firstBinding] = mutable.bindings;
    const [firstIdentity] = mutable.identities;
    assert.ok(readerRole && firstBinding && firstIdentity?.kind === "principal");
    mutable.roles[0] = { ...readerRole, permissions: [] };
    const revoked = await driver.authorize(request);
    assert.equal(revoked.allowed, false);
    assert.deepEqual(revoked.evidence.roleIds, []);
    mutable.roles[0] = readerRole;
    assert.equal((await driver.authorize(request)).allowed, true);

    readerRole.permissions.length = 0;
    firstBinding.subjectId = "principal-unbound";
    firstIdentity.subject = "changed-after-construction";

    assert.equal((await driver.authorize(request)).allowed, false);
    assert.equal(await driver.lookupIdentity(identity), undefined);
    assert.equal(
      (
        await driver.lookupIdentity({
          issuer: "https://identity.example.com",
          subject: "changed-after-construction",
        })
      )?.id,
      "principal-reader-a",
    );
  });

  test("platform state failures surface as dependency failures", async () => {
    const driver = new NativeIAMDriver({
      async loadNativeIAMState() {
        throw new Error("state unavailable");
      },
    });

    await assert.rejects(
      () =>
        driver.lookupIdentity({
          issuer: "https://identity.example.com",
          subject: "reader-a",
        }),
      /state unavailable/,
    );
    await assert.rejects(() => driver.authorize(readerRequest()), /state unavailable/);
  });
}
