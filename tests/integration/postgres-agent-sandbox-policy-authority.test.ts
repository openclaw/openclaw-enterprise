import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import type { Pool } from "pg";

import { createPostgresAuthAccountProvisioner } from "../../apps/controller/src/auth/index.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import type { SandboxNetworkGrant, SandboxPolicy } from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";
import { openShellWorkspaceProtocol } from "../helpers/openshell-workspace-protocol.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

interface HTTPResult {
  readonly status: number;
  readonly data?: unknown;
  readonly error?: unknown;
}

type Request = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: object,
) => Promise<HTTPResult>;

async function data<T>(response: Promise<HTTPResult>, status: number): Promise<T> {
  const result = await response;
  assert.equal(result.status, status, JSON.stringify(result.error));
  assert.ok(result.data !== undefined);
  return result.data as T;
}

async function waitForNamespaceLock(pool: Pool, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND $1::int = ANY(pg_blocking_pids(pid))
         AND query LIKE '%FROM occ.namespaces%' AND query LIKE '%FOR UPDATE%'`,
      [blockerPid],
    );
    assert.ok(result.rows.length <= 1, "ambiguous Namespace lock waiter");
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) {
      return pid;
    }
    await setTimeout(20);
  } while (Date.now() < deadline);
  assert.fail(`no Namespace lock waiter blocked by PostgreSQL session ${blockerPid}`);
}

async function policyAuthorityApp(t: test.TestContext) {
  const grant: SandboxNetworkGrant = {
    id: "python-service",
    binary: "/usr/bin/python3.11",
    host: "example.org",
    ports: [{ from: 443, to: 443 }],
  };
  // Use the production policy compiler. This fixture covers admission and persistence;
  // the OpenShell runtime lane owns provider enforcement.
  const sandboxDriver = new OpenShellSandboxDriver(
    {
      gateway: {},
      kubernetes: {
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "python-default",
            binaries: [{ path: grant.binary }],
            endpoints: [{ host: "example.com", ports: [443], tls: "skip" }],
          },
        ],
      },
    },
    {
      id: "policy-authority-openshell",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: {
          sandbox: "policy-authority-openshell",
          credential_gateway: "policy-authority-credentials",
        },
        client: new OpenShellGateway(
          { serviceName: "openshell-gateway" },
          { gatewayClient: completeOpenShellGatewayClient(openShellWorkspaceProtocol()) },
        ),
      },
    },
  );
  type ProvisionAccount = NonNullable<ControllerAppOptions["provisionAuthAccount"]>;
  const accounts: { provision?: ProvisionAccount } = {};
  const fixture = await createPostgresAgentApp(t, {
    label: "sandbox-policy-authority",
    authSecret: "sandbox-policy-authority-postgres-session-secret",
    sandboxDriver,
    controllerOptions: {
      sandboxNetworkPolicyCeiling: [grant],
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: sandboxDriver.id,
          implementation: sandboxDriver.implementation,
          definition: OpenShellSandboxDriver,
        },
      ],
    },
    appOptions: {
      provisionAuthAccount: ((...args) => accounts.provision!(...args)) satisfies ProvisionAccount,
    },
  });
  accounts.provision = createPostgresAuthAccountProvisioner({
    state: fixture.state,
    installationId: fixture.controller.installation.id,
  });
  const endpoint = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
  async function authenticatedRequest(credentials: { email: string; password: string }) {
    const session = await signInToControllerApp(fixture.app, credentials);
    const request: Request = async (method, path, body) => {
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: {
          ...authenticatedHeaders(session),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      return {
        ...(response.status === 204 ? {} : ((await response.json()) as Omit<HTTPResult, "status">)),
        status: response.status,
      };
    };
    return request;
  }
  const admin = await authenticatedRequest(fixture.adminAccount);
  async function account(label: string) {
    const credentials = {
      email: `policy-${label}-${randomUUID()}@example.test`,
      password: `generated-password-${randomUUID()}`,
    };
    // The supported account endpoint creates a real human Principal with no grants.
    const created = await data<{ id: string }>(
      admin("POST", "/api/auth/accounts", credentials),
      201,
    );
    const identity = (await fixture.state.loadNativeIAMState()).identities.find(
      (candidate) => candidate.kind === "principal" && candidate.subject === created.id,
    );
    assert.ok(identity);
    const request = await authenticatedRequest(credentials);
    return { principalId: identity.id, request };
  }
  return {
    ...fixture,
    grant,
    admin,
    editor: await account("editor"),
    otherEditor: await account("other-editor"),
  };
}

interface PolicyAudit {
  readonly id: string;
  readonly actor_id: string;
  readonly details: { readonly policyVersion: number };
}

test(
  "Agent policy saves order exact grant withdrawal with the owning Namespace lock",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
    const { pool, state, deployAgent, grant, admin, editor, otherEditor } =
      await policyAuthorityApp(t);

    for (const permission of [
      { action: "manage_policy", resourceKind: "agent" },
      { action: "update", resourceKind: "sandbox_policy" },
    ] as const) {
      for (const ordering of ["withdrawal first", "save first"] as const) {
        await t.test(`${permission.resourceKind}: ${ordering}`, async () => {
          const { namespace, agent } = await deployAgent(`Policy ${permission.resourceKind}`);
          const namespacePath = `/namespaces/${namespace.id}`;
          const policyPath = `${namespacePath}/agents/${agent.id}/sandbox-policy/networking`;
          const bindingPath = `${namespacePath}/iam/access-bindings`;
          await data(admin("PATCH", `${policyPath}/editing`, { enabled: true }), 200);
          const initial = await state.read((unit) =>
            unit.sandboxPolicies.find(namespace.id, agent.id),
          );
          assert.ok(initial);

          const bindings = new Map<string, string>();
          for (const access of [
            { action: "manage_policy", resourceKind: "agent", resourceId: agent.id },
            { action: "update", resourceKind: "sandbox_policy", resourceId: initial.id },
          ] as const) {
            const role = await data<{ id: string }>(
              admin("POST", `${namespacePath}/iam/roles`, {
                permissions: [{ action: access.action, resourceKind: access.resourceKind }],
              }),
              201,
            );
            for (const actor of [editor, otherEditor]) {
              const binding = await data<{ id: string }>(
                admin("POST", bindingPath, {
                  subjectKind: "identity",
                  subjectId: actor.principalId,
                  roleId: role.id,
                  resourceKind: access.resourceKind,
                  resourceId: access.resourceId,
                }),
                201,
              );
              if (actor === editor) {
                bindings.set(access.resourceKind, binding.id);
              }
            }
          }

          // Both human sessions must first succeed through their own exact grants.
          let current = initial;
          for (const actor of [editor, otherEditor]) {
            current = await data<SandboxPolicy>(
              actor.request("PUT", policyPath, { expectedVersion: current.version, additions: [] }),
              200,
            );
          }
          const before = await state.read((unit) =>
            unit.sandboxPolicies.find(namespace.id, agent.id),
          );
          assert.ok(before);
          const audits = async () =>
            (
              await pool.query<PolicyAudit>(
                `SELECT id, actor_id, details FROM occ.audit_events
                 WHERE kind = 'mutation' AND outcome = 'success'
                   AND action = 'openclaw.agents.sandbox_policy.update'
                   AND resource_kind = 'sandbox_policy' AND resource_id = $1 ORDER BY id`,
                [initial.id],
              )
            ).rows;
          const auditBefore = await audits();
          const withdrawn = bindings.get(permission.resourceKind);
          assert.ok(withdrawn);
          const edit = { expectedVersion: before.version, additions: [grant] };

          // Queue the actual IAM DELETE and policy PUT behind one database lock.
          // PostgreSQL's observed wait chain establishes which operation owns it first.
          const blocker = await pool.connect();
          let withdrawal: Promise<HTTPResult> | undefined;
          let save: Promise<HTTPResult> | undefined;
          try {
            await blocker.query("BEGIN");
            const { rows } = await blocker.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid FROM occ.namespaces WHERE id = $1 FOR UPDATE",
              [namespace.id],
            );
            const owner = rows[0];
            assert.ok(owner);
            if (ordering === "withdrawal first") {
              withdrawal = admin("DELETE", `${bindingPath}/${withdrawn}`);
              const first = await waitForNamespaceLock(pool, owner.pid);
              save = editor.request("PUT", policyPath, edit);
              await waitForNamespaceLock(pool, first);
            } else {
              save = editor.request("PUT", policyPath, edit);
              const first = await waitForNamespaceLock(pool, owner.pid);
              withdrawal = admin("DELETE", `${bindingPath}/${withdrawn}`);
              await waitForNamespaceLock(pool, first);
            }
          } finally {
            try {
              await blocker.query("ROLLBACK");
            } finally {
              blocker.release();
              await Promise.allSettled([withdrawal, save]);
            }
          }
          assert.ok(withdrawal !== undefined && save !== undefined);
          assert.equal((await withdrawal).status, 204);
          const raced = await save;
          const persisted = await state.read((unit) =>
            unit.sandboxPolicies.find(namespace.id, agent.id),
          );
          assert.ok(persisted);
          const auditAfter = await audits();
          if (ordering === "withdrawal first") {
            assert.equal(raced.status, 403, "the withdrawn grant must be rechecked under the lock");
            assert.deepEqual(persisted, before, "a refused save must preserve all policy state");
            assert.deepEqual(auditAfter, auditBefore, "a refused save must not append success");
          } else {
            assert.equal(raced.status, 200, JSON.stringify(raced.error));
            assert.equal(persisted.version, before.version + 1);
            assert.deepEqual(persisted.additions, [grant]);
            const ids = new Set(auditBefore.map(({ id }) => id));
            const added = auditAfter.filter(({ id }) => !ids.has(id));
            assert.equal(added.length, 1, "the authorized save must append exactly one success");
            assert.equal(added[0]?.actor_id, editor.principalId);
            assert.equal(added[0]?.details.policyVersion, persisted.version);
          }

          // Withdrawal is effective after either ordering, while another editor's
          // independent grants still permit the same exact resource operation.
          assert.equal(
            (
              await editor.request("PUT", policyPath, {
                expectedVersion: persisted.version,
                additions: [],
              })
            ).status,
            403,
          );
          assert.deepEqual(
            await state.read((unit) => unit.sandboxPolicies.find(namespace.id, agent.id)),
            persisted,
          );
          assert.deepEqual(await audits(), auditAfter);
          const accepted = await data<SandboxPolicy>(
            otherEditor.request("PUT", policyPath, {
              expectedVersion: persisted.version,
              additions: [],
            }),
            200,
          );
          assert.equal(accepted.version, persisted.version + 1);
          assert.deepEqual(accepted.additions, []);
          const finalAudit = await audits();
          const ids = new Set(auditAfter.map(({ id }) => id));
          const added = finalAudit.filter(({ id }) => !ids.has(id));
          assert.equal(added.length, 1);
          assert.equal(added[0]?.actor_id, otherEditor.principalId);
          assert.equal(added[0]?.details.policyVersion, accepted.version);
        });
      }
    }
  },
);
