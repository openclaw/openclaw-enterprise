import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assertNoConnectedAssistantOutput,
  protectedAgentBody,
  protectedConfigurationBody,
  protectedSourceBody,
  sourceAccessBindingBody,
} from "../helpers/egress-connected-inputs.mjs";
import {
  arrangeRealPrerequisites,
  observePreparedStack,
  createRunEvidence,
} from "../helpers/egress-installed-stack.mjs";
import {
  registerCleanupAndStartProvider,
  observeInstalledProtection,
  requestInstalledGatewayTurn,
  waitForProtectedAgentActivation,
} from "../helpers/egress-installed-agent.mjs";
import {
  prepareControllerUpgrade,
  observeControllerUpgrade,
} from "../helpers/egress-controller-upgrade.mjs";
import {
  describeGatewayAppServerDeclaration,
  observeConnectedOperation,
  rememberCustodyContext,
  safeConnectedFailure,
} from "../helpers/egress-connected-failure.mjs";
import {
  observeFailedTurnSessions,
  requireSupervisorReconnect,
} from "../helpers/egress-supervisor-reconnect.mjs";
import { tryDirectTcp } from "../helpers/egress-custody-observations.mjs";
import {
  encodeSyntheticEvents,
  syntheticResponsesEvents,
} from "../fixtures/synthetic-egress-provider.mjs";

const inputsPath = process.env.OCC_TEST_EGRESS_CONNECTED_INPUTS;
const selected = process.env.OCC_TEST_EGRESS_CONNECTED === "1" || inputsPath !== undefined;

/**
 * @typedef {Awaited<ReturnType<typeof arrangeRealPrerequisites>>} Prerequisites
 * @typedef {Awaited<ReturnType<typeof createRunEvidence>>} RunEvidence
 * @typedef {Awaited<ReturnType<typeof observePreparedStack>>} PreparedStack
 * @typedef {Awaited<ReturnType<typeof registerCleanupAndStartProvider>>} OwnedResources
 * @typedef {Awaited<ReturnType<typeof deployProtectedAgent>>} Deployment
 * @typedef {Awaited<ReturnType<typeof observeInstalledProtection>>} InstalledProtection
 * @typedef {Awaited<ReturnType<typeof observeRunningAgent>>} AgentTurns
 */

test(
  "protected Codex and a sibling share bounded execution authority through IAM revocation and live rotation",
  {
    skip: selected ? false : "Select OCC_TEST_EGRESS_CONNECTED=1 with a prepared protected stack.",
    timeout: 45 * 60_000,
  },
  async (t) => {
    const progress = { stage: "input-preflight" };
    let evidence;
    try {
      const setup = await arrangeRealPrerequisites(t, progress, inputsPath, {
        wholeExecution: true,
        allowControllerUpgrade: true,
      });
      const upgrade = setup.input.controllerUpgrade;
      evidence = await createRunEvidence(t, setup, progress);
      const initialSetup = upgrade
        ? {
            ...setup,
            input: {
              ...setup.input,
              images: { ...setup.input.images, controller: upgrade.fromImage },
            },
          }
        : setup;
      const stack = await observePreparedStack(t, initialSetup, evidence, progress);
      const owned = await registerCleanupAndStartProvider(t, setup, stack, evidence);
      const deployment = await deployProtectedAgent(setup, stack, evidence, owned);
      const installed = await observeInstalledProtection(setup, stack, evidence, deployment);
      const turns = await observeRunningAgent(setup, stack, evidence, owned, deployment, installed);

      await requireSupervisorReconnect(setup, stack, evidence, deployment, installed);
      await verifyManagedClientsAndDirectBypass(setup, evidence, owned, installed, turns);
      if (upgrade) {
        const retained = await prepareControllerUpgrade(
          setup,
          stack,
          evidence,
          owned,
          deployment,
          installed,
        );
        await observeControllerUpgrade(setup, stack, evidence, owned, deployment, retained);
        await turns.successfulTurn("retained-after-controller-upgrade", "initial");
        // Isolate the IAM phase after a fresh authenticated session without
        // changing the retained process, key, configuration or denial assertions.
        await requireSupervisorReconnect(setup, stack, evidence, deployment, installed);
      }
      await revokeExactGrantAndObserveDenial(stack, evidence, owned, deployment, turns);
      await regrantAndObserveRecovery(owned, deployment, turns);
      const rotatedSecret = await rotateSecretOnly(setup, stack, evidence, deployment, turns);
      await verifyHostileResponsesAndRecovery(owned, turns);
      await observeCredentialLeaks(setup, stack, evidence, owned, deployment, rotatedSecret);
      await withdrawAndObserveSandboxAbsence(setup, stack, evidence, deployment, installed);
      assert.equal(
        owned.provider.observations.length,
        upgrade ? 20 : 19,
        "one startup probe, seventeen measured Codex sends, one sibling send and an optional retained turn; no retries",
      );
    } catch (error) {
      throw await safeConnectedFailure(error, progress.stage, evidence?.recordFailure);
    }
  },
);

