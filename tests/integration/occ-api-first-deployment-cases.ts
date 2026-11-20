import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  AgentResponse,
  AgentRevisionResponse,
  ErrorResponse,
  FirstDeploymentReceiptResponse,
  RequestId,
  type FirstDeploymentIntent,
  type FirstDeploymentReceipt,
} from "../../packages/contracts/src/index.ts";
import type {
  AuthorizationDeniedError as AuthorizationDeniedErrorType,
  ResourceStateConflictError as ResourceStateConflictErrorType,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.ts";
import { fetchLoopback } from "../helpers/console-fixture-transport.ts";
import {
  firstDeploymentFixture,
  slackFirstDeploymentFixture,
} from "./occ-api-first-deployment-fixture.ts";
import {
  checkedInjectedBody,
  createConfiguration,
  identifier,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type FixtureRequestOptions = NonNullable<Parameters<FixtureRequest>[2]>;
type FixtureResponse = Awaited<ReturnType<FixtureRequest>>;
type Deployment = Awaited<ReturnType<typeof firstDeploymentFixture>>;
type Execute = (
  file: string,
  args: string[],
  options?: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;
interface CliRecoveryOptions {
  deployment: Deployment;
  cli: string;
  directory: string;
  execute: Execute;
  reply: "dropped" | "malformed";
  origin: string;
  keyFile: string;
  forwarded: Array<{ method: string | undefined; path: string | undefined }>;
  relayErrors: unknown[];
  relay: Server;
  automationId: string;
}

function isExecFailure(value: unknown): value is { code: number; stdout: string; stderr: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number" &&
    "stdout" in value &&
    typeof value.stdout === "string" &&
    "stderr" in value &&
    typeof value.stderr === "string"
  );
}

const LoopbackEnvelope = Type.Object({
  meta: Type.Object({ requestId: RequestId }),
  data: Type.Optional(Type.Unknown()),
});

export async function request(
  url: string,
  method: string,
  path: string,
  options: FixtureRequestOptions = {},
): Promise<FixtureResponse> {
  let sessionHeaders: Record<string, string> = {};
  if (options.identity !== false) {
    assert(options.session, "an authenticated loopback request needs a session");
    sessionHeaders = authenticatedHeaders(options.session);
  }
  const headers: Record<string, string> = {
    host: "console.oce.localhost",
    ...sessionHeaders,
    ...options.headers,
  };
  let body: RequestInit["body"];
  if (Object.hasOwn(options, "body")) {
    body = JSON.stringify(options.body);
    headers["content-type"] ??= "application/json";
  } else if (Object.hasOwn(options, "rawBody")) {
    body = options.rawBody;
  }
  const response = await fetchLoopback(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 204) {
    return { status: response.status, headers: response.headers };
  }
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  const payload: unknown = await response.json();
  assert(Check(LoopbackEnvelope, payload), "invalid response envelope");
  assert.match(payload.meta.requestId, identifier("req"));
  assert.equal(response.headers.get("x-request-id"), payload.meta.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const data = payload.data;
  if (response.ok) {
    assert.deepEqual(Object.keys(payload).sort(), ["data", "meta"]);
  } else {
    assert(Check(ErrorResponse, payload), "invalid error response");
    assert.deepEqual(Object.keys(payload).sort(), ["error", "meta"]);
    assert.match(payload.error.code, /^[A-Z][A-Z_]*$/);
    assert.ok(payload.error.message.length > 0);
  }
  return { status: response.status, headers: response.headers, body: payload, data };
}

export async function runDirectReceiptAuthority(
  t: TestContext,
  AuthorizationDeniedError: typeof AuthorizationDeniedErrorType,
  ResourceStateConflictError: typeof ResourceStateConflictErrorType,
) {
  const { controller, namespace, agent, path, intent, work, secretDriver } =
    await firstDeploymentFixture();
  const { fixture } = controller;
  const actorId = fixture.principal.id;
  const input = { namespaceId: namespace.id, agentId: agent.id };
  const configurationB = await createConfiguration(controller, namespace.id);
  const admitted = checkedInjectedBody(
    await controller.request("POST", `${path}/deploy-first`, { body: intent }),
    202,
    FirstDeploymentReceiptResponse,
  ).data;

  // This actor owns the known A receipt. Replace its broad grant with exact
  // Agent deploy and Configuration A/B read grants, then revoke only A read.
  const broadRole = fixture.state.roles[0];
  assert(broadRole);
  fixture.state.roles.splice(0, 1, { ...broadRole, permissions: [] });
  const role: (typeof fixture.state.roles)[number] = {
    id: "receipt-exact-reader",
    namespaceId: namespace.id,
    permissions: [
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  fixture.state.roles.push(role);
  const targets: Array<["agent" | "configuration", string]> = [
    ["agent", agent.id],
    ["configuration", agent.configurationId],
    ["configuration", configurationB.id],
  ];
  for (const [kind, id] of targets) {
    fixture.state.bindings.push({
      id: `receipt-${id}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: actorId,
      roleId: role.id,
      resourceKind: kind,
      resourceId: id,
    });
  }
  const iam = fixture.iamDriver;
  type AuthorizationRequest = Parameters<typeof iam.authorize>[0];
  const checks: Array<{
    action: AuthorizationRequest["action"];
    resource: AuthorizationRequest["resource"];
    allowed: boolean;
  }> = [];
  const authorize = iam.authorize.bind(iam);
  t.mock.method(iam, "authorize", async (request: AuthorizationRequest) => {
    const decision = await authorize(request);
    checks.push({
      action: request.action,
      resource: { ...request.resource },
      allowed: decision.allowed,
    });
    return decision;
  });
  type Method = "deployAgentFirst" | "recoverAgentFirstDeployment";
  const invoke = (method: Method, body: FirstDeploymentIntent) =>
    method === "deployAgentFirst"
      ? fixture.controller.deployAgentFirst(actorId, input, body, resolveApprovedDevelopmentHarness)
      : fixture.controller.recoverAgentFirstDeployment(actorId, input, body);
  const expectedChecks = (configurationId: string, allowed: boolean) => [
    {
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
      allowed: true,
    },
    {
      action: "read",
      resource: { kind: "configuration", id: configurationId, namespaceId: namespace.id },
      allowed,
    },
  ];
  const methods: Method[] = ["deployAgentFirst", "recoverAgentFirstDeployment"];
  for (const method of methods) {
    checks.length = 0;
    assert.deepEqual(await invoke(method, { ...intent }), admitted);
    assert.deepEqual(checks, expectedChecks(agent.configurationId, true));
  }
  const bindingA = fixture.state.bindings.find(
    (binding) => binding.id === `receipt-${agent.configurationId}`,
  );
  assert.ok(bindingA);
  fixture.state.bindings.splice(fixture.state.bindings.indexOf(bindingA), 1);
  const beforeAudit = fixture.auditSink.events.length;
  const beforeWork = structuredClone(work());
  const beforeSecrets = secretDriver.calls.length;
  const beforeRevisions = await fixture.platformState.read((view) =>
    view.revisions.listRevisions(namespace.id, agent.id),
  );
  for (const method of methods) {
    for (const mutate of [false, true]) {
      const label = mutate ? "immediate A-to-B mutation" : "stable A";
      await t.test(`${method}: ${label} denies the known receipt`, async () => {
        checks.length = 0;
        const body = { ...intent };
        const pending = invoke(method, body);
        if (mutate) {
          body.expectedConfigurationId = configurationB.id;
        }
        // Check the outcome as well as effects: a leaked receipt creates no work.
        const outcome: { value?: Readonly<FirstDeploymentReceipt> | null; error?: unknown } =
          await pending.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        assert.deepEqual(
          {
            authorizationTrace: checks,
            denied: outcome.error instanceof AuthorizationDeniedError,
            returnedKnownReceipt: isDeepStrictEqual(outcome.value, admitted),
            returnedConfigurationId: outcome.value?.configurationId,
          },
          {
            authorizationTrace: expectedChecks(agent.configurationId, false),
            denied: true,
            returnedKnownReceipt: false,
            returnedConfigurationId: undefined,
          },
        );
      });
    }
    await t.test(`${method}: allowed B has no matching receipt`, async () => {
      checks.length = 0;
      const pending = invoke(method, { ...intent, expectedConfigurationId: configurationB.id });
      if (method === "recoverAgentFirstDeployment") {
        assert.equal(await pending, null);
      } else {
        await assert.rejects(pending, ResourceStateConflictError);
      }
      assert.deepEqual(checks, expectedChecks(configurationB.id, true));
    });
  }
  assert.deepEqual(
    await fixture.platformState.read((view) =>
      view.revisions.listRevisions(namespace.id, agent.id),
    ),
    beforeRevisions,
  );
  assert.deepEqual(work(), beforeWork);
  assert.equal(secretDriver.calls.length, beforeSecrets);
  assert.equal(fixture.auditSink.events.length, beforeAudit);
}

export async function runSnapshotReadFailure() {
  const { controller, namespace, agent, intent, work, secretDriver } =
    await firstDeploymentFixture();
  const state = controller.fixture.platformState;
  const read = state.read.bind(state);
  state.read = (operation) =>
    read((unit) =>
      operation({
        ...unit,
        configurations: {
          ...unit.configurations,
          findConfiguration: async () => {
            throw new Error("synthetic snapshot read failure");
          },
        },
      }),
    );
  state.transact = async () => assert.fail("a failed read must not enter admission");
  await assert.rejects(
    controller.fixture.controller.deployAgentFirst(
      controller.fixture.principal.id,
      { namespaceId: namespace.id, agentId: agent.id },
      intent,
      resolveApprovedDevelopmentHarness,
    ),
    { message: "synthetic snapshot read failure" },
  );
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(work().length, 0);
}

export async function runSlackLoopback(t: TestContext) {
  const cases: Array<[boolean, "deploy-first" | "deploy"]> = [
    [true, "deploy-first"],
    [false, "deploy-first"],
    [true, "deploy"],
  ];
  for (const [enabled, route] of cases) {
    const deployment = await slackFirstDeploymentFixture(enabled);
    const { controller, namespace, path, intent, secretDriver, work, providerCalls } = deployment;
    const app = controller.fixture.createApp(undefined, createFastifyApp);
    try {
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      const send = (method: string, suffix: string, options: FixtureRequestOptions = {}) =>
        request(url, method, `${path}/${suffix}`, {
          session: app.defaultSession,
          ...options,
        });
      const before = controller.fixture.auditSink.events.length;
      const result = await send("POST", route, route === "deploy-first" ? { body: intent } : {});
      assert.equal(result.status, 202, JSON.stringify(result.body));
      assert.equal(work().length, 1);
      const revisions = await deployment.listRevisionMetadata();
      assert.equal(revisions.length, 1);
      assert.equal(controller.fixture.auditSink.events.length - before, 1);
      assert.equal(providerCalls(), enabled ? 1 : 0);
      assert.equal(
        secretDriver.calls.filter((call) => call.operation === "withValue").length,
        enabled ? 1 : 0,
      );
      assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 2);
      const calls = structuredClone(secretDriver.calls);
      if (route === "deploy-first") {
        const resultData = checkedInjectedBody(result, 202, FirstDeploymentReceiptResponse).data;
        assert.deepEqual(Object.keys(resultData).sort(), [
          "agentId",
          "configurationGeneration",
          "configurationId",
          "createdAt",
          "namespaceId",
          "revisionId",
        ]);
        // Poison the fresh-only dependency after commit. Recovery must not consult it.
        controller.fixture.configurationDriver.read = async () =>
          assert.fail("Recovery read Configuration storage");
        const recovered = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        const replay = await send("POST", "deploy-first", { body: intent });
        assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
        assert.equal(recovered.headers.get("cache-control"), "no-store");
        assert.equal(replay.status, 202, JSON.stringify(replay.body));
        assert.deepEqual(
          checkedInjectedBody(recovered, 200, FirstDeploymentReceiptResponse).data,
          resultData,
        );
        assert.deepEqual(
          checkedInjectedBody(replay, 202, FirstDeploymentReceiptResponse).data,
          resultData,
        );
        assert.deepEqual(secretDriver.calls, calls);
        assert.equal(providerCalls(), enabled ? 1 : 0);
        assert.equal(work().length, 1);
        assert.equal(controller.fixture.auditSink.events.length - before, 1);

        // A receipt is private even to its original actor once current draft-read authority
        // is revoked. Use the real IAM policy for both HTTP recovery and POST replay.
        const restrictions = controller.fixture.state.restrictions;
        const beforeRevocation = controller.fixture.auditSink.events.length;
        restrictions.push({
          id: "revoke-first-deployment-configuration-read",
          namespaceId: namespace.id,
          effect: "deny",
          action: "read",
          resourceKind: "configuration",
          resourceId: intent.expectedConfigurationId,
        });
        const deniedRecovery = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        const deniedReplay = await send("POST", "deploy-first", { body: intent });
        for (const denied of [deniedRecovery, deniedReplay]) {
          assert.equal(denied.status, 403, JSON.stringify(denied.body));
          checkedInjectedBody(denied, 403, ErrorResponse);
          assert.equal(denied.data, undefined);
          assert.equal(JSON.stringify(denied.body).includes(resultData.revisionId), false);
        }
        const denials = controller.fixture.auditSink.events.slice(beforeRevocation);
        assert.equal(denials.length, 2);
        for (const denial of denials) {
          assert.equal(denial.kind, "authorization_denial");
          assert(denial.actor);
          assert.equal(denial.actor.principalId, controller.fixture.principal.id);
          assert.deepEqual(denial.authorization, {
            principalId: controller.fixture.principal.id,
            action: "read",
            resource: {
              kind: "configuration",
              id: intent.expectedConfigurationId,
              namespaceId: namespace.id,
            },
          });
        }
        assert.deepEqual(secretDriver.calls, calls);
        assert.equal(providerCalls(), enabled ? 1 : 0);
        assert.equal(work().length, 1);
        assert.deepEqual(await deployment.listRevisionMetadata(), revisions);
        restrictions.pop();
        const restored = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        assert.equal(restored.status, 200, JSON.stringify(restored.body));
        assert.deepEqual(
          checkedInjectedBody(restored, 200, FirstDeploymentReceiptResponse).data,
          resultData,
        );

        // Accepting deletion fences fresh admission, but the original committed receipt
        // remains readable until teardown removes the Agent and its revisions.
        const deletion = await request(url, "DELETE", path, { session: app.defaultSession });
        assert.equal(deletion.status, 202, JSON.stringify(deletion.body));
        assert.equal(checkedInjectedBody(deletion, 202, AgentResponse).data.status, "deleting");
        const deletionWork = controller.fixture.platformState.pendingOperations();
        const deletionAuditCount = controller.fixture.auditSink.events.length;
        const afterDeletion = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        const afterDeletionReplay = await send("POST", "deploy-first", { body: intent });
        assert.equal(afterDeletion.status, 200, JSON.stringify(afterDeletion.body));
        assert.equal(afterDeletionReplay.status, 202, JSON.stringify(afterDeletionReplay.body));
        assert.deepEqual(
          checkedInjectedBody(afterDeletion, 200, FirstDeploymentReceiptResponse).data,
          resultData,
        );
        assert.deepEqual(
          checkedInjectedBody(afterDeletionReplay, 202, FirstDeploymentReceiptResponse).data,
          resultData,
        );
        assert.deepEqual(controller.fixture.platformState.pendingOperations(), deletionWork);
        assert.equal(controller.fixture.auditSink.events.length, deletionAuditCount);
        assert.deepEqual(secretDriver.calls, calls);
        assert.equal(providerCalls(), enabled ? 1 : 0);
      } else {
        assert.equal(checkedInjectedBody(result, 202, AgentRevisionResponse).data.revision, 1);
      }
      t.diagnostic(
        JSON.stringify({
          enabled,
          route,
          revisions: revisions.length,
          work: work().length,
          audit: controller.fixture.auditSink.events.length - before,
          sender: providerCalls(),
          withValue: calls.filter((call) => call.operation === "withValue").length,
          resolve: calls.filter((call) => call.operation === "resolve").length,
        }),
      );
    } finally {
      await app.close();
    }
  }
}

export async function runCliRecovery(t: TestContext, options: CliRecoveryOptions) {
  const {
    deployment,
    cli,
    directory,
    execute,
    reply,
    origin,
    keyFile,
    forwarded,
    relayErrors,
    relay,
    automationId,
  } = options;
  const { controller, namespace, agent, path, intent, work, secretDriver, providerCalls } =
    deployment;
  const fixture = controller.fixture;
  let committed: FirstDeploymentReceipt | undefined;
  let recovered: FirstDeploymentReceipt | undefined;
  let callerKey: string | undefined;
  relay.on("request", async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      const stream: AsyncIterable<unknown> = incoming;
      for await (const chunk of stream) {
        assert(Buffer.isBuffer(chunk), "the CLI request body must contain buffers");
        chunks.push(chunk);
      }
      forwarded.push({ method: incoming.method, path: incoming.url });
      assert(incoming.method && incoming.url, "the CLI request must have a method and path");
      const apiKey = incoming.headers["x-api-key"];
      assert(typeof apiKey === "string", "the CLI request must carry a service key");
      if (callerKey === undefined) {
        callerKey = apiKey;
      } else {
        assert(apiKey === callerKey, "recovery must authenticate as the original caller");
      }
      const contentType = incoming.headers["content-type"];
      assert(contentType === undefined || typeof contentType === "string");
      const response = await fetchLoopback(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers: {
          host: "console.oce.localhost",
          "x-api-key": apiKey,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
        },
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      });
      const body = await response.text();
      if (incoming.method === "POST" && response.status === 202) {
        // OCC really committed. The relay loses or corrupts only its response; the
        // next GET must recover the true receipt from the unchanged application.
        const envelope: unknown = JSON.parse(body);
        assert(
          Check(FirstDeploymentReceiptResponse, envelope),
          "invalid committed receipt envelope",
        );
        committed = envelope.data;
        if (reply === "dropped") {
          outgoing.destroy();
        } else {
          outgoing.writeHead(response.status, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ ...envelope, data: {} }));
        }
        return;
      }
      if (incoming.method === "GET" && response.status === 200) {
        const envelope: unknown = JSON.parse(body);
        assert(
          Check(FirstDeploymentReceiptResponse, envelope),
          "invalid recovered receipt envelope",
        );
        recovered = envelope.data;
      }
      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(body);
    } catch (error) {
      relayErrors.push(error);
      outgoing.destroy();
    }
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert(address && typeof address === "object", "the loopback relay must have a TCP address");
  const relayOrigin = `http://127.0.0.1:${address.port}`;
  const args = [
    "--url",
    relayOrigin,
    "--service-key-file",
    keyFile,
    "--ca-bundle",
    "",
    "--timeout-seconds",
    "5",
    "--namespace",
    namespace.id,
    "agent",
    "deploy-first",
    agent.id,
    "--key",
    intent.key,
    "--configuration",
    intent.expectedConfigurationId,
    "--generation",
    String(intent.expectedGeneration),
  ];
  let failure: unknown;
  try {
    failure = { code: 0, ...(await execute(cli, args)) };
  } catch (error) {
    failure = error;
  }
  assert(isExecFailure(failure), "the CLI must return a structured subprocess failure");
  assert.deepEqual(relayErrors, []);
  assert.ok(committed, "the uncertain response must follow a real committed admission");
  assert(callerKey, "the committed request must authenticate with a service key");
  assert.deepEqual(
    forwarded,
    [{ method: "POST", path: `${path}/deploy-first` }],
    "the CLI must not automatically replay an uncertain mutation",
  );
  const revisions = await deployment.listRevisionMetadata();
  assert.equal(revisions.length, 1);
  const revision = revisions[0];
  assert(revision);
  assert.equal(revision.id, committed.revisionId);
  assert.equal(work().length, 1);
  const calls = structuredClone(secretDriver.calls);
  const audit = structuredClone(fixture.auditSink.events);
  const deployments = audit.filter(
    (event) => event.action === "openclaw.agents.deploy" && event.outcome === "success",
  );
  assert.equal(deployments.length, 1);
  const deploymentAudit = deployments[0];
  assert(deploymentAudit);
  assert(deploymentAudit.actor);
  assert.equal(deploymentAudit.actor.principalId, automationId);
  t.diagnostic(
    JSON.stringify({
      reply,
      cliExit: failure.code,
      posts: forwarded.length,
      revisions: revisions.length,
      work: work().length,
      sender: providerCalls(),
    }),
  );
  assert.equal(failure.code, 1, "an unusable receipt must leave the CLI outcome uncertain");
  assert(failure.stdout.length === 0, "the uncertain command must not write to stdout");
  assert(
    !failure.stderr.includes(callerKey),
    "the uncertain result must not print the service key",
  );
  assert.match(failure.stderr, reply === "dropped" ? /EOF/ : /invalid.*receipt/i);
  assert.match(failure.stderr, /same caller/);
  const recoveryCommand = failure.stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("occ "));
  assert.ok(recoveryCommand, "the uncertain result must print an executable recovery command");
  for (const expected of [
    relayOrigin,
    keyFile,
    `--namespace ${namespace.id}`,
    `agent recover-first-deployment ${agent.id}`,
    `--key ${intent.key}`,
    `--configuration ${intent.expectedConfigurationId}`,
    `--generation ${intent.expectedGeneration}`,
  ]) {
    assert.ok(recoveryCommand.includes(expected), `recovery command must retain ${expected}`);
  }
  // Execute exactly the printed command, including its quoted path with spaces.
  const recovery = await execute("/bin/sh", ["-c", recoveryCommand], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
  }).catch(() => assert.fail("the printed recovery command must succeed"));
  assert.deepEqual(relayErrors, []);
  assert.deepEqual(recovered, committed);
  assert(
    !recovery.stdout.includes(callerKey) && !recovery.stderr.includes(callerKey),
    "recovery must not print the service key",
  );
  assert.ok(recovery.stdout.includes(committed.revisionId));
  assert.deepEqual(forwarded, [
    { method: "POST", path: `${path}/deploy-first` },
    {
      method: "GET",
      path: `${path}/deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
    },
  ]);
  assert.equal(work().length, 1);
  assert.deepEqual(await deployment.listRevisionMetadata(), revisions);
  assert.deepEqual(secretDriver.calls, calls);
  assert.equal(providerCalls(), 0);
  assert.deepEqual(fixture.auditSink.events, audit);
  t.diagnostic(
    JSON.stringify({
      reply,
      recovered: true,
      posts: 1,
      gets: 1,
      revisions: revisions.length,
      work: work().length,
      deploymentAudits: deployments.length,
    }),
  );
}
