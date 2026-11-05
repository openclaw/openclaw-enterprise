import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import pg from "pg";
import {
  OpenShellGateway,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createRealKubernetesFixture } from "../helpers/kubernetes-real.mjs";
import {
  assertConnectedResponse,
  serializeConnectedRequest,
  sendConnectedRequest,
  validateConnectedDatabaseUrl,
} from "../helpers/egress-connected-inputs.mjs";
import { codexRepositoryEvidenceScript } from "../helpers/normal-agent-tools.mjs";
import {
  publicBootstrapProgram,
  publicGatewayTurnProgram,
  publicNetworkProgram,
  publicCustodyProgram,
  authenticatedRepositoryProgram,
} from "../helpers/public-egress-workflow.mjs";

const selected =
  process.env.OCC_TEST_PUBLIC_EGRESS === "1" ||
  process.env.OCC_TEST_PUBLIC_EGRESS_INPUTS !== undefined;
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

// Preparation owns real credentials and the production Helm installation.
// This scenario owns only its ordinary Agent.
test(
  "a protected Agent admits public TCP only in its frozen public egress mode",
  {
    skip: !selected,
    timeout: 3_600_000,
  },
  async (t) => {
    const serviceKey = process.env.OCC_TEST_PUBLIC_EGRESS_SERVICE_KEY;
    delete process.env.OCC_TEST_PUBLIC_EGRESS_SERVICE_KEY;
    assert.ok(
      serviceKey && !/\s/u.test(serviceKey),
      "provide the scoped controller key separately",
    );
    const input = JSON.parse(await readFile(process.env.OCC_TEST_PUBLIC_EGRESS_INPUTS, "utf8"));
    assert.equal(input.version, 1);
    const publicTcp = new URL(input.publicTcp?.url);
    assert.equal(publicTcp.protocol, "https:");
    assert.ok(
      publicTcp.port && !["80", "443"].includes(publicTcp.port),
      "provide a controlled public TCP endpoint on a nonstandard port",
    );
    assert.equal(publicTcp.username + publicTcp.password, "");
    assert.match(input.publicTcp.expectedBodySha256, /^[a-f0-9]{64}$/u);
    assert.ok(
      input.custodySecretNames?.length > 0,
      "identify the worker/model custody Secrets to exclude from workloads",
    );
    assert.ok(input.repositoryPermissions && typeof input.repositoryPermissions.pull === "boolean");
    assert.match(input.expectedGitHubAppId, /^[0-9]+$/u);
    assert.match(input.expectedGitHubInstallationId, /^[0-9]+$/u);
    assert.ok(
      input.custodySecretNames.every((name) => typeof name === "string" && name.length > 0),
    );
    assert.ok(
      input.pauseForAcceptance === undefined || typeof input.pauseForAcceptance === "boolean",
    );
    const origin = new URL(input.apiOrigin);
    assert.equal(origin.hostname, "127.0.0.1");
    assert.ok(["http:", "https:"].includes(origin.protocol) && Number(origin.port) > 1024);
    assert.equal(origin.origin, input.apiOrigin);
    for (const name of ["evidenceDirectory", "kubeconfigPath"]) {
      assert.ok(isAbsolute(input[name]));
    }
    assert.match(input.namespaceId, /^ns_[A-Za-z0-9_-]+$/u);
    assert.match(input.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      input.oceCommit,
    );
    assert.deepEqual(Object.keys(input.images).sort(), [
      "agent",
      "controller",
      "gateway",
      "openShellGateway",
      "sandbox",
      "supervisor",
    ]);
    for (const image of Object.values(input.images)) {
      assert.match(image, /@sha256:[a-f0-9]{64}$/u);
    }
    const databaseUrl = validateConnectedDatabaseUrl(process.env.OCC_TEST_DATABASE_URL);
    const f = createRealKubernetesFixture({
      kubeconfigPath: input.kubeconfigPath,
      kubernetesContext: input.kubernetesContext,
      gatewayImage: input.images.gateway,
      codexImage: input.images.agent,
      databaseUrl,
    });
    await f.validatePrerequisites();
    const checkCluster = async () =>
      assert.equal((await f.resource("namespace", "kube-system")).metadata.uid, input.clusterUID);
    await checkCluster();
    const runId = randomUUID();
    await mkdir(input.evidenceDirectory, { recursive: true, mode: 0o700 });
    const save = (name, value) =>
      writeFile(
        join(input.evidenceDirectory, name + ".json"),
        JSON.stringify(value, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    const sourceFiles = [
      "apps/controller/src/drivers/sandbox/openshell.ts",
      "apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
      "apps/controller/src/drivers/egress-proxy/openshell.ts",
      "packages/occ/src/index.ts",
      "apps/controller/src/drivers/credential-gateway/openshell.ts",
      "tests/integration/public-egress-connected.test.mjs",
      "tests/helpers/public-egress-workflow.mjs",
    ];
    const sourceHashes = Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(new URL("../../" + path, import.meta.url)))
            .digest("hex"),
        ]),
      ),
    );
    await save("run", {
      runId,
      oceCommit: input.oceCommit,
      sourceHashes,
      clusterUID: input.clusterUID,
    });
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 10000 });
    const backend = new OpenShellGateway(input.openShellBackend);
    let cleanupAgent = async () => {};
    t.after(async () => {
      try {
        await cleanupAgent();
      } finally {
        backend.close();
        await pool.end();
      }
    });
    const namespacePath = "/namespaces/" + input.namespaceId;
    const api = async (method, path, body, expected = 200) => {
      const response = await sendConnectedRequest(
        { apiOrigin: input.apiOrigin, serviceKey },
        serializeConnectedRequest(method, path, body),
        AbortSignal.timeout(20000),
      );
      const text = await response.text();
      assert.equal(text.includes(serviceKey), false, "the controller must not echo its credential");
      return assertConnectedResponse(
        { status: response.status, body: text ? JSON.parse(text) : undefined },
        expected,
      );
    };
    assert.equal((await api("GET", "/installation")).id, input.installationId);
    assert.equal((await api("GET", namespacePath)).status, "ready");
    const source = await api("GET", namespacePath + "/credential-sources/" + input.modelSourceId);
    assert.equal(source.state, "ready");
    assert.equal(source.ownerCapability, "credential_gateway");
    assert.equal(
      source.egress,
      undefined,
      "this scenario retains the existing Gateway-owned model source",
    );
    const placements = JSON.parse(
      await f.kubectl(
        "get",
        "namespaces",
        "-l",
        "openclaw.dev/namespace=" + input.namespaceId,
        "-o",
        "json",
      ),
    ).items;
    assert.equal(placements.length, 1);
    const placement = placements[0].metadata.name;
    const gateway = backend.clientForNamespace(placement);
    const values = createHarnessConfiguration("codex", input.model);
    const workspace = "/home/node/workspace";
    Object.assign(values.plugins.entries.codex.config.appServer, {
      approvalPolicy: "never",
      sandbox: "workspace-write",
      remoteWorkspaceRoot: workspace,
    });
    values.agents.defaults.workspace = workspace;
    values.tools = { profile: "full" };
    const config = await api(
      "POST",
      namespacePath + "/configurations",
      { kind: "agent", values },
      201,
    );
    const agentName = "public-egress-" + runId;
    let agent;
    let agentPath;
    let active;
    // Cleanup goes through the same owner that issued and enrolled credentials.
    // Namespace/database teardown is forbidden until this ledger reports settled.
    cleanupAgent = async () => {
      await checkCluster();
      if (!agent) {
        const matches = (await api("GET", namespacePath + "/agents")).filter(
          (item) => item.name === agentName,
        );
        assert.ok(matches.length <= 1, "run-owned Agent creation must reconcile uniquely");
        if (matches.length === 0) {
          throw new Error("Agent creation outcome is unconfirmed; retain the prepared environment");
        }
        agent = matches[0];
      }
      agentPath = namespacePath + "/agents/" + agent.id;
      const approvals = await api("GET", agentPath + "/repository-approvals");
      for (const approval of approvals.filter((entry) => entry.status === "active")) {
        await api(
          "POST",
          agentPath + "/repository-approvals/" + approval.id + "/remove",
          { expectedGeneration: approval.generation },
          204,
        );
      }
      await api("DELETE", agentPath, undefined, 202);
      await f.waitFor(
        "owned Agent retirement",
        async () => {
          const pods = await f.resources("pods", placement, "-l", "openclaw.dev/agent=" + agent.id);
          const pending = await pool.query(
            "SELECT 1 FROM occ.repository_session_attempts WHERE namespace_id=$1 AND agent_id=$2 AND phase IN ('opening','open','closing')",
            [input.namespaceId, agent.id],
          );
          return pods.length === 0 && pending.rowCount === 0;
        },
        300000,
      );
      await save("cleanup", { runId, agentId: agent.id, settled: true });
    };
    await save("agent-create-intent", { runId, name: agentName });
    agent = await api(
      "POST",
      namespacePath + "/agents",
      {
        name: agentName,
        configurationId: config.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: input.modelSourceId },
        credentialSources: [{ sourceId: input.modelSourceId }],
        repositoryBindings: [{ repositoryRef: input.repositoryRef, profile: "github-repository" }],
      },
      201,
    );
    agentPath = namespacePath + "/agents/" + agent.id;
    const role = await api(
      "POST",
      namespacePath + "/iam/roles",
      {
        name: "public-egress-model-" + runId,
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      },
      201,
    );
    await api(
      "POST",
      namespacePath + "/iam/access-bindings",
      {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: role.id,
        resourceKind: "credential_source",
        resourceId: input.modelSourceId,
      },
      201,
    );
    await api("POST", agentPath + "/runtime-credentials", {});
    const [scope] = await api("GET", agentPath + "/repository-approval-scopes");
    assert.equal(scope.repositoryRef, input.repositoryRef);
    await api("PATCH", agentPath, {
      configurationId: config.id,
      repositoryStandingApproval: {
        repositoryRef: input.repositoryRef,
        approvalId: runId,
        approved: true,
        duration: "until-removed",
        expectedScopeFingerprint: scope.scopeFingerprint,
      },
    });

    const exec = (pod, container, args, stdin) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          "kubectl",
          [
            "--kubeconfig",
            input.kubeconfigPath,
            "--context",
            input.kubernetesContext,
            "exec",
            "-i",
            "-n",
            pod.metadata.namespace,
            pod.metadata.name,
            "-c",
            container,
            "--",
            ...args,
          ],
          { encoding: "utf8", timeout: 510000, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout) => {
            // execFile errors contain arbitrary process output, including credentials.
            if (error) {
              reject(
                new Error("Public egress workflow process failed; inspect its retained phase"),
              );
            } else {
              resolve(stdout);
            }
          },
        );
        child.stdin.end(stdin);
      });
    const ownedPod = async (roleName) => {
      const pods = await f.resources(
        "pods",
        placement,
        "-l",
        "openclaw.dev/agent=" + agent.id + ",openclaw.dev/workload-role=" + roleName,
      );
      const ready = pods.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      );
      assert.equal(ready.length, 1, "one ready owned " + roleName);
      return ready[0];
    };
    const snapshot = async (revision) => {
      const { rows } = await pool.query(
        "SELECT admitted_spec->'sandbox_policy' AS policy, admitted_spec->'execution_admission' AS execution, admitted_spec->>'network_egress_mode' AS mode FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2 AND id=$3",
        [input.namespaceId, agent.id, revision.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].execution.mode, "protected");
      assert.deepEqual(rows[0].policy.additions, []);
      return { policy: rows[0].policy, mode: rows[0].mode };
    };
    const deploy = async () => {
      const revision = await api("POST", agentPath + "/deploy", undefined, 202);
      await f.waitFor(
        "protected Agent activation",
        async () => {
          const deployment = await api("GET", agentPath + "/deployments/" + revision.id);
          assert.notEqual(deployment.status, "failed", "deployment failed");
          const current = await api("GET", agentPath);
          return deployment.status === "succeeded" && current.activeRevisionId === revision.id;
        },
        720000,
      );
      active = { revision, harness: await ownedPod("agent"), gateway: await ownedPod("gateway") };
      assert.equal(
        active.harness.spec.containers.find((container) => container.name === "agent").image,
        input.images.agent,
      );
      assert.equal(
        active.gateway.spec.containers.find((container) => container.name === "gateway").image,
        input.images.gateway,
      );
      return active;
    };
    const observePolicy = async () => {
      const sandboxes = await f.resources("sandboxes.agents.x-k8s.io", placement);
      const candidates = sandboxes.filter(
        (box) =>
          box.metadata.labels?.["openshell.ai/sandbox-id"] ===
          active.harness.metadata.annotations?.["openshell.ai/sandbox-id"],
      );
      assert.equal(candidates.length, 1);
      const box = candidates[0];
      const name = box.metadata.labels["openshell.ai/sandbox-name"];
      assert.ok(name);
      const selectedSandbox = await gateway.getSandbox(
        { workspace: placement, name },
        AbortSignal.timeout(10000),
      );
      assert.equal(selectedSandbox.id, box.metadata.labels["openshell.ai/sandbox-id"]);
      const supervisors = await f.resources(
        "pods",
        placement,
        "-l",
        "openshell.ai/boundary-role=supervisor,openshell.ai/boundary-pair=" +
          selectedSandbox.id.toLowerCase(),
      );
      assert.equal(supervisors.length, 1);
      assert.equal(
        supervisors[0].spec.containers.find((container) => container.name === "supervisor").image,
        input.images.supervisor,
      );
      const policy = await gateway.getSandboxPolicyStatus(
        placement,
        name,
        AbortSignal.timeout(10000),
      );
      assert.equal(policy.revision.version, policy.active_version);
      assert.equal(policy.revision.status, "POLICY_STATUS_LOADED");
      const config = await gateway.getSandboxConfig(placement, name, AbortSignal.timeout(10000));
      const current = await gateway.getSandbox(
        { workspace: placement, name },
        AbortSignal.timeout(10000),
      );
      assert.equal(current.id, selectedSandbox.id);
      const admission = current.configurationAdmission;
      assert.equal(admission?.state, 2, "the current supervisor configuration must be accepted");
      assert.ok(!admission.error);
      assert.ok(admission.instance_id && admission.policy_hash);
      assert.equal(
        typeof admission.applied_allow_unconfigured_public_tcp,
        "boolean",
        "require the supervisor's actual applied bit",
      );
      assert.equal(config.configuration_admitted, true);
      assert.equal(config.configuration_instance_id, admission.instance_id);
      assert.equal(config.version, admission.policy_version);
      assert.equal(config.policy_hash, admission.policy_hash);
      assert.equal(config.config_revision, admission.config_revision);
      assert.equal(config.provider_env_revision, admission.provider_env_revision);
      assert.equal(policy.active_version, admission.policy_version);
      assert.equal(policy.revision.policy_hash, admission.policy_hash);
      assert.equal(
        config.policy.allow_unconfigured_public_tcp ?? false,
        admission.applied_allow_unconfigured_public_tcp,
      );
      assert.ok(current.mainProcessInstanceId, "the active workload must have a process identity");
      assert.ok(Number.isFinite(Date.parse(current.mainProcessStartedAt)));
      // The Git recipient binds the workload's network instance, while the
      // configuration admission identifies the supervisor configuration.
      active.mainProcessInstanceId = current.mainProcessInstanceId;
      return {
        policy: config.policy,
        appliedPublicTcp: admission.applied_allow_unconfigured_public_tcp,
        configurationAdmission: admission,
        mainProcessInstanceId: current.mainProcessInstanceId,
        mainProcessStartedAt: current.mainProcessStartedAt,
        sandbox: { name, id: selectedSandbox.id },
        supervisor: { name: supervisors[0].metadata.name, uid: supervisors[0].metadata.uid },
      };
    };

    const command = async (label, argv, verify) => {
      const nonce = "PUBLIC_EGRESS_" + randomUUID();
      const text = argv.map(shellQuote).join(" ");
      const pods = await f.resources(
        "pods",
        input.controllerNamespace,
        "-l",
        input.controllerSelector,
      );
      const candidates = pods.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.status.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      );
      assert.equal(candidates.length, 1);
      const apiPod = candidates[0];
      assert.equal(
        apiPod.spec.containers.find((container) => container.name === "api").image,
        input.images.controller,
      );
      await save(label + "-intent", {
        runId,
        revisionId: active.revision.id,
        nonce,
        commandSha256: createHash("sha256").update(text).digest("hex"),
      });
      const result = JSON.parse(
        await exec(
          apiPod,
          "api",
          ["node", "-e", publicGatewayTurnProgram],
          JSON.stringify({
            namespaceId: input.namespaceId,
            agentId: agent.id,
            nonce,
            prompt: `Use the shell tool once, with cwd ${workspace}, to run exactly this command: ${text}\nDo not change or retry it. Reply with ${nonce}.`,
          }),
        ),
      );
      const evidence = JSON.parse(
        await exec(active.gateway, "gateway", [
          "node",
          "-e",
          codexRepositoryEvidenceScript,
          nonce,
          JSON.stringify([{ operation: label, workdir: workspace, argv }]),
        ]),
      );
      assert.equal(evidence.status, "completed");
      const matching = evidence.commands.filter((entry) => entry.operations.includes(label));
      assert.equal(matching.length, 1, "exactly one execution of the requested command");
      assert.equal(matching[0].status, "completed");
      assert.equal(matching[0].exitCode, 0);
      await verify?.(matching[0]);
      await save(label + "-turn", { result, evidence });
    };
    const bootstrap = async (label, allowed) => {
      const nonce = randomUUID();
      const receipt = "/tmp/package-receipt-" + nonce + ".json";
      const { packageManager } = JSON.parse(
        await readFile(new URL("../../package.json", import.meta.url), "utf8"),
      );
      assert.match(packageManager, /^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]{128}$/u);
      await command(label, [
        "/usr/local/bin/node",
        "-e",
        `eval(${JSON.stringify(publicBootstrapProgram({ packageManager, receipt, nonce }))})`,
      ]);
      const report = JSON.parse(
        await exec(active.harness, "agent", [
          "node",
          "-e",
          "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))",
          receipt,
        ]),
      );
      assert.equal(report.nonce, nonce);
      assert.equal(report.initiallyEmpty, true);
      assert.equal(report.executable, "/usr/local/bin/node");
      assert.equal(report.signal, null);
      if (allowed) {
        assert.equal(report.exitCode, 0);
        assert.equal(report.version, packageManager.split("@")[1].split("+")[0]);
        assert.equal(report.integrityFailure, false);
      } else {
        assert.notEqual(report.exitCode, 0);
        assert.equal(report.connectDenied, true);
      }
      await save(label + "-receipt", report);
    };
    const uses = async () =>
      (
        await pool.query(
          `SELECT u.exchange_id, u.operation, u.recipient_fence,
            (a.admission #>> '{grant,appId}' = $5 AND
             a.admission #>> '{grant,installationId}' = $6) AS expected_principal,
            EXISTS (SELECT 1 FROM occ.credential_deliveries d
              JOIN occ.egress_installations e
                ON (e.namespace_id,e.agent_id,e.revision_id)=(d.namespace_id,d.agent_id,d.revision_id)
              WHERE (d.namespace_id,d.agent_id,d.live_revision_id)=($1,$2,$3)
                AND d.fence=u.recipient_fence AND d.preparation_attempt_id=u.attempt_id
                AND d.material_version=u.material_version AND d.blocked IS NULL
                AND d.write_pending IS NULL AND d.settlement='witness'
                AND d.target->>'transport'='registered-repository-git/v1'
                AND d.target->'installation'=e.installation
                AND d.binding_id=e.installation #>> '{plan,execution,executionId}'
                AND e.sandbox_id=$7 AND e.installation #>> '{enforcement,instanceId}'=$8
                AND e.installation #>> '{enforcement,repositoryGitRecipient,networkInstanceId}'=$8
            ) AS current_recipient
          FROM occ.prepared_repository_git_uses u
          JOIN occ.repository_session_attempts s USING (admission_id)
          JOIN occ.prepared_github_attempts a ON a.id=u.attempt_id AND a.material_version=u.material_version
          WHERE s.namespace_id=$1 AND s.agent_id=$2 AND s.live_revision_id=$3 AND s.repository_ref=$4`,
          [
            input.namespaceId,
            agent.id,
            active.revision.id,
            input.repositoryRef,
            input.expectedGitHubAppId,
            input.expectedGitHubInstallationId,
            active.harness.metadata.annotations["openshell.ai/sandbox-id"],
            active.mainProcessInstanceId,
          ],
        )
      ).rows;
    const gitReads = async (phase) => {
      const prior = new Set((await uses()).map((use) => use.exchange_id));
      await command(phase + "-git", [
        "git",
        "ls-remote",
        "--exit-code",
        "https://github.com/" + input.repository + ".git",
        "HEAD",
      ]);
      const gitUses = (await uses()).filter((use) => !prior.has(use.exchange_id));
      assert.ok(
        gitUses.some(
          (use) =>
            use.operation === "advertise-upload-pack" &&
            use.expected_principal &&
            use.current_recipient,
        ),
        "a new protected Git credential use must accompany the read",
      );
      const beforeApi = new Set((await uses()).map((use) => use.exchange_id));
      const receipt = "/tmp/repository-auth-" + randomUUID() + ".json";
      await command(phase + "-gh", [
        "/usr/local/bin/node",
        "-e",
        `eval(${JSON.stringify(authenticatedRepositoryProgram({ repository: input.repository, permissions: input.repositoryPermissions, receipt }))})`,
      ]);
      const auth = JSON.parse(await exec(active.harness, "agent", ["cat", receipt]));
      assert.equal(
        auth.authenticatedPermissions,
        true,
        "anonymous public metadata is not authenticated GitHub evidence",
      );
      const apiUses = (await uses()).filter((use) => !beforeApi.has(use.exchange_id));
      assert.ok(
        apiUses.some(
          (use) =>
            use.operation === "github-rest" &&
            Number(use.recipient_fence) > 0 &&
            use.expected_principal &&
            use.current_recipient,
        ),
        "the authenticated read must create a new protected API credential use",
      );
      await save(phase + "-credential-use", { gitUses, apiUses, auth });
    };
    const custody = async (phase) => {
      const pods = await f.resources("pods", placement, "-l", "openclaw.dev/agent=" + agent.id);
      assert.ok(pods.some((pod) => pod.metadata.uid === active.harness.metadata.uid));
      const noCustodySecretReferences = pods.every((pod) =>
        input.custodySecretNames.every(
          (name) => !JSON.stringify(pod.spec).includes(JSON.stringify(name)),
        ),
      );
      assert.equal(
        noCustodySecretReferences,
        true,
        "Agent Pods must not reference model/App/custody Secrets",
      );
      const report = JSON.parse(
        await exec(active.harness, "agent", ["node", "-e", publicCustodyProgram]),
      );
      assert.equal(report.nativeAuthPresent, true);
      assert.equal(report.nativeAuthOpaque, true);
      assert.equal(report.providerEnvironmentOpaque, true);
      assert.equal(report.refreshMaterialAbsent, true);
      assert.equal(report.privateKeyAbsent, true);
      await save(phase + "-custody", { noCustodySecretReferences, ...report });
    };
    const managedHosts = (profile, policy) => {
      const modelEndpoints = profile.definition.endpoints;
      assert.ok(modelEndpoints.length > 0);
      assert.ok(
        modelEndpoints.every(
          (endpoint) =>
            typeof endpoint.host === "string" &&
            endpoint.host.length > 0 &&
            !endpoint.host.includes("*") &&
            endpoint.port !== 8443 &&
            !(endpoint.ports ?? []).includes(8443),
        ),
      );
      const gitHosts = policy.network_middlewares?.["oce-prepared-git"]?.endpoints?.include;
      assert.ok(
        Array.isArray(gitHosts),
        "the installed policy must carry the protected Git middleware",
      );
      assert.deepEqual([...gitHosts].sort(), ["api.github.com", "github.com"]);
      return [...new Set([...modelEndpoints.map((endpoint) => endpoint.host), ...gitHosts])].sort();
    };
    const network = async (phase, allowed, hosts) => {
      const nonce = randomUUID();
      const receipt = "/tmp/public-network-" + nonce + ".json";
      await command(phase + "-network", [
        "/usr/local/bin/node",
        "-e",
        `eval(${JSON.stringify(publicNetworkProgram({ nonce, receipt, publicTcp: input.publicTcp, managedHosts: hosts }))})`,
      ]);
      const report = JSON.parse(await exec(active.harness, "agent", ["cat", receipt]));
      assert.equal(report.nonce, nonce);
      for (const result of report.publicReads) {
        if (allowed) {
          assert.equal(result.status, 200);
        } else {
          assert.equal(result.code, "EACCES");
        }
      }
      if (allowed) {
        assert.equal(report.publicReads[2].bodySha256, input.publicTcp.expectedBodySha256);
      }
      assert.deepEqual(
        report.managedPorts.map((result) => result.host),
        hosts,
      );
      for (const result of report.managedPorts) {
        assert.equal(result.code, "EACCES", "managed hosts remain reserved on undeclared ports");
      }
      await save(phase + "-network", report);
    };
    const awaitPreparation = async (file, expected, timeout = 1200000) =>
      f.waitFor(
        file,
        async () => {
          let value;
          try {
            value = JSON.parse(
              await readFile(join(input.evidenceDirectory, file + ".json"), "utf8"),
            );
          } catch (error) {
            if (error.code === "ENOENT") {
              return false;
            }
            throw error;
          }
          for (const [key, wanted] of Object.entries(expected)) {
            assert.equal(value[key], wanted);
          }
          return value;
        },
        timeout,
      );

    await deploy();
    const baseline = active.revision;
    const before = await snapshot(baseline);
    assert.equal(before.mode, "restricted");
    const baselinePolicy = await observePolicy();
    assert.equal(baselinePolicy.appliedPublicTcp, false);
    const profileBefore = await gateway.getProviderProfile(
      placement,
      openShellProviderName(input.modelSourceId),
      AbortSignal.timeout(10000),
    );
    assert.ok(profileBefore?.definition, "the model Provider profile must exist");
    assert.ok(profileBefore.definition.endpoints?.length > 0);
    await gitReads("restricted");
    await custody("restricted");
    const restrictedHosts = managedHosts(profileBefore, baselinePolicy.policy);
    await network("restricted", false, restrictedHosts);
    await bootstrap("restricted-bootstrap", false);
    const handshake = { runId, agentId: agent.id, baselineRevisionId: baseline.id };
    await save("baseline-ready", handshake);
    t.diagnostic("baseline-ready " + input.evidenceDirectory);
    await awaitPreparation("successor-ready", handshake);
    assert.deepEqual(
      await snapshot(baseline),
      before,
      "Installation changes cannot alter admitted egress mode",
    );
    await network("retained-restricted", false, restrictedHosts);
    await deploy();
    assert.notEqual(active.revision.id, baseline.id);
    const after = await snapshot(active.revision);
    assert.equal(after.mode, "public");
    const observed = await observePolicy();
    assert.equal(
      observed.appliedPublicTcp,
      true,
      "require the actual applied bit, not requested source",
    );
    const profileAfter = await gateway.getProviderProfile(
      placement,
      openShellProviderName(input.modelSourceId),
      AbortSignal.timeout(10000),
    );
    assert.ok(profileAfter?.definition, "the model Provider profile must remain installed");
    assert.deepEqual(profileAfter, profileBefore);
    await network("public", true, managedHosts(profileAfter, observed.policy));
    await bootstrap("public-bootstrap", true);
    await gitReads("public");
    await custody("public");
    await save("public-egress-ready", {
      ...handshake,
      revisionId: active.revision.id,
      snapshot: after,
      requestedPolicy: observed.policy,
      configurationAdmission: observed.configurationAdmission,
      mainProcessInstanceId: observed.mainProcessInstanceId,
      mainProcessStartedAt: observed.mainProcessStartedAt,
      appliedPublicTcp: observed.appliedPublicTcp,
    });
    if (input.pauseForAcceptance) {
      await awaitPreparation(
        "acceptance-complete",
        { ...handshake, revisionId: active.revision.id },
        1_800_000,
      );
    }
    await save("complete", {
      ...handshake,
      revisionId: active.revision.id,
      publicTcp: true,
      restrictedControl: true,
      managedPortsReserved: true,
      authenticatedRepositoryRead: true,
      freshCredentialUse: true,
      custodyShapeInspected: true,
      syntheticCanaryProof: false,
    });
  },
);