/**
 * @param {Prerequisites} setup
 * @param {PreparedStack} stack
 * @param {RunEvidence} evidence
 * @param {OwnedResources} owned
 */
async function deployProtectedAgent(setup, stack, evidence, owned) {
  const { controller, f } = setup;
  const { waitFor } = f;
  const { namespacePath, placement } = stack;
  const { runId, credentials, api, checkpoint } = evidence;
  const { create, recordSandbox } = owned;
  const secret = await create("secrets", {
    name: `egress-${runId}`,
    value: credentials.initial,
  });
  const created = await create(
    "credential-sources",
    protectedSourceBody(`egress-${runId}`, secret.ref, controller.providerOrigin),
  );
  const ownerCapability = created.ownerCapability;
  assert.ok(
    ownerCapability === "credential_gateway" || ownerCapability === "credential_proxy",
    "the created source must identify a public owner capability",
  );
  // This is a fresh, unbound source. Record the maintainer's explicit consent
  // before binding it. Legacy and narrower approvals require this same PATCH.
  const source = await api("PATCH", `${namespacePath}/credential-sources/${created.id}`, {
    adoption: "live",
    authorityScope: "execution",
  });
  assert.equal(source.id, created.id);
  assert.ok(
    source.ownerCapability === ownerCapability,
    "adoption must preserve the source owner capability",
  );
  assert.deepEqual(
    source.egress,
    { adoption: "live", retention: "none" },
    "legacy gateway-copy mode cannot qualify this test",
  );
  assert.equal(source.state, "ready");
  const configuration = await create(
    "configurations",
    protectedConfigurationBody(controller.model),
  );
  const agent = await create(
    "agents",
    protectedAgentBody(`egress-${runId}`, configuration.id, source.id),
  );
  const sourceRole = await create("iam/roles", {
    name: `egress-${runId}`,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const binding = await create(
    "iam/access-bindings",
    sourceAccessBindingBody(agent, sourceRole, source),
  );
  const principalBindings = (await api("GET", `${namespacePath}/iam/access-bindings`)).filter(
    ({ subjectId }) => subjectId === agent.servicePrincipalId,
  );
  assert.deepEqual(
    principalBindings.map(({ id }) => id),
    [binding.id],
    "the new Agent gets only its exact source grant",
  );
  const transport = await api(
    "POST",
    `${namespacePath}/agents/${agent.id}/runtime-credentials`,
    {},
  );
  assert.equal(transport.transportConfigured, true);
  await checkpoint("deploy-request", { agentId: agent.id });
  const revision = await api("POST", `${namespacePath}/agents/${agent.id}/deploy`, undefined, 202);
  assert.ok(
    revision.harnessAuth?.method === "credential_source" &&
      revision.harnessAuth.sourceId === source.id,
    "the admitted Harness must select the adopted source",
  );
  await checkpoint("deployed", {
    agentId: agent.id,
    revisionId: revision.id,
    sourceId: source.id,
    ownerCapability,
  });
  const agentPath = `${namespacePath}/agents/${agent.id}`;
  const deploymentPath = `${agentPath}/deployments/${revision.id}`;
  await waitForProtectedAgentActivation(waitFor, evidence, {
    agentPath,
    deploymentPath,
    revisionId: revision.id,
  });
  const sandbox = await f.waitForSandbox(placement, revision);
  const sandboxId = await recordSandbox(sandbox);
  return {
    secret,
    source,
    agent,
    sourceRole,
    binding,
    revision,
    deploymentPath,
    sandbox,
    sandboxId,
  };
}

/**
 * Captures process and receipt baselines once, before any measured user turn.
 * @param {Prerequisites} setup
 * @param {PreparedStack} stack
 * @param {RunEvidence} evidence
 * @param {OwnedResources} owned
 * @param {Deployment} deployment
 * @param {InstalledProtection} installed
 */
async function observeRunningAgent(setup, stack, evidence, owned, deployment, installed) {
  const { controller, f } = setup;
  const { resource, kubectl } = f;
  const { namespacePath, placement } = stack;
  const { checkpoint, api, excludesCredentials } = evidence;
  const { provider } = owned;
  const { agent, revision } = deployment;
  const { harness, readReceipt, receipt, gatewayPods } = installed;
  const identity = async () => {
    const current = await resource("pod", harness.metadata.name, placement);
    const processes = JSON.parse(
      await kubectl(
        "exec",
        harness.metadata.name,
        "--namespace",
        placement,
        "--container",
        "agent",
        "--",
        "node",
        "-e",
        String.raw`
      const fs = require("node:fs");
      const found = [];
      for (const pid of fs.readdirSync("/proc").filter(x => /^\d+$/.test(x))) {
        try {
          if (!fs.readlinkSync("/proc/" + pid + "/exe").endsWith("/codex")) continue;
          const proc = "/proc/" + pid;
          const stat = fs.readFileSync(proc + "/stat", "utf8");
          found.push({ pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] });
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "EACCES") throw error; }
      }
      if (found.length === 0) throw new Error("No running Codex process observed");
      // Only the synthetic marker is supplied, never the provider credential.
      // A failure to inspect a selected Codex process is a failure of this check.
      for (const { pid } of [...found, {pid: "self"}]) {
        if (fs.readFileSync("/proc/" + pid + "/environ").includes("SYNTHETIC-OCE-EGRESS-")) {
          throw new Error("Provider credential marker present in the Agent environment");
        }
      }
      process.stdout.write(JSON.stringify(found.sort((a,b) => Number(a.pid) - Number(b.pid))));`,
      ),
    );
    return {
      uid: current.metadata.uid,
      containers: current.status.containerStatuses.map(({ name, containerID, restartCount }) => ({
        name,
        containerID,
        restartCount,
      })),
      processes,
    };
  };
  const serving = await identity();
  const unchanged = async () => {
    assert.equal(
      (await api("GET", `${namespacePath}/agents/${agent.id}`)).activeRevisionId,
      revision.id,
    );
    assert.deepEqual(
      await identity(),
      serving,
      "this operation must not restart or redeploy the Harness",
    );
    assert.deepEqual(
      await readReceipt(),
      receipt,
      "the same registered supervisor must remain installed",
    );
  };
  const turn = async (phase, expected = "completed", expectedHttpStatus = null) => {
    const startedAt = new Date().toISOString();
    const nonce = `OCE-EGRESS-${randomUUID()}`;
    await checkpoint("turn-start", {
      gatewayAppServerDeclaration: describeGatewayAppServerDeclaration(gatewayPods[0], "gateway"),
      turnPhase: phase,
      nonce,
      upstreamBefore: provider.observations.length,
    });
    const { custodyTransitions } = installed;
    const { before, result, nativeTurnResult } = await requestInstalledGatewayTurn(
      f,
      evidence,
      {
        placement,
        agentId: agent.id,
        revisionId: revision.id,
        image: setup.input.images.gateway,
        gateway: gatewayPods[0],
        phase,
        custodyTransitions,
        expected,
      },
      {
        providerModel: controller.model,
        prompt: `Reply with exactly ${nonce}.`,
        observeFailure: true,
        timeoutMs: 90_000,
      },
    );
    await observeConnectedOperation(
      "gateway-turn-verification",
      () => {
        excludesCredentials(result, "Codex response/events");
        assert.equal(result.status, expected, `${phase}: actual Codex terminal status`);
        assert.equal(
          result.items.some((event) => event.params?.willRetry === true),
          false,
          "protected calls must not automatically retry",
        );
        if (expected === "completed") {
          assert.equal(result.assistant, nonce);
        } else {
          assertNoConnectedAssistantOutput(result);
          assert.ok(
            Number.isInteger(expectedHttpStatus),
            "failed scenario requires an HTTP status",
          );
          // Native status distinguishes incomplete capture from a fixed refusal.
          // Origin counts and custody transitions distinguish the two refusal paths.
          assert.deepEqual(
            result.error?.codexErrorInfo,
            { httpConnectionFailed: { httpStatusCode: expectedHttpStatus } },
            "expected the scenario's structured supplier refusal",
          );
        }
      },
      nativeTurnResult,
    );
    const revoked = phase === "fresh-iam-revoked";
    const transitions = revoked
      ? ["resolve_refused", "no_permit", "response_blocked"]
      : [
          "resolve_accepted",
          "permit_accepted",
          expected === "completed" ? "response_released" : "response_blocked",
        ];
    let requestId;
    try {
      requestId = await custodyTransitions.expectAfter(before, transitions);
    } catch (error) {
      // Preserve the exact failed observation without retrying the model request.
      // Session events provide timing context, not a request/session binding.
      const sessions = await observeFailedTurnSessions(setup, stack, installed, startedAt).catch(
        () => ({ outcome: "unavailable", gateways: [] }),
      );
      throw rememberCustodyContext(error, phase, { ...sessions, since: startedAt });
    }
    assert.deepEqual(provider.errors, [], "synthetic provider failed independently of enforcement");
    await checkpoint("turn-complete", {
      turnPhase: phase,
      status: result.status,
      requestId,
      upstreamAfter: provider.observations.length,
    });
    return { nonce, requestId };
  };
  const successfulTurn = async (phase, version) => {
    const before = provider.observations.length;
    const { nonce, requestId } = await turn(phase);
    const sent = provider.observations.slice(before);
    assert.equal(sent.length, 1, "one Agent operation must cause exactly one provider send");
    assert.equal(sent[0].nonce, nonce);
    assert.equal(sent[0].credentialVersion, version);
    assert.equal(sent[0].model, controller.model);
    assert.equal(sent[0].stream, true);
    assert.equal(sent[0].store, false);
    assert.ok(
      sent[0].toolTypes.some((type) => type === "function" || type === "namespace"),
      "normal local tools must remain advertised",
    );
    assert.equal(sent[0].toolTypes.includes("web_search"), false);
    await unchanged();
    return requestId;
  };
  return { turn, successfulTurn, unchanged };
}

/**
 * @param {Prerequisites} setup
 * @param {RunEvidence} evidence
 * @param {OwnedResources} owned
 * @param {InstalledProtection} installed
 * @param {AgentTurns} turns
 */
async function verifyManagedClientsAndDirectBypass(setup, evidence, owned, installed, turns) {
  const { controller } = setup;
  const { checkpoint } = evidence;
  const { provider } = owned;
  const { inAgent } = installed;
  const { successfulTurn } = turns;
  // The normal Launcher may probe the model during activation. Keep those
  // requests visible and distinct from measured user turns; never reset counts.
  assert.deepEqual(provider.errors, [], "the normal startup probe must use the protected wire");
  assert.equal(
    provider.observations.length,
    1,
    "the normal Launcher must complete exactly one startup model probe",
  );
  assert.ok(
    provider.observations.every(
      ({ credentialVersion, status, mode }) =>
        credentialVersion === "initial" && status === 200 && mode === "answer",
    ),
  );
  await checkpoint("startup-provider-traffic", { sends: provider.observations.length });
  const { installation, custodyTransitions } = installed;
  assert.equal(installation.enforcement.authorityScope, "execution");
  for (const { binding } of installation.plan.routes) {
    assert.equal(binding.source.source.generation, 2, "install the explicitly adopted generation");
    assert.deepEqual(binding.source.provider, { id: "openai-static-https", generation: 3 });
    assert.deepEqual(binding.grant, {
      kind: "inference",
      models: [controller.model],
      providerTools: "none",
    });
  }
  const released = ["resolve_accepted", "permit_accepted", "response_released"];
  const codexRequest = await successfulTurn("permitted", "initial");
  const beforeSibling = await custodyTransitions.snapshot();

  // An ordinary sibling, with no credential, caller claim or binding header,
  // gets the same managed operation. A Codex-only allowlist fails this control.
  await checkpoint("managed-sibling-start", { codexRequest });
  const nonce = `OCE-EGRESS-${randomUUID()}`;
  const model = controller.model;
  const before = provider.observations.length;
  const delivered = await inAgent(
    "curl",
    "-q",
    "--silent",
    "--show-error",
    "--fail",
    "--max-time",
    "35",
    "--header",
    "content-type: application/json",
    "--data-binary",
    JSON.stringify({ model, input: nonce, stream: true, store: false }),
    "--write-out",
    "%{http_code}",
    `${controller.providerOrigin}/responses`,
  );
  evidence.excludesCredentials(delivered, "managed sibling response");
  const expected = encodeSyntheticEvents(syntheticResponsesEvents(model, nonce)).toString() + "200";
  assert.ok(
    delivered === expected,
    "sibling receives only the complete approved Responses stream and HTTP 200",
  );
  const [sent, ...extra] = provider.observations.slice(before);
  assert.ok(sent?.nonce === nonce && sent.status === 200 && sent.credentialVersion === "initial");
  assert.equal(extra.length, 0, "one authenticated sibling request at the independent origin");
  const siblingRequest = await custodyTransitions.expectAfter(beforeSibling, released);
  assert.notEqual(siblingRequest, codexRequest, "distinct protected exchanges from two callers");
  await checkpoint("managed-sibling-received", { codexRequest, siblingRequest, providerSends: 1 });

  // Try raw TCP to the same live destination by IP. The independent listener
  // counts even a connection that delivered no valid TLS or HTTP request.
  const observed = await tryDirectTcp(provider, setup.input.provider, inAgent);
  assert.equal(provider.observations.length, before + 1, "direct probe sent no provider request");
  await turns.unchanged();
  await checkpoint("direct-bypass-denied", observed);
}

/**
 * @param {PreparedStack} stack
 * @param {RunEvidence} evidence
 * @param {OwnedResources} owned
 * @param {Deployment} deployment
 * @param {AgentTurns} turns
 */
async function revokeExactGrantAndObserveDenial(stack, evidence, owned, deployment, turns) {
  const { namespacePath, namespace, pool } = stack;
  const { api, checkpoint } = evidence;
  const { provider } = owned;
  const { agent, source, binding, revision } = deployment;
  const { turn, unchanged } = turns;
  // Revoke only the exact native IAM grant. Do not withdraw the source, stop the
  // Agent, mutate its revision, or replace a production authority callback.
  await api("DELETE", `${namespacePath}/iam/access-bindings/${binding.id}`, undefined, 204);
  const beforeDenials = await pool.query(
    "SELECT id FROM occ.audit_events WHERE namespace_id = $1 AND actor_id = $2 AND resource_id = $3 AND action = 'openclaw.egress.authorize'",
    [namespace.id, agent.servicePrincipalId, source.id],
  );
  const knownDenials = new Set(beforeDenials.rows.map(({ id }) => id));
  const beforeDenied = provider.observations.length;
  const beforeConnections = provider.tcpConnections;
  const beforeApplicationBytes = provider.applicationBytes;
  const { requestId } = await turn("fresh-iam-revoked", "failed", 403);
  // The supervisor may establish TCP/TLS before authorizing the captured HTTP
  // request. Record transport activity separately from the forbidden request send.
  const observed = {
    httpRequestsBefore: beforeDenied,
    httpRequestsAfter: provider.observations.length,
    tcpConnectionsBefore: beforeConnections,
    tcpConnectionsAfter: provider.tcpConnections,
    applicationBytesBefore: beforeApplicationBytes,
    applicationBytesAfter: provider.applicationBytes,
  };
  await checkpoint("fresh-iam-provider-observed", observed);
  assert.equal(
    observed.httpRequestsAfter,
    observed.httpRequestsBefore,
    "fresh IAM denial must precede every provider send",
  );
  assert.equal(
    observed.applicationBytesAfter,
    observed.applicationBytesBefore,
    "fresh IAM denial must precede every provider application byte",
  );
  const denials = await pool.query(
    "SELECT id, actor_id, resource_kind, resource_id, details, outcome FROM occ.audit_events WHERE namespace_id = $1 AND actor_id = $2 AND resource_id = $3 AND action = 'openclaw.egress.authorize'",
    [namespace.id, agent.servicePrincipalId, source.id],
  );
  const freshDenials = denials.rows.filter(({ id }) => !knownDenials.has(id));
  assert.equal(
    freshDenials.length,
    1,
    "one refused operation must produce one attributable authority denial",
  );
  const denied = freshDenials[0];
  assert.equal(denied.actor_id, agent.servicePrincipalId);
  assert.equal(denied.resource_kind, "credential_source");
  assert.equal(denied.resource_id, source.id);
  assert.equal(denied.details.code, "unauthorized");
  assert.equal(denied.details.phase, "before_access");
  assert.equal(denied.details.revisionId, revision.id);
  assert.equal(denied.outcome, "denied");
  assert.equal(denied.details.requestId, requestId, "IAM denied the exact supervisor exchange");
  await unchanged();
  await checkpoint("fresh-iam-denial", {
    requestId: denied.details.requestId,
    phase: denied.details.phase,
    providerSends: 0,
  });
}

/**
 * @param {OwnedResources} owned
 * @param {Deployment} deployment
 * @param {AgentTurns} turns
 */
async function regrantAndObserveRecovery(owned, deployment, turns) {
  const { create } = owned;
  const { agent, sourceRole, source } = deployment;
  const { successfulTurn } = turns;
  await create("iam/access-bindings", sourceAccessBindingBody(agent, sourceRole, source));
  await successfulTurn("regranted", "initial");
}

/**
 * @param {Prerequisites} setup
 * @param {PreparedStack} stack
 * @param {RunEvidence} evidence
 * @param {Deployment} deployment
 * @param {AgentTurns} turns
 */
async function rotateSecretOnly(setup, stack, evidence, deployment, turns) {
  const {
    f: { kubectl },
  } = setup;
  const { namespacePath, placement } = stack;
  const { api, credentials, checkpoint } = evidence;
  const { secret, source } = deployment;
  const { successfulTurn } = turns;
  // Secret-only rotation deliberately avoids PATCH source and deploy. The same
  // admitted binding must select the new authoritative material on its next use.
  const secretVersion = async () => {
    // Ask kubectl to emit metadata only; credential values never enter this observer.
    const text = await kubectl(
      "get",
      "secrets",
      "--namespace",
      placement,
      "--selector",
      `openclaw.dev/secret=${secret.id}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.uid}{"\\t"}{.metadata.resourceVersion}{"\\n"}{end}',
    );
    const found = text.trim().split("\n");
    assert.equal(found.length, 1);
    const [name, uid, version] = found[0].split("\t");
    assert.ok(name && uid && version);
    return { name, uid, version };
  };
  const oldVersion = await secretVersion();
  const sourceBeforeRotation = await api("GET", `${namespacePath}/credential-sources/${source.id}`);
  await api("PATCH", `${namespacePath}/secrets/${secret.id}`, { value: credentials.rotated });
  const newVersion = await secretVersion();
  assert.equal(newVersion.uid, oldVersion.uid);
  assert.notEqual(newVersion.version, oldVersion.version);
  assert.deepEqual(
    await api("GET", `${namespacePath}/credential-sources/${source.id}`),
    sourceBeforeRotation,
    "Secret-only rotation must leave source metadata unchanged",
  );
  await successfulTurn("secret-only-rotation", "rotated");
  await checkpoint("rotation", {
    materialId: newVersion.uid,
    previousVersion: oldVersion.version,
    materialVersion: newVersion.version,
  });
  return newVersion;
}

/**
 * @param {OwnedResources} owned
 * @param {AgentTurns} turns
 */
async function verifyHostileResponsesAndRecovery(owned, turns) {
  const { provider } = owned;
  const { turn, unchanged, successfulTurn } = turns;
  // Oversize fails during HTTP capture; incomplete is finite HTTP with unfinished SSE.
  for (const [mode, expectedHttpStatus] of [
    ["reflect-body", 403],
    ["reflect-header", 403],
    ["reflect-split-id", 403],
    ["reflect-encoded-arguments", 403],
    ["reflect-message-citation", 403],
    ["oversize", 409],
    ["incomplete", 403],
  ]) {
    provider.setMode(mode);
    const before = provider.observations.length;
    const { nonce } = await turn(mode, "failed", expectedHttpStatus);
    assert.equal(
      provider.observations.length,
      before + 1,
      "rejected response must not trigger another upstream attempt",
    );
    assert.equal(provider.observations.at(-1).credentialVersion, "rotated");
    assert.equal(provider.observations.at(-1).nonce, nonce);
    assert.equal(provider.observations.at(-1).mode, mode);
    await unchanged();
    provider.setMode("answer");
    await successfulTurn(`${mode}-recovery`, "rotated");
  }
}

/**
 * @param {Prerequisites} setup
 * @param {PreparedStack} stack
 * @param {RunEvidence} evidence
 * @param {OwnedResources} owned
 * @param {Deployment} deployment
 * @param {{ name: string, uid: string, version: string }} newVersion
 */
async function observeCredentialLeaks(setup, stack, evidence, owned, deployment, newVersion) {
  const { f } = setup;
  const { resources } = f;
  const { namespace, placement, pool } = stack;
  const { api, ledger, excludesCredentials, credentials, directory, checkpoint } = evidence;
  const { provider } = owned;
  const { agent, deploymentPath } = deployment;
  const runtime = await api("GET", `${deploymentPath}/runtime`);
  const logs = runtime.sources.filter(({ available }) => available);
  assert.ok(logs.length > 0);
  for (const { id } of logs) {
    await api(
      "GET",
      `${deploymentPath}/runtime/logs?source=${encodeURIComponent(id)}&tailLines=1000`,
    );
  }
  await api("POST", `${deploymentPath}/diagnostics`);
  const audit = await pool.query(
    "SELECT row_to_json(event) AS event FROM occ.audit_events event WHERE namespace_id = $1 AND occurred_at >= $2",
    [namespace.id, ledger.startedAt],
  );
  excludesCredentials(audit.rows, "attributable audit");
  await f.assertNoSecretBytes(placement, Object.values(credentials));
  for (const pod of await resources("pods", placement)) {
    if (pod.metadata.labels?.["openclaw.dev/agent"] === agent.id) {
      excludesCredentials(pod, "Agent Pod");
      assert.equal(
        JSON.stringify(pod.spec).includes(newVersion.name),
        false,
        "no Agent Pod may mount or reference the canonical source Secret",
      );
    }
  }
  await writeFile(
    join(directory, "upstream.json"),
    JSON.stringify(provider.observations, null, 2) + "\n",
    { mode: 0o600 },
  );
  await checkpoint("enforcement-complete", {
    sends: provider.observations.length,
    auditEvents: audit.rowCount,
  });
}

/**
 * @param {Prerequisites} setup
 * @param {PreparedStack} stack
 * @param {RunEvidence} evidence
 * @param {Deployment} deployment
 * @param {InstalledProtection} installed
 */
async function withdrawAndObserveSandboxAbsence(setup, stack, evidence, deployment, installed) {
  const {
    f: { waitFor, resources, customResources },
  } = setup;
  const { namespace, namespacePath, placement, gatewayClient, pool } = stack;
  const { api, checkpoint } = evidence;
  const { agent, source, revision, sandbox, sandboxId } = deployment;
  const { sandboxName, harness, supervisor, gatewayPods } = installed;
  const agentPath = `${namespacePath}/agents/${agent.id}`;
  await api("POST", `${agentPath}/credential-sources/${source.id}/withdraw`, undefined, 202);
  const withdrawal = await waitFor(
    "the recorded owner's withdrawal outcome",
    async () => {
      const status = await api("GET", `${agentPath}/credential-sources/${source.id}/withdrawal`);
      assert.equal(status.revisionId, revision.id);
      assert.equal(status.credentialSourceId, source.id);
      if (status.withdrawalInProgress) {
        return undefined;
      }
      if (status.state === "revoked") {
        assert.ok(!setup.input.controllerUpgrade, "the bundled retirement owner requires a stop");
      } else {
        assert.equal(status.state, "pending");
        assert.equal(status.reason, "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT");
      }
      return status;
    },
    180_000,
  );
  await checkpoint("withdrawal-outcome", {
    revisionId: revision.id,
    state: withdrawal.state,
    reason: withdrawal.reason,
  });
  // This Driver cannot reduce the retained policy in place. Stop through the
  // Agent API; neither an accepted stop nor a pending withdrawal proves fencing.
  const stopWork = () =>
    pool.query(
      "SELECT idempotency_key, state, actor_id FROM occ.controller_work WHERE namespace_id = $1 AND agent_id = $2 AND agent_target = 'stopped'",
      [namespace.id, agent.id],
    );
  const stopAudit = () =>
    pool.query(
      "SELECT id, actor_id, outcome, details->>'reasonCode' AS reason_code, details->>'revisionId' AS revision_id FROM occ.audit_events WHERE namespace_id = $1 AND resource_kind = 'agent' AND resource_id = $2 AND action = 'openclaw.agents.lifecycle.stop'",
      [namespace.id, agent.id],
    );
  assert.equal((await stopWork()).rowCount, 0, "this owned Agent has not been stopped before");
  assert.equal((await stopAudit()).rowCount, 0);
  await checkpoint("stop-request", { agentId: agent.id, revisionId: revision.id });
  await api("POST", `${agentPath}/stop`, undefined, 202);
  const stopped = await waitFor(
    "owned Agent stop completion",
    async () => {
      const work = await stopWork();
      if (work.rowCount === 0) {
        return undefined;
      }
      assert.equal(work.rowCount, 1);
      assert.notEqual(work.rows[0].state, "failed_permanent", "the supported stop must succeed");
      return work.rows[0].state === "succeeded" ? work.rows[0] : undefined;
    },
    180_000,
  );
  // Successful queue completion also covers an already-stopped Agent. The
  // lifecycle audit attributes actual retirement to this stop and revision.
  const audit = await stopAudit();
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].reason_code, "AGENT_STOPPED");
  assert.equal(audit.rows[0].outcome, "success");
  assert.equal(audit.rows[0].revision_id, revision.id);
  assert.equal(audit.rows[0].actor_id, stopped.actor_id);
  const current = await api("GET", agentPath);
  assert.equal(current.desiredRuntimeState, "stopped");
  assert.equal(current.activeRevisionId, undefined);
  const podUids = new Set(
    [harness, supervisor, ...gatewayPods].map(({ metadata }) => metadata.uid),
  );
  await waitFor(
    "original Sandbox and all owned runtime Pods absent",
    async () => {
      const observed = await gatewayClient.getSandbox(
        { workspace: placement, name: sandboxName },
        AbortSignal.timeout(10_000),
      );
      const pods = await resources("pods", placement);
      const sandboxes = await customResources("sandboxes.agents.x-k8s.io", placement);
      const owned = ({ metadata }) =>
        podUids.has(metadata.uid) ||
        metadata.uid === sandbox.metadata.uid ||
        metadata.name === sandbox.metadata.name ||
        metadata.labels?.["openclaw.dev/agent"] === agent.id ||
        metadata.labels?.["openshell.ai/sandbox-id"] === sandboxId;
      return observed === undefined && !pods.some(owned) && !sandboxes.some(owned)
        ? true
        : undefined;
    },
    180_000,
  );
  // Stop clears the active pointer, so the public withdrawal GET no longer
  // selects this revision. Observe its retained row without manufacturing revoked.
  const retained = await pool.query(
    "SELECT state, last_reason, completed_at FROM occ.credential_withdrawals WHERE namespace_id = $1 AND agent_id = $2 AND revision_id = $3 AND credential_source_id = $4",
    [namespace.id, agent.id, revision.id, source.id],
  );
  assert.equal(retained.rowCount, 1);
  assert.equal(retained.rows[0].state, withdrawal.state);
  assert.equal(retained.rows[0].last_reason, withdrawal.reason ?? null);
  if (withdrawal.state === "pending") {
    assert.equal(retained.rows[0].completed_at, null);
  }
  await checkpoint("stop-based-withdrawal", {
    sandboxAbsent: true,
    runtimePodsAbsent: true,
    stopOperation: stopped.idempotency_key,
    stopAuditId: audit.rows[0].id,
    stopReason: audit.rows[0].reason_code,
    withdrawalState: retained.rows[0].state,
    withdrawalReason: retained.rows[0].last_reason,
  });
}
