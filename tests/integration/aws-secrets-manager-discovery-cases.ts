import assert from "node:assert/strict";
import test from "node:test";

import { AgentPluginCatalogResponse } from "../../packages/contracts/src/api/resources.ts";
import { grantRole } from "../helpers/iam-grants.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import {
  accessToken,
  catalogEntry,
  createFixture,
  createSavedAgent,
} from "./plugin-discovery-api-fixture.ts";
import { awsFixtureFromInstallation } from "./aws-secrets-manager-fixture.ts";

test("saved Agent discovery recovers after a simulated AWS GetSecretValue denial", async (t) => {
  const aws = await awsFixtureFromInstallation(t);
  const fixture = await createFixture(t, { secretDriver: aws.driver });
  const { agent, secret, path } = await createSavedAgent(fixture);
  const editor = await fixture.createAccountWithPolicy("aws-discovery-editor", (principal) => {
    grantRole(fixture.policy, principal.id, {
      id: "aws-discovery-agent-editor",
      namespaceId: fixture.namespace.id,
      permissions: { agent: ["read", "update"] },
      resource: { kind: "agent", id: agent.id },
    });
    grantRole(fixture.policy, principal.id, {
      id: "aws-discovery-secret-operator",
      namespaceId: fixture.namespace.id,
      permissions: { secret: ["operate"] },
      resource: { kind: "secret", id: secret.id },
    });
  });
  const session = await fixture.signIn(editor.credentials);
  const requestCatalog = () => fixture.request("POST", path, { session, body: { q: "knowledge" } });
  const expectedCall = { operation: "list", input: { accessToken, q: "knowledge" } };
  const beforeSuccess = aws.calls.length;
  const catalog = await requestCatalog();
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.deepEqual(
    fixture.fixtureResponse(catalog, 200, AgentPluginCatalogResponse, "AWS catalog").data,
    { plugins: [catalogEntry], nextCursor: "second-page" },
  );
  assert.deepEqual(fixture.calls, [expectedCall]);
  assert.deepEqual(aws.calls.slice(beforeSuccess), [
    "DescribeSecretCommand",
    "GetSecretValueCommand",
    "DescribeSecretCommand",
  ]);

  // Keep ownership Describe working; only AWS value retrieval is denied.
  const diagnostic = "synthetic AWS read denial";
  aws.setFault((kind) => {
    if (kind === "GetSecretValueCommand") {
      throw Object.assign(new Error(diagnostic), { name: "AccessDeniedException" });
    }
  });
  const beforeDenial = aws.calls.length;
  const denied = await requestCatalog();
  assertApiError(denied, 503, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(aws.calls.slice(beforeDenial), [
    "DescribeSecretCommand",
    "GetSecretValueCommand",
  ]);
  assert.deepEqual(fixture.calls, [expectedCall]);

  aws.setFault(undefined);
  const recovered = await requestCatalog();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.deepEqual(
    fixture.fixtureResponse(recovered, 200, AgentPluginCatalogResponse, "recovered catalog").data,
    fixture.fixtureResponse(catalog, 200, AgentPluginCatalogResponse, "AWS catalog").data,
  );
  assert.deepEqual(fixture.calls, [expectedCall, expectedCall]);
  const publicEvidence = JSON.stringify([
    catalog.body,
    denied.body,
    recovered.body,
    fixture.auditSink.events,
  ]);
  assert.equal(publicEvidence.includes(accessToken), false);
  assert.equal(publicEvidence.includes(diagnostic), false);
});
