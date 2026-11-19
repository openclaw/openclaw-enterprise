import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionAction, ResourceKind } from "../../packages/contracts/src/index.ts";
import {
  AgentReadSchema,
  AgentSchema,
  ConfigurationSchema,
  NamespaceSchema,
  NamespaceListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { grantRole } from "../helpers/iam-grants.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { tenantANamespaceId, tenantRequest as request } from "../helpers/tenant-reader-app.ts";
import {
  bootstrap,
  createAgent,
  createConfiguration,
  createFixture,
  createNamespace,
  expectProvisioningDeployRefusal,
  installationId,
  restrictionIds,
  responseData,
  responseError,
} from "./occ-api-security-fixture.ts";

const missingRevisionId = "rev_3dd29693-ce8b-4b4c-97c4-14b4c68c6e9c";
type DenialTarget = readonly [action: PermissionAction, kind: ResourceKind, id?: string];
type RouteProbe = readonly [method: string, suffix: string, denial: DenialTarget, body?: unknown];

export function registerResourceAuthorityCases() {
  test("existing namespace adoption requires installation administration and waits for provisioning", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);

    // Ordinary namespace creation does not authorize claiming an operator-owned Kubernetes namespace.
    grantRole(fixture.state, fixture.tenantAReader.id, {
      id: "role-namespace-creator",
      bindingId: "binding-namespace-creator",
      permissions: { namespace: ["create"] },
    });
    const creator = fixture.createApp(fixture.tenantAReader);
    const managed = await request(creator, "/namespaces", {
      body: { name: "Ordinary tenant" },
    });
    assert.equal(managed.response.status, 201);
    assert.equal(
      Object.hasOwn(responseData(NamespaceSchema, managed.payload), "existingNamespace"),
      false,
    );

    const denied = await request(creator, "/namespaces", {
      body: { name: "Unauthorized adoption", existingNamespace: "operator-owned" },
    });
    assert.equal(denied.response.status, 403);
    assert.equal(responseError(denied.payload).code, "FORBIDDEN");
    const denial = fixture.auditSink.events.at(-1);
    assert.equal(denial?.kind, "authorization_denial");
    assert.equal(denial?.authorization?.action, "administer");
    assert.deepEqual(denial?.authorization?.resource, { kind: "installation", id: installationId });

    // Even an administrator cannot silently adopt through Docker or another unsupported Driver,
    // and the refusal leaves no Namespace behind.
    const namespacesBefore = (await request(fixture.app, "/namespaces")).payload.data;
    const unsupported = await request(fixture.app, "/namespaces", {
      body: { name: "Unsupported adoption", existingNamespace: "operator-owned" },
    });
    assert.equal(unsupported.response.status, 409);
    assert.equal(responseError(unsupported.payload).code, "RESOURCE_CONFLICT");
    assert.deepEqual((await request(fixture.app, "/namespaces")).payload.data, namespacesBefore);

    const kubernetes = createTestKubernetesComputeDriver("compute-security-kubernetes");
    const controller = fixture.controller;
    assert.ok(controller);
    controller.registerDriver(kubernetes);
    controller.selectDriver("compute", kubernetes.id);
    const selected = await request(fixture.app, "/namespaces", {
      body: { name: "Operator-owned tenant", existingNamespace: "operator-owned" },
    });
    assert.equal(selected.response.status, 201);
    const adopted = responseData(NamespaceSchema, selected.payload);
    assert.equal(adopted.existingNamespace, "operator-owned");

    const duplicate = await request(fixture.app, "/namespaces", {
      body: { name: "Duplicate adoption", existingNamespace: "operator-owned" },
    });
    assert.equal(duplicate.response.status, 409);

    // A Kubernetes Namespace name: a DNS label of at most 63 characters.
    for (const [existingNamespace, code] of [
      ["Operator.Owned", "INVALID_FORMAT"],
      ["a".repeat(64), "TOO_LONG"],
      ["operator-", "INVALID_FORMAT"],
      ["-operator", "INVALID_FORMAT"],
    ] as const) {
      const invalid = await request(fixture.app, "/namespaces", {
        body: { name: "Invalid adoption", existingNamespace },
      });
      assert.equal(invalid.response.status, 400, existingNamespace);
      assert.equal(responseError(invalid.payload).code, "INVALID_REQUEST", existingNamespace);
      assert.deepEqual(
        responseError(invalid.payload).details,
        [{ path: "/existingNamespace", code }],
        existingNamespace,
      );
    }

    // Unauthorized callers cannot infer provisioning state or bypass denial auditing.
    const unauthorizedConfiguration = await request(
      creator,
      `/namespaces/${adopted.id}/configurations`,
      { body: { kind: "agent", values: {} } },
    );
    assert.equal(unauthorizedConfiguration.response.status, 403);
    assert.equal(fixture.auditSink.events.at(-1)?.kind, "authorization_denial");

    // Authorized Configuration writes cannot race the worker before it claims the namespace.
    const premature = await request(fixture.app, `/namespaces/${adopted.id}/configurations`, {
      body: { kind: "agent", values: {} },
    });
    assert.equal(premature.response.status, 409);
    assert.equal(responseError(premature.payload).code, "NAMESPACE_NOT_READY");

    await controller.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(adopted.id, "provisioning", "ready"),
    );
    const ready = await request(fixture.app, `/namespaces/${adopted.id}/configurations`, {
      body: { kind: "agent", values: {} },
    });
    assert.equal(ready.response.status, 201);
    assert.equal(responseData(ConfigurationSchema, ready.payload).namespaceId, adopted.id);
  });

  test("Agent configuration replacement requires exact Agent update authorization and returns Agent service principal identity", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const namespace = await createNamespace(fixture, "Tenant A");
    const agent = await createAgent(fixture, namespace, "Private configuration agent");
    const replacement = await createConfiguration(fixture, namespace, { model: "private-model" });

    const updated = await request(fixture.app, `/namespaces/${namespace.id}/agents/${agent.id}`, {
      method: "PATCH",
      body: { configurationId: replacement.id },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(responseData(AgentSchema, updated.payload).configurationId, replacement.id);
    assert.equal(
      responseData(AgentSchema, updated.payload).servicePrincipalId,
      agent.servicePrincipalId,
    );

    const readOnly = fixture.createApp(fixture.tenantAReader);
    const denied = await request(readOnly, `/namespaces/${namespace.id}/agents/${agent.id}`, {
      method: "PATCH",
      body: { configurationId: agent.configurationId },
    });
    assert.equal(denied.response.status, 403);
    assert.equal(responseError(denied.payload).code, "FORBIDDEN");
    assert.equal(fixture.auditSink.events.at(-1)?.kind, "authorization_denial");
    assert.equal(fixture.auditSink.events.at(-1)?.resource.id, agent.id);

    const unchanged = await request(fixture.app, `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.equal(responseData(AgentReadSchema, unchanged.payload).configurationId, replacement.id);
  });

  test("an exact Agent update Restriction denies only its target without changing its configuration", async () => {
    const deniedAgentId = "agt_00000000-0000-4000-8000-000000000003";
    const fixture = await createFixture({
      restrictions: [
        {
          id: "restriction-no-target-agent-update",
          namespaceId: tenantANamespaceId,
          action: "update",
          resourceKind: "agent",
          resourceId: deniedAgentId,
          effect: "deny",
        },
      ],
    });
    await bootstrap(fixture);
    const namespace = await createNamespace(fixture, "Tenant A");
    const deniedAgent = await createAgent(fixture, namespace, "Restricted agent");
    const allowedAgent = await createAgent(fixture, namespace, "Allowed agent");
    const replacement = await createConfiguration(fixture, namespace, { model: "allowed" });
    assert.equal(deniedAgent.id, deniedAgentId);

    const denied = await request(
      fixture.app,
      `/namespaces/${namespace.id}/agents/${deniedAgent.id}`,
      { method: "PATCH", body: { configurationId: replacement.id } },
    );
    assert.equal(denied.response.status, 403);
    assert.deepEqual(restrictionIds(fixture.auditSink.events.at(-1)), [
      "restriction-no-target-agent-update",
    ]);

    const allowed = await request(
      fixture.app,
      `/namespaces/${namespace.id}/agents/${allowedAgent.id}`,
      { method: "PATCH", body: { configurationId: replacement.id } },
    );
    assert.equal(allowed.response.status, 200);
    assert.equal(responseData(AgentSchema, allowed.payload).configurationId, replacement.id);

    const unchanged = await request(
      fixture.app,
      `/namespaces/${namespace.id}/agents/${deniedAgent.id}`,
    );
    assert.equal(
      responseData(AgentReadSchema, unchanged.payload).configurationId,
      deniedAgent.configurationId,
    );
  });
}

export function registerExactResourceCases() {
  test("exact Namespace ownership prevents cross-tenant access and resource traversal", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const namespaceA = await createNamespace(fixture, "Tenant A");
    const namespaceB = await createNamespace(fixture, "Tenant B");
    const agentA = await createAgent(fixture, namespaceA, "Agent A");
    const agentB = await createAgent(fixture, namespaceB, "Agent B");
    await expectProvisioningDeployRefusal(fixture, namespaceA, agentA);
    await expectProvisioningDeployRefusal(fixture, namespaceB, agentB);

    for (const [namespace, agent] of [
      [namespaceA, agentA],
      [namespaceB, agentB],
    ] as const) {
      const revisions = await request(
        fixture.app,
        `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
      );
      assert.equal(revisions.response.status, 200);
      assert.deepEqual(revisions.payload.data, []);
    }

    for (const pathname of [
      `/namespaces/${namespaceA.id}/agents/${agentB.id}`,
      `/namespaces/${namespaceA.id}/agents/${agentB.id}/revisions`,
      `/namespaces/${namespaceA.id}/agents/${agentA.id}/revisions/${missingRevisionId}`,
      `/namespaces/${namespaceB.id}/agents/${agentB.id}/revisions/${missingRevisionId}`,
      "/namespaces/%00",
      "/namespaces/%5Ctenant",
    ]) {
      const result = await request(fixture.app, pathname);
      assert.ok(
        result.response.status === 400 || result.response.status === 404,
        `${pathname}: ${result.response.status}`,
      );
    }
    // An encoded "../" stays inside its path parameter: the router never decodes it into a path,
    // never redirects, and every ID parameter refuses it as a malformed ID that it names
    // (finding D764). The answer depends only on the path, so a real and an unknown Agent match.
    const traversal = (id: string) => `${id}%2F..%2F..%2Fnamespaces`;
    const configuration = `cfg_${agentA.id.slice(4)}`;
    const unknownAgentId = "agt_5c1e8d2a-6b3f-4d7e-9a2c-1f8e3b6d4a90";
    const unknownSecretId = "sec_7d2f9e3b-1a4c-4e8d-b6f2-3c9a1e7d5b02";
    for (const [pathname, parameter, prefix] of [
      [`/namespaces/${traversal(namespaceA.id)}`, "namespaceId", "ns_"],
      [`/namespaces/${namespaceA.id}/agents/${traversal(agentA.id)}`, "agentId", "agt_"],
      [`/namespaces/${namespaceA.id}/agents/${traversal(unknownAgentId)}`, "agentId", "agt_"],
      [`/namespaces/${namespaceA.id}/agents/${agentB.id}%2F..`, "agentId", "agt_"],
      [
        `/namespaces/${namespaceA.id}/agents/${agentA.id}/revisions/${traversal(missingRevisionId)}`,
        "revisionId",
        "rev_",
      ],
      [
        `/namespaces/${namespaceA.id}/configurations/${traversal(configuration)}`,
        "configurationId",
        "cfg_",
      ],
      [`/namespaces/${namespaceA.id}/secrets/${traversal(unknownSecretId)}`, "secretId", "sec_"],
    ] as const) {
      const result = await request(fixture.app, pathname);
      assert.equal(result.response.status, 400, pathname);
      assert.equal(result.response.headers.get("location"), null, pathname);
      assert.deepEqual(
        responseError(result.payload),
        {
          code: "INVALID_REQUEST",
          message: `The request does not match the operation contract: params /${parameter} has an invalid format; expected ${prefix} followed by a lowercase version 4 UUID.`,
          details: [{ path: `/${parameter}`, code: "INVALID_FORMAT" }],
        },
        pathname,
      );
    }
    // A path no route has gets route text, not "resource not found", and the same answer for a
    // readable and an unknown Agent (finding D764).
    for (const [suffix, message] of [
      ["/", "No API route has this path: remove the trailing slash."],
      ["/no-such-route", "No API route has this path. Check it against the API reference."],
    ] as const) {
      const answers: Array<readonly [number, ReturnType<typeof responseError>]> = [];
      for (const id of [agentA.id, unknownAgentId]) {
        const result = await request(
          fixture.app,
          `/namespaces/${namespaceA.id}/agents/${id}${suffix}`,
        );
        assert.equal(result.response.status, 404, suffix);
        assert.deepEqual(responseError(result.payload), { code: "NOT_FOUND", message }, suffix);
        answers.push([result.response.status, responseError(result.payload)]);
      }
      assert.deepEqual(answers[0], answers[1]);
    }

    const reader = fixture.tenantAReader;
    assert.equal(namespaceA.id, tenantANamespaceId);
    const readerApp = fixture.createApp(reader);

    const visible = await request(readerApp, "/namespaces");
    assert.equal(visible.response.status, 200);
    assert.deepEqual(
      responseData(NamespaceListResponse.properties.data, visible.payload).map(
        (namespace) => namespace.id,
      ),
      [namespaceA.id],
    );

    const ownAgent = await request(readerApp, `/namespaces/${namespaceA.id}/agents/${agentA.id}`);
    assert.equal(ownAgent.response.status, 200);

    const controller = fixture.controller;
    assert.ok(controller);
    const operationCount = controller.pendingOperations().length;
    for (const candidate of [
      { pathname: `/namespaces/${namespaceB.id}` },
      { pathname: `/namespaces/${namespaceB.id}/agents` },
      { pathname: `/namespaces/${namespaceB.id}/agents/${agentB.id}` },
      {
        pathname: `/namespaces/${namespaceB.id}/agents`,
        body: { name: "Cross-tenant mutation", configurationId: agentB.configurationId },
      },
    ]) {
      const { pathname, ...options } = candidate;
      const result = await request(readerApp, pathname, options);
      assert.equal(result.response.status, 403, candidate.pathname);
      assert.equal(controller.pendingOperations().length, operationCount);
    }

    const scopedDenials = fixture.auditSink.events.filter(
      (event) => event.kind === "authorization_denial" && event.actorId === reader.id,
    );
    assert.equal(scopedDenials.length, 4);
    for (const event of scopedDenials) {
      assert.equal(event.installationId, installationId);
      assert.equal(event.namespaceId, namespaceB.id);
      assert.equal(event.outcome, "denied");
    }
  });

  test("a caller without a grant gets the same audited denial whether or not the target exists", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    await createNamespace(fixture, "Tenant A");
    const namespace = await createNamespace(fixture, "Tenant B");
    const agent = await createAgent(fixture, namespace, "Agent B");
    const missingNamespaceId = "ns_9e5b1c7a-5d2f-4c1e-8a3b-0f6d2e7c9a41";
    const missingAgentId = "agt_4b8e2d1f-7a3c-4e9b-9c5d-2a1f8e6b3d70";
    const child = (prefix: string) => `${prefix}_6c2a9f1e-3b7d-4a8c-b5e1-9d4f2a7c8e03`;
    const reader = fixture.tenantAReader;
    const readerApp = fixture.createApp(reader);

    // The reader holds no grant in Tenant B. Compare each operation's actual error and
    // metadata across existing and missing targets, including the exact grant it denied.
    const namespaceRoutes: readonly RouteProbe[] = [
      ["GET", "agents/repository-options", ["create", "agent"]],
      ["GET", `agents/provision/${child("work")}`, ["create", "agent"]],
      ["POST", `agents/provision/${child("work")}/retry`, ["create", "agent"]],
      ["GET", "presets", ["read", "namespace"]],
      [
        "POST",
        "agents",
        ["create", "agent"],
        { name: "probe", configurationId: agent.configurationId },
      ],
      ["POST", "configurations", ["create", "configuration"], { kind: "agent", values: {} }],
      [
        "PATCH",
        `configurations/${child("cfg")}`,
        ["update", "configuration", child("cfg")],
        { values: {} },
      ],
      ["DELETE", `configurations/${child("cfg")}`, ["delete", "configuration", child("cfg")]],
      ["POST", "secrets", ["create", "secret"], { name: "probe", value: "probe-value" }],
      [
        "PATCH",
        `secrets/${child("sec")}`,
        ["update", "secret", child("sec")],
        { value: "probe-value" },
      ],
      ["DELETE", `secrets/${child("sec")}`, ["delete", "secret", child("sec")]],
      [
        "POST",
        "credential-sources",
        ["create", "credential_source"],
        { name: "probe", type: "openai" },
      ],
      [
        "PATCH",
        `credential-sources/${child("cs")}`,
        ["update", "credential_source", child("cs")],
        {},
      ],
      ["DELETE", `credential-sources/${child("cs")}`, ["delete", "credential_source", child("cs")]],
      ["POST", "presets", ["create", "preset"], { name: "probe", template: {} }],
      ["PATCH", `presets/${child("pre")}`, ["update", "preset", child("pre")], { name: "probe" }],
      ["DELETE", `presets/${child("pre")}`, ["delete", "preset", child("pre")]],
      ["POST", "service-accounts", ["create", "service_account"], { name: "probe" }],
      [
        "POST",
        `service-accounts/${child("sa")}/credentials`,
        ["update", "service_account", child("sa")],
        {},
      ],
      [
        "PATCH",
        `service-accounts/${child("sa")}/credential`,
        ["update", "service_account", child("sa")],
        { kind: "api_key", secretRef: { name: "probe", key: "probe" } },
      ],
      ["DELETE", `service-accounts/${child("sa")}`, ["delete", "service_account", child("sa")]],
      ["DELETE", "", ["delete", "namespace"]],
    ];
    const agentRoutes: readonly RouteProbe[] = [
      ["GET", "", ["read", "agent"]],
      ["GET", `revisions/${missingRevisionId}`, ["read", "agent_revision", missingRevisionId]],
      ["GET", `deployments/${missingRevisionId}`, ["read", "agent_revision", missingRevisionId]],
      ["GET", "repository-options", ["update", "agent"]],
      ["PATCH", "", ["update", "agent"], { configurationId: agent.configurationId }],
      ["POST", "deploy", ["deploy", "agent"]],
      ["POST", "stop", ["operate", "agent"]],
      ["POST", `credential-sources/${child("cs")}/withdraw`, ["operate", "agent"]],
      ["DELETE", "", ["delete", "agent"]],
    ];
    const probes = [
      ...namespaceRoutes.map(([method, suffix, [action, kind, id], body]) =>
        [namespace.id, missingNamespaceId].map((namespaceId) => ({
          method,
          body,
          namespaceId,
          agentId: undefined,
          pathname: `/namespaces/${namespaceId}${suffix ? `/${suffix}` : ""}`,
          authorization: { action, resource: { kind, id: id ?? namespaceId, namespaceId } },
        })),
      ),
      ...agentRoutes.map(([method, suffix, [action, kind, id], body]) =>
        (
          [
            [namespace.id, agent.id],
            [namespace.id, missingAgentId],
            [missingNamespaceId, missingAgentId],
          ] as const
        ).map(([namespaceId, agentId]) => ({
          method,
          body,
          namespaceId,
          agentId,
          pathname: `/namespaces/${namespaceId}/agents/${agentId}${suffix ? `/${suffix}` : ""}`,
          authorization: { action, resource: { kind, id: id ?? agentId, namespaceId } },
        })),
      ),
    ];

    for (const variants of probes) {
      let reference:
        { error: ReturnType<typeof responseError>; headers: Record<string, string> } | undefined;
      for (const { method, pathname, body, namespaceId, agentId, authorization } of variants) {
        const label = `${method} ${pathname}`;
        const auditCount = fixture.auditSink.events.length;
        const result = await request(readerApp, pathname, {
          method,
          ...(body === undefined ? {} : { body }),
        });
        const denials = fixture.auditSink.events
          .slice(auditCount)
          .filter((event) => event.kind === "authorization_denial" && event.actorId === reader.id);
        assert.equal(result.response.status, 403, label);
        assert.equal(denials.length, 1, label);
        const denial = denials[0];
        assert.equal(denial?.requestId, result.response.headers.get("x-request-id"), label);
        assert.equal(denial?.installationId, installationId, label);
        assert.equal(denial?.namespaceId, namespaceId, label);
        assert.equal(denial?.outcome, "denied", label);
        assert.deepEqual(
          denial?.authorization,
          { principalId: reader.id, ...authorization },
          label,
        );

        const error = responseError(result.payload);
        assert.equal(error.code, "FORBIDDEN", label);
        // A missing grant carries no resource counts, detail paths, or other stored metadata.
        assert.deepEqual(Object.keys(error).sort(), ["code", "message"], label);
        const normalize = (value: string) => {
          const normalized = value.replaceAll(namespaceId, "<namespaceId>");
          return agentId === undefined ? normalized : normalized.replaceAll(agentId, "<agentId>");
        };
        const headers = new Headers(result.response.headers);
        assert.equal(headers.get("cache-control"), "no-store", label);
        assert.equal(headers.get("content-type"), "application/json; charset=utf-8", label);
        assert.equal(headers.get("x-content-type-options"), "nosniff", label);
        // Only the validated request ID and a valid transport timestamp vary per response.
        // Keep every other header, including Content-Length, in the equivalence check.
        const date = headers.get("date");
        if (date !== null) {
          assert.equal(new Date(date).toUTCString(), date, label);
        }
        headers.delete("date");
        headers.delete("x-request-id");
        const responseHeaders = Object.fromEntries(headers);
        const requestedIds = new Set(pathname.split("/"));
        if (
          body !== null &&
          typeof body === "object" &&
          "configurationId" in body &&
          typeof body.configurationId === "string"
        ) {
          requestedIds.add(body.configurationId);
        }
        // Do not erase every resource-shaped ID: an ID read from stored state must stay visible.
        const disclosedIds =
          JSON.stringify({ error, headers: responseHeaders }).match(
            /\b[a-z][a-z0-9_]*_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/g,
          ) ?? [];
        for (const id of disclosedIds) {
          assert.ok(requestedIds.has(id), `${label}: an unrequested resource ID was disclosed`);
        }
        const observed = {
          error: { ...error, message: normalize(error.message) },
          headers: Object.fromEntries(
            Object.entries(responseHeaders).map(([name, value]) => [name, normalize(value)]),
          ),
        };
        if (reference === undefined) {
          reference = observed;
        } else {
          assert.deepEqual(observed.error, reference.error, `${label}: denial error differs`);
          assert.deepEqual(observed.headers, reference.headers, `${label}: denial headers differ`);
        }
      }
    }
  });
}

