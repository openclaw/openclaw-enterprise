import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.ts";
import { createConsoleFixtureTransport } from "../helpers/console-fixture-transport.ts";
import { selectQaMatrix, validateQaInputs } from "../helpers/qa-selection.mjs";

const selected = process.env.OCC_TEST_QA_MATRIX === "1";

async function verifyGatewayStartupCredentials(f, agent, stopQaAgent) {
  const { registerQaSecret } = await import("../helpers/qa-secrets.ts");
  const base = `/namespaces/${agent.namespaceId}`;
  const variable = "QA_GATEWAY_TOKEN";
  const value = `qa-gateway-${randomUUID()}`;
  registerQaSecret(value);
  const source = await f.api("POST", `${base}/credential-sources`, {
    name: `${agent.name}-gateway`,
    type: "static",
    secret: value,
  });
  const configuration = await f.api("GET", `${base}/configurations/${agent.configurationId}`);
  await f.api("PATCH", `${base}/configurations/${configuration.id}`, {
    values: configuration.values,
    secretBindings: {
      ...configuration.secretBindings,
      [variable]: { source: source.ref, delivery: { type: "env" } },
    },
  });

  // An actor may deploy this Agent and operate its Harness Secret, but may not
  // operate the Gateway Source. The denied deploy must not change the revision.
  const principal = await f.api("POST", `${base}/iam/service-principals`, {});
  const role = await f.api("POST", `${base}/iam/roles`, {
    name: `${agent.name}-deployer`,
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "operate", resourceKind: "agent" },
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
      { action: "operate", resourceKind: "secret" },
      { action: "read", resourceKind: "credential_source" },
    ],
  });
  for (const [resourceKind, resourceId] of [
    ["agent", agent.id],
    ["configuration", configuration.id],
    ["secret", agent.harnessAuth.source.id],
    ["credential_source", source.id],
  ]) {
    await f.api("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: role.id,
      resourceKind,
      resourceId,
    });
  }
  const key = await f.api("POST", "/api/auth/service-keys", {
    namespaceId: agent.namespaceId,
    servicePrincipalId: principal.id,
    name: `gw-${randomUUID().slice(0, 8)}`,
  });
  registerQaSecret(key.key);
  const before = agent.revision.id;
  const denied = await fetch(`${f.apiUrl}${base}/agents/${agent.id}/deploy`, {
    method: "POST",
    headers: { "x-api-key": key.key },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(denied.status, 403);
  const denial = (await denied.json()).error;
  assert.equal(denial?.code, "FORBIDDEN");
  assert.match(denial?.message, /CredentialSource operate/);
  assert.equal((await f.api("GET", `${base}/agents/${agent.id}`)).activeRevisionId, before);
  await f.deployAndWait(agent);
  // OCC IAM delegates the authorized deployer's exact Source-use grant to the
  // Agent in the deployment transaction (RFC-0026).
  const bindings = await f.api("GET", `${base}/iam/access-bindings`);
  const granted = bindings.find(({ id }) => id === `binding_${agent.id}_${source.id}_operate`);
  assert.deepEqual(
    [granted?.subjectId, granted?.resourceKind, granted?.resourceId],
    [agent.servicePrincipalId, "credential_source", source.id],
  );

  const gateway = await f.pod(agent, "gateway");
  const container = gateway.spec.containers.find(({ name }) => name === "gateway");
  const projection = container?.env?.find(({ name }) => name === variable)?.valueFrom?.secretKeyRef;
  assert.ok(projection?.name, "Gateway Pod must reference a staged Kubernetes Secret");
  assert.equal(projection.key, variable);
  const stagedRevision = await f.kubectl(
    "-n",
    gateway.metadata.namespace,
    "get",
    "secret",
    projection.name,
    "-o",
    'go-template={{index .metadata.labels "openclaw.dev/revision"}}',
  );
  assert.equal(stagedRevision.trim(), agent.revision.id);
  const harness = await f.pod(agent, "agent");
  assert.equal(
    harness.spec.containers.some(({ env }) => env?.some(({ name }) => name === variable)),
    false,
    "the dedicated Harness must not receive the Gateway credential",
  );

  // PID 1 is tini. Read only the running native OpenClaw Gateway child's
  // environment, and return only a digest through kubectl.
  const script = String.raw`
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const pids = fs.readdirSync("/proc").filter((pid) => {
      if (!/^\d+$/.test(pid)) { return false; }
      try {
        return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").startsWith("openclaw-gateway");
      } catch {
        return false;
      }
    });
    if (pids.length !== 1) { throw new Error("Expected one running native Gateway process"); }
    const prefix = process.argv[1] + "=";
    const entry = fs.readFileSync("/proc/" + pids[0] + "/environ", "utf8").split("\0").find((item) => item.startsWith(prefix));
    process.stdout.write(entry ? crypto.createHash("sha256").update(entry.slice(prefix.length)).digest("hex") : "missing");
  `;
  const observed = await f.execRole(agent, "gateway", ["node", "-e", script, variable]);
  assert.equal(observed.stdout.trim(), createHash("sha256").update(value).digest("hex"));
  await stopQaAgent(f, agent);
  await f.waitFor(
    "stopped revision Gateway credential Secret removal",
    async () =>
      !(
        await f.kubectl(
          "-n",
          gateway.metadata.namespace,
          "get",
          "secret",
          projection.name,
          "--ignore-not-found",
          "-o",
          "name",
        )
      ).trim(),
  );
  await f.record("gateway-startup-credentials", {
    agentId: agent.id,
    revisionId: agent.revision.id,
    sourceId: source.id,
    nativeGatewayReceivedCredential: true,
    stagedSecretRemoved: true,
  });
}

async function verifyAgentAudit(f, agent) {
  const transport = createConsoleFixtureTransport(f.consoleUrl, f.apiUrl);
  const signIn = (credentials) =>
    signInWithEmailPassword({
      ...credentials,
      origin: f.consoleUrl,
      fetch: transport.fetchThroughLoopback,
      headers: { origin: f.consoleUrl },
    });
  const request = async (session, method, path, expectedStatus, body) => {
    const result = await transport.rawRequest(method, path, {
      headers: authenticatedHeaders(session),
      body,
      timeout: 30_000,
    });
    assert.equal(result.response.status, expectedStatus, `${method} ${path}`);
    return JSON.parse(result.text);
  };
  const base = `/namespaces/${agent.namespaceId}`;
  const agentPath = `${base}/agents/${agent.id}`;
  const auditPath = `${agentPath}/audit-events?limit=100`;
  const admin = await signIn(f.credentials);
  const credentials = { email: `qa-audit-${randomUUID()}@example.test`, password: randomUUID() };
  const { data: reader } = await request(admin, "POST", "/api/auth/accounts", 201, credentials);
  const session = await signIn(credentials);
  // This account must have a direct grant on this Agent to see its audit records.
  await request(session, "GET", auditPath, 403);
  const role = await f.api("POST", `${base}/iam/roles`, {
    name: "qa-agent-audit",
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "read_audit", resourceKind: "agent" },
    ],
  });
  await f.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: reader.principalId,
    roleId: role.id,
    resourceKind: "agent",
    resourceId: agent.id,
  });

  const { meta } = await request(session, "GET", agentPath, 200);
  const { data } = await request(session, "GET", auditPath, 200);
  assert.ok(
    data.events.some(
      (entry) => entry.operationId === "getAgent" && entry.requestId === meta.requestId,
    ),
    "the successful Agent read must have an audit record",
  );
  // Use the request ID returned by the original deployment and match the successful attempt.
  assert.ok(agent.deployRequestId, "the deployment must return its request ID");
  const queued = data.events.find(
    (entry) => entry.event === "work_queued" && entry.requestId === agent.deployRequestId,
  );
  assert.ok(queued?.workId, "the deployment must have a queue record");
  const result = data.events.find(
    (entry) =>
      entry.event === "work_result" &&
      entry.workId === queued.workId &&
      entry.workState === "succeeded",
  );
  assert.ok(result?.attemptId, "the deployment must have a successful worker result");
  assert.ok(
    data.events.some(
      (entry) =>
        entry.event === "work_claimed" &&
        entry.workId === queued.workId &&
        entry.attemptId === result.attemptId,
    ),
    "the result must refer to the claim for this deployment",
  );
}

