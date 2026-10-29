import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent, Namespace } from "../../packages/contracts/src/index.ts";

import { assertApiError } from "../helpers/api-error.mjs";
import {
  authorizationDenials,
  createConsoleAppFixture,
  grantMember,
} from "../helpers/console-app.mjs";

type RemainingResource = { kind: string; count: number; ids: string[] };

test("Namespace deletion reports authorized blockers through the Agent workflow without bypassing IAM", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Deletion blockers", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Remaining Agent");
  const member = await fixture.createNamespaceMember("namespace-deleter", namespace.id, [
    ["read", "namespace"],
  ]);
  const session = await fixture.signIn(member.credentials);
  const path = `/namespaces/${namespace.id}`;
  const answer = () => fixture.request("GET", `${path}/permissions`, { session });
  assert.equal((await answer()).data.delete, false);
  assert.equal(authorizationDenials(fixture.auditSink).length, 0);

  // A read grant cannot expose the IDs in a deletion conflict. Only a real denied DELETE audits.
  const refused = await fixture.request("DELETE", path, { session });
  assertApiError(refused, 403, "FORBIDDEN");
  assert.equal(refused.body.error.remainingResources, undefined);
  assert.equal(authorizationDenials(fixture.auditSink, "openclaw.namespaces.delete").length, 1);
  grantMember(fixture, "namespace-deleter", [["delete", "namespace"]]);
  assert.equal((await answer()).data.delete, true);

  // Real Configurations make the response limit meaningful; counts survive the 20-ID cap.
  const configurationIds = new Set([agent.configurationId]);
  for (let index = 0; index < 21; index += 1) {
    configurationIds.add((await fixture.createConfiguration(namespace.id)).id);
  }
  // Finding 2724: Namespace delete does not grant reads of its contents. The conflict counts
  // the remaining resources (the Agent's Secret too) but names none of them, in the list or
  // in the message.
  const unreadable = await fixture.request("DELETE", path, { session });
  assertApiError(unreadable, 409, "NAMESPACE_NOT_EMPTY");
  assert.deepEqual(unreadable.body.error.remainingResources, [
    { kind: "Agents", count: 1, ids: [] },
    { kind: "Configurations", count: 22, ids: [] },
    { kind: "Secrets", count: 1, ids: [] },
  ]);
  assert.equal(
    unreadable.body.error.message,
    "The requested Namespace is not empty. It still contains: Agents (1), Configurations (22), Secrets (1).",
  );

  // With read grants the same conflict names the IDs, up to 20 per kind.
  grantMember(fixture, "namespace-deleter", [
    ["read", "agent"],
    ["read", "configuration"],
  ]);
  const blocked = await fixture.request("DELETE", path, { session });
  assertApiError(blocked, 409, "NAMESPACE_NOT_EMPTY");
  const resources: RemainingResource[] = blocked.body.error.remainingResources;
  assert.deepEqual(
    resources.find(({ kind }) => kind === "Agents"),
    { kind: "Agents", count: 1, ids: [agent.id] },
  );
  const configurations = resources.find(({ kind }) => kind === "Configurations");
  assert.ok(configurations);
  assert.equal(configurations.count, 22);
  assert.equal(configurations.ids.length, 20);
  assert.ok(configurations.ids.every((id) => configurationIds.has(id)));
  // Each kind needs its own read: a read on Agents and Configurations does not name the Secret.
  assert.deepEqual(
    resources.find(({ kind }) => kind === "Secrets"),
    { kind: "Secrets", count: 1, ids: [] },
  );
  // An IAM outage on those reads hides the IDs (fails closed) but not the conflict or counts.
  const outage = await fixture.withIamOutage(
    (request: { action: string; resource: { kind: string } }) =>
      request.action === "read" && request.resource.kind !== "namespace",
    () => fixture.request("DELETE", path, { session }),
  );
  assertApiError(outage, 409, "NAMESPACE_NOT_EMPTY");
  assert.deepEqual(outage.body.error.remainingResources, unreadable.body.error.remainingResources);

  // Deleting the Agent does not empty its Namespace until teardown actually removes the Agent.
  assert.equal((await fixture.request("DELETE", `${path}/agents/${agent.id}`)).status, 202);
  assertApiError(await fixture.request("DELETE", path, { session }), 409, "NAMESPACE_NOT_EMPTY");
  assert.equal((await fixture.request("GET", path)).data.status, "ready");
});

test("empty Namespace deletion is admitted, audited and remains observable until lifecycle cleanup finishes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Deletion completion", { ready: true });
  const path = `/namespaces/${namespace.id}`;
  const member = await fixture.createNamespaceMember("empty-namespace-deleter", namespace.id, [
    ["read", "namespace"],
    ["delete", "namespace"],
  ]);
  const session = await fixture.signIn(member.credentials);
  assert.equal(
    (await fixture.request("GET", `${path}/permissions`, { session })).data.delete,
    true,
  );
  const admitted = await fixture.request("DELETE", path, { session });
  assert.equal(admitted.status, 202);
  assert.equal(admitted.data.id, namespace.id);
  assert.equal(admitted.data.status, "deleting");
  assert.equal((await fixture.request("GET", path)).data.status, "deleting");
  const event = fixture.auditSink
    .list()
    .find((entry: AuditEvent) => entry.action === "openclaw.namespaces.delete");
  assert.equal(event?.actorId, member.principal.id);

  // Exercise OCC cleanup with the fixture Compute Driver; this is not live infrastructure proof.
  await fixture.controller!.handleNamespaceLifecycle(member.principal.id, namespace.id, "deleted");
  assertApiError(await fixture.request("GET", path), 404, "NOT_FOUND");
  assert.equal(
    (await fixture.request("GET", "/namespaces")).data.some(
      (item: Namespace) => item.id === namespace.id,
    ),
    false,
  );
  const reserved = await fixture.request("POST", "/namespaces", { body: { name: namespace.name } });
  assertApiError(reserved, 409, "RESOURCE_CONFLICT");
});