export function registerNamespaceDeletionCase() {
  test("Namespace deletion authorizes the exact target and rejects nonempty resources", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const occupied = await createNamespace(fixture, "Occupied tenant");
    assert.equal(occupied.id, tenantANamespaceId);
    const readerApp = fixture.createApp(fixture.tenantAReader);
    const forbidden = await request(readerApp, `/namespaces/${occupied.id}`, {
      method: "DELETE",
    });
    assert.equal(forbidden.response.status, 403);

    await createAgent(fixture, occupied, "Existing Agent");
    const nonempty = await request(fixture.app, `/namespaces/${occupied.id}`, {
      method: "DELETE",
    });
    assert.equal(nonempty.response.status, 409);
    assert.equal(responseError(nonempty.payload).code, "NAMESPACE_NOT_EMPTY");

    const empty = await createNamespace(fixture, "Empty tenant");
    const accepted = await request(fixture.app, `/namespaces/${empty.id}`, {
      method: "DELETE",
    });
    assert.equal(accepted.response.status, 202);
    assert.equal(responseData(NamespaceSchema, accepted.payload).status, "deleting");
    const deletionAudit = fixture.auditSink.events.at(-1);
    assert.equal(deletionAudit?.action, "openclaw.namespaces.delete");
    assert.equal(deletionAudit?.resource.id, empty.id);
  });
}