test(
  "shipped installations: canonical QA matrix",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_QA_MATRIX=1; see docs/testing/ci.md#qa-matrix for authorized credentials.",
    timeout: 14_400_000,
  },
  async (context) => {
    const selection = selectQaMatrix();
    validateQaInputs(selection);
    const { createQaInstallation, prepareQaPluginCatalogs, createQaAgent } =
      await import("../helpers/qa-installation.mjs");
    const { protectedText } = await import("../helpers/qa-secrets.ts");
    const { createQaReport } = await import("../helpers/qa-report.mjs");
    const { createQaBrowser } = await import("../helpers/qa-browser.mjs");
    const { prepareQaRepository, verifyQaRepository, stopQaAgent } =
      await import("../helpers/qa-repository.ts");
    const { verifyQaSlack } = await import("../helpers/qa-slack.mjs");
    const { assertGatewayModelTurn } = await import("../helpers/kubernetes-real.ts");
    const artifacts = process.env.OCC_TEST_QA_ARTIFACTS
      ? resolve(process.env.OCC_TEST_QA_ARTIFACTS)
      : await mkdtemp(join(tmpdir(), "oce-qa-matrix-evidence-"));
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const executionFilters = process.execArgv.filter((argument) =>
      /^--test-(?:name|skip)-pattern(?:=|$)/.test(argument),
    );
    const concurrency = Number(process.env.OCC_TEST_QA_CONCURRENCY ?? "2");
    assert.ok(
      Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4,
      "OCC_TEST_QA_CONCURRENCY must be an integer from 1 to 4",
    );
    const { stage, save } = createQaReport(join(artifacts, "matrix.json"), {
      scope: executionFilters.length > 0 ? "partial:filtered" : selection.scope,
      selection: selection.cells,
      executionFilters,
      concurrency,
      exclusions: [
        ...selection.exclusions,
        ...(selection.linearRead
          ? []
          : ["OpenShell Linear READ requires the explicit openshell-linear-read scenario"]),
        "Embedded OpenClaw Slack: unsupported",
        "OpenClaw Codex-native approvals: not applicable",
      ],
    });
    await save();
    context.diagnostic(`QA evidence: ${artifacts}`);
    for (const exclusion of selection.exclusions) {
      context.diagnostic(`Excluded: ${exclusion}`);
    }
    if (selection.channelUpgrade) {
      await stage(
        context,
        "kubernetes/Codex",
        "one-off channel upgrade through the regular Agent workflow",
        async () => {
          const result = await promisify(execFile)(
            process.execPath,
            [
              "--test",
              "--test-concurrency=1",
              "tests/integration/channel-egress-disabled-helm-real.test.ts",
              "tests/integration/channel-egress-upgrade-helm-real.test.ts",
            ],
            {
              env: {
                ...process.env,
                OCC_TEST_SLACK_LIVE: "1",
                OCC_TEST_CHANNEL_EGRESS_UPGRADE: "1",
              },
              timeout: 1_800_000,
              maxBuffer: 8 * 1024 * 1024,
            },
          );
          assert.match(result.stdout, /(?:skipped|skip) 0/);
          context.diagnostic(result.stdout);
        },
        "channel-egress-upgrade",
      );
    }
    if (selection.nativeRestart) {
      const { arrangeProductionTopology, assertInterruptedGatewayTurnResumes } =
        await import("../helpers/harness-topology-k3d-real.mjs");
      const { boundedTeardown } = await import("../helpers/bounded-teardown.ts");
      await stage(
        context,
        "kubernetes/Codex",
        "native restart continuation and cancellation",
        async () => {
          const { context: topologyContext } = boundedTeardown(context, {
            label: "native restart topology teardown",
          });
          const topology = await arrangeProductionTopology(
            topologyContext,
            "dedicated",
            undefined,
            {
              gatewayPassword: true,
              nativeAdmin: { enabled: true },
            },
          );
          // Reuse the real Agent API workflow, retained volumes and native model turns.
          await assertInterruptedGatewayTurnResumes(topologyContext, topology);
        },
        "native-restart",
      );
    }
    if (selection.namespaceLifecycle) {
      const { verifyQaSandboxPolicy } = await import("../helpers/qa-sandbox-policy.mjs");
      await stage(context, "kubernetes/OpenShell", "Namespace gateway before any Agent", () =>
        verifyQaSandboxPolicy(artifacts, "namespace-lifecycle"),
      );
    }
    if (selection.optionalPluginWithdrawal) {
      const { verifyOpenShellOptionalPluginWithdrawal } =
        await import("../helpers/openshell-optional-plugin-withdrawal.ts");
      await stage(
        context,
        "kubernetes/OpenClaw/OpenShell",
        "optional Slack withdrawal preserves other native bindings and Source custody",
        () => verifyOpenShellOptionalPluginWithdrawal(context),
        "openshell-optional-plugin-withdrawal",
      );
    }
    if (selection.tokenServiceAgent) {
      await stage(
        context,
        "kubernetes/OpenClaw/OpenShell",
        "native Source custody, dedicated model turn, rotation and withdrawal",
        async () => {
          const env = { ...process.env, OCC_TEST_OPENSHELL_TOKEN_SERVICE_AGENT_REAL: "1" };
          // The parent test runner marks its worker with this variable. Passing it to a new
          // node --test process makes Node suppress the child suite as a recursive run.
          delete env.NODE_TEST_CONTEXT;
          const result = await promisify(execFile)(
            process.execPath,
            ["--test", "tests/integration/openshell-token-service-agent-real.test.ts"],
            {
              env,
              timeout: 1_800_000,
              maxBuffer: 8 * 1024 * 1024,
            },
          );
          assert.match(result.stdout, /\btests 1(?:\r?\n|$)/);
          assert.match(result.stdout, /(?:skipped|skip) 0/);
          context.diagnostic(result.stdout);
        },
        "openshell-token-service-agent",
      );
    }
    if (selection.oidcAgentChat) {
      const { runOidcAgentChatScenario } = await import("../helpers/native-admin-browser.mjs");
      await stage(
        context,
        "kubernetes/OpenClaw",
        "OIDC enrollment, returning sign-in, owner setup, real chat and administrative denial",
        () => runOidcAgentChatScenario(context),
        "oidc-agent-chat",
      );
      const { runNativeProfileUpgradeScenario } =
        await import("../helpers/native-profile-upgrade.mjs");
      await stage(
        context,
        "kubernetes/OpenClaw",
        "fixed pre-feature OCE installation upgrades the same retained Agent to delegated native profiles",
        () => runNativeProfileUpgradeScenario(context),
        "oidc-agent-chat-upgrade",
      );
    }
    for (const gitReplacement of [false, true].filter((git) =>
      git ? selection.gitReplacement : selection.providerReplacement,
    )) {
      const { verifyOpenShellProviderReplacement } =
        await import("../helpers/openshell-provider-replacement.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        gitReplacement ? "managed Git replacement" : "managed Provider replacement",
        () => verifyOpenShellProviderReplacement(context, { gitReplacement }),
        gitReplacement ? "openshell-git-replacement" : "openshell-provider-replacement",
      );
    }
    if (selection.templateResources) {
      const inputs = JSON.parse(
        await readFile(process.env.OCC_TEST_OPENSHELL_RESOURCES_INPUT_FILE, "utf8"),
      );
      const { verifyOpenShellTemplateResources } =
        await import("../helpers/openshell-provider-replacement.mjs");
      for (const workspaceMode of ["operator", "managed"]) {
        assert.ok(inputs[workspaceMode], `Select the prepared ${workspaceMode} installation`);
        await stage(
          context,
          `kubernetes/Codex/OpenShell/${workspaceMode}`,
          `${workspaceMode} template sizing, workspace access and real model turn`,
          () => verifyOpenShellTemplateResources(context, inputs[workspaceMode], workspaceMode),
          "openshell-template-resources",
        );
      }
    }
    if (selection.sandboxPolicy) {
      const { verifyQaSandboxPolicy } = await import("../helpers/qa-sandbox-policy.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        "shared Driver configuration and real network enforcement",
        () => verifyQaSandboxPolicy(artifacts),
      );
    }
    if (selection.scratchVolume) {
      const { verifyQaSandboxPolicy } = await import("../helpers/qa-sandbox-policy.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        "admitted scratch and workspace access with invalid claim refusal",
        () => verifyQaSandboxPolicy(artifacts, "scratch-volume"),
        "scratch-volume",
      );
    }
    if (selection.pluginInstall) {
      const { verifyQaSandboxPolicy } = await import("../helpers/qa-sandbox-policy.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        "selected native plugin installation",
        () => verifyQaSandboxPolicy(artifacts, "plugin-install"),
      );
    }
    if (selection.harnessOverrides) {
      const { verifyQaHarnessOverrides } = await import("../helpers/qa-harness-overrides.mjs");
      await stage(
        context,
        "kubernetes/OpenShell",
        "revision-owned model destinations and withdrawal",
        () => verifyQaHarnessOverrides(context, artifacts, selection.presets),
        "harness-overrides",
      );
    }
    if (selection.linearRead) {
      const { verifyOpenShellLinearRead } = await import("../helpers/openshell-linear-read.mjs");
      await stage(
        context,
        "kubernetes/Codex/OpenShell",
        "installed Linear plugin executes a real read",
        () => verifyOpenShellLinearRead(context, artifacts),
        "openshell-linear-read",
      );
    }
    for (const installation of selection.installations.filter((value) =>
      selection.cells.some((cell) => cell.installation === value && cell.scenarios.length > 0),
    )) {
      await context.test(
        `${installation} OCC + Kubernetes compute / Sandbox none`,
        { timeout: 7_000_000 },
        async (installationContext) => {
          const f = await stage(
            installationContext,
            installation,
            "shipped startup, default Namespace, presets and both plugin catalogs",
            async () => {
              const fixture = await createQaInstallation(
                installationContext,
                installation,
                artifacts,
                {
                  repositoryInputs: selection.repository,
                  disableNativeAdmin: selection.cells
                    .filter((cell) => cell.installation === installation)
                    .every((cell) => cell.scenarios.every((scenario) => scenario === "http-chat")),
                },
              );
              if (
                selection.cells.some(
                  (cell) =>
                    cell.installation === installation &&
                    cell.scenarios.includes("gateway-startup-credentials"),
                )
              ) {
                // The Sandbox-none launcher does not select TokenService. Qualify
                // the supported OCC owner on this run-owned installation only.
                fixture.configuration.drivers.token_service = { id: "occ", configuration: {} };
              }
              await prepareQaPluginCatalogs(fixture);
              return fixture;
            },
          );
          const cells = selection.cells.filter(
            (cell) => cell.installation === installation && cell.scenarios.length > 0,
          );
          let browser;
          let repositoryReady;
          if (f && selection.browser) {
            browser = await stage(
              installationContext,
              installation,
              "authenticated console login",
              () =>
                createQaBrowser(f, {
                  themed: cells.some((cell) => cell.scenarios.includes("model-ui")),
                }),
            );
          }
          if (f && selection.repository) {
            repositoryReady = await stage(
              installationContext,
              installation,
              "repository broker setup",
              async () => {
                await prepareQaRepository(f);
                return true;
              },
            );
          }
          for (const selectedCell of cells) {
            const { preset, cell } = selectedCell;
            await installationContext.test(
              `Standard ${preset}`,
              { timeout: 3_000_000 },
              async (cellContext) => {
                const ready = await stage(
                  cellContext,
                  cell,
                  "check preset prerequisites",
                  async () => {
                    assert.ok(f, "blocked by installation startup failure");
                    assert.ok(
                      !f.retained && f.pendingRepositories.size === 0,
                      "blocked by unresolved repository cleanup",
                    );
                    if (selectedCell.scenarios.includes("codex-search-config")) {
                      f.configuration.drivers.compute.configuration.runtime.modelProvider = {
                        protocol: "openai-responses",
                        baseUrl: process.env.OCC_TEST_QA_CODEX_MODEL_BASE_URL,
                      };
                      await f.saveInstallation(f.configuration);
                    }
                    return true;
                  },
                );
                async function runScenario(parent, name, work) {
                  // Keep the preset's overall deadline; a shorter worker deadline
                  // could interrupt cleanup after individually valid stage durations.
                  await parent.test(name, async (scenarioContext) => {
                    const step = (title, action) =>
                      stage(scenarioContext, cell, title, action, name);
                    const suffix = `-${name}`;
                    try {
                      const agent = await step(
                        "preset deployment and supported authentication",
                        async () => {
                          assert.ok(ready, "blocked by preset preparation failure");
                          return createQaAgent(f, preset, browser?.nativeOrigin, suffix, {
                            apiKeyAuth: name === "codex-search-config" || name === "http-chat",
                            httpChat: name === "http-chat",
                          });
                        },
                      );
                      await work(agent, (title, action) =>
                        step(title, async () => {
                          assert.ok(agent, "blocked by Agent deployment failure");
                          return action();
                        }),
                      );
                    } finally {
                      // Include partially provisioned Agents whose deployment threw.
                      // Cleanup belongs to this worker, never another worker's Agent.
                      const owned = f?.agents.find(
                        (agent) => agent.preset === preset && agent.qaScenario === suffix,
                      );
                      if (owned && !owned.stopped) {
                        await step("ordinary Agent cleanup", async () => {
                          try {
                            await stopQaAgent(f, owned);
                          } catch (error) {
                            f.retained = true;
                            throw error;
                          }
                        });
                      }
                    }
                  });
                }
                const scenarios = [
                  [
                    "http-chat",
                    async (agent, step) => {
                      const { verifyQaHttpChat } = await import("../helpers/qa-http-chat.ts");
                      await step("human and service HTTP turns and isolated conversations", () =>
                        verifyQaHttpChat(f, agent),
                      );
                    },
                  ],
                  [
                    "agent-audit",
                    async (agent, step) => {
                      await step("authorized Agent reads and linked deployment audit records", () =>
                        verifyAgentAudit(f, agent),
                      );
                    },
                  ],
                  [
                    "console-secrets",
                    async (agent, step) => {
                      await step(
                        "console Secret lifecycle, Agent references and Namespace deletion blockers",
                        async () => {
                          assert.ok(browser, "blocked by browser setup failure");
                          await browser.verifySecrets(agent);
                          await browser.verifyNamespaceDeletionBlockers(agent);
                        },
                      );
                    },
                  ],
                ];
                if (preset === "OpenClaw") {
                  scenarios.push([
                    "model-ui",
                    async (agent, step) => {
                      // Retain the exact revision's redacted cause before ordinary Agent cleanup.
                      const modelStep = (title, action) =>
                        step(title, () => agent.native.withRuntimeFailureLogs(agent, action));
                      await modelStep(
                        "real model nonce, unauthenticated denial and exact identity",
                        async () => {
                          const gateway = await f.gatewayUrl(agent);
                          try {
                            const nonce = `QA_MODEL_${randomUUID()}`;
                            await assertGatewayModelTurn({
                              gatewayUrl: gateway.url,
                              gatewayPassword: gateway.gatewayPassword,
                              nonce,
                              secrets: [
                                await protectedText(
                                  process.env.OCC_TEST_QA_OPENAI_KEY_FILE,
                                  "model credential",
                                ),
                              ],
                            });
                            assert.equal(
                              (await f.pod(agent, "gateway")).metadata.uid,
                              gateway.pod.metadata.uid,
                            );
                            assert.equal(agent.revision.gatewayManagedMode, true);
                            assert.equal(
                              (
                                await f.api(
                                  "GET",
                                  `/namespaces/${agent.namespaceId}/agents/${agent.id}`,
                                )
                              ).activeRevisionId,
                              agent.revision.id,
                            );
                            await f.record(`${preset}-model`, {
                              agentId: agent.id,
                              revisionId: agent.revision.id,
                              gatewayManagedMode: agent.revision.gatewayManagedMode,
                              podUid: gateway.pod.metadata.uid,
                              nativePodUid: gateway.pod.metadata.uid,
                              images: gateway.pod.status.containerStatuses.map(
                                ({ name, imageID }) => ({
                                  name,
                                  imageID,
                                }),
                              ),
                              nonce,
                              unauthenticatedRejected: true,
                            });
                          } finally {
                            await gateway.close();
                          }
                        },
                      );
                      await step(
                        "embedded configured-provider Secret and real model turn",
                        async () => {
                          // Keep the admitted model and Secret, changing only the logical provider.
                          const values = structuredClone(agent.configuration.values);
                          const selected = values.agents.defaults.model;
                          const primary =
                            typeof selected === "string" ? selected : selected.primary;
                          const id = primary.slice(primary.indexOf("/") + 1);
                          const custom = `configured/${id}`;
                          values.models.providers = {
                            configured: {
                              ...values.models.providers.openai,
                              apiKey: {
                                source: "env",
                                provider: "default",
                                id: "OCE_MODEL_API_KEY",
                              },
                            },
                          };
                          values.agents.defaults.model = custom;
                          values.agents.defaults.models = {
                            [custom]: {
                              ...values.agents.defaults.models[primary],
                              agentRuntime: { id: "openclaw" },
                            },
                          };
                          await f.api(
                            "PATCH",
                            `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`,
                            { values },
                          );
                          await f.deployAndWait(agent);
                          const gateway = await f.gatewayUrl(agent);
                          try {
                            await assertGatewayModelTurn({
                              gatewayUrl: gateway.url,
                              gatewayPassword: gateway.gatewayPassword,
                              nonce: `QA_CUSTOM_${randomUUID()}`,
                              secrets: [
                                await protectedText(
                                  process.env.OCC_TEST_QA_OPENAI_KEY_FILE,
                                  "model credential",
                                ),
                              ],
                            });
                          } finally {
                            await gateway.close();
                          }
                          await f.record("embedded-configured-provider", {
                            agentId: agent.id,
                            revisionId: agent.revision.id,
                            model: custom,
                          });
                        },
                      );
                      await modelStep(
                        "trusted native UI and live WebSocket model response",
                        async () => {
                          assert.ok(browser, "blocked by browser setup failure");
                          await browser.verify(agent);
                        },
                      );
                    },
                  ]);
                } else {
                  scenarios.push(
                    [
                      "gateway-startup-credentials",
                      async (agent, step) => {
                        await step(
                          "Source authorization, native Gateway delivery and revision cleanup",
                          () => verifyGatewayStartupCredentials(f, agent, stopQaAgent),
                        );
                      },
                    ],
                    [
                      "git-write",
                      async (agent, step) => {
                        await step(
                          "native repository clone/edit/commit/push to the granted branch and disposal",
                          async () => {
                            assert.ok(repositoryReady, "blocked by repository setup failure");
                            await verifyQaRepository(f, agent);
                          },
                        );
                      },
                    ],
                    [
                      "codex-search-config",
                      async (agent, step) => {
                        const readConfig = async () =>
                          (
                            await f.execRole(agent, "agent", [
                              "node",
                              "-e",
                              "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(process.env.CODEX_HOME,'config.toml'),'utf8'))",
                            ])
                          ).stdout;
                        let baseline;
                        await step(
                          "installed API-key Agent starts without a search declaration",
                          async () => {
                            baseline = await readConfig();
                            assert.equal(
                              baseline.includes("supports_standalone_web_search"),
                              false,
                            );
                            assert.ok(baseline.includes('model_provider = "openai-compatible"'));
                            assert.equal(agent.harnessAuth.method, "api_key");
                          },
                        );
                        for (const enabled of [false, true]) {
                          await step(
                            `search declaration ${enabled} through supported stop and deploy`,
                            async () => {
                              await stopQaAgent(f, agent);
                              f.configuration.drivers.compute.configuration.runtime.modelProvider.supportsStandaloneWebSearch =
                                enabled;
                              await f.saveInstallation(f.configuration);
                              await f.deployAndWait(agent);
                              const actual = await readConfig();
                              const expected = enabled
                                ? baseline.replace(
                                    "supports_websockets = false\n",
                                    "supports_websockets = false\nsupports_standalone_web_search = true\n",
                                  )
                                : baseline;
                              assert.equal(
                                actual === expected,
                                true,
                                "only the explicit capability declaration changes",
                              );
                            },
                          );
                        }
                        await step(
                          "enabled declaration survives another supported stop and deploy",
                          async () => {
                            const before = await f.pod(agent, "agent");
                            const config = await readConfig();
                            await stopQaAgent(f, agent);
                            await f.deployAndWait(agent);
                            assert.notEqual(
                              (await f.pod(agent, "agent")).metadata.uid,
                              before.metadata.uid,
                            );
                            assert.equal((await readConfig()) === config, true);
                            await f.record("codex-search-config", {
                              agentId: agent.id,
                              revisionId: agent.revision.id,
                              omitted: false,
                              explicitFalse: false,
                              explicitTrue: true,
                              persistedAfterRedeploy: true,
                              proof:
                                "installed user configuration and native startup, not live search",
                            });
                          },
                        );
                      },
                    ],
                    [
                      "git-push-denied",
                      async (agent, step) => {
                        await step(
                          "push outside the granted branch rejected and session disposed",
                          async () => {
                            assert.ok(repositoryReady, "blocked by repository setup failure");
                            await verifyQaRepository(f, agent, "git-push-denied");
                          },
                        );
                      },
                    ],
                  );
                }
                await cellContext.test(
                  "independent agent scenarios",
                  { concurrency },
                  async (workers) => {
                    await Promise.all(
                      scenarios
                        .filter(([name]) => selectedCell.scenarios.includes(name))
                        .map(([name, work]) => runScenario(workers, name, work)),
                    );
                  },
                );
                // Slack changes installation-wide proxy configuration and shares
                // Socket Mode credentials across installations. Join all workers
                // before setup, and disable its consumer before the next cell.
                if (selectedCell.scenarios.includes("slack")) {
                  await runScenario(cellContext, "slack", async (agent, step) => {
                    await step(
                      "single Slack ingress, one threaded reply and native outbound root",
                      () => verifyQaSlack(f, agent),
                    );
                  });
                } else if (preset === "OpenClaw") {
                  cellContext.diagnostic(
                    "Slack and Codex-native approval policy: not applicable to Standard OpenClaw. Linear READ uses its separate OpenShell scenario.",
                  );
                }
              },
            );
          }
        },
      );
    }
    await save();
  },
);
