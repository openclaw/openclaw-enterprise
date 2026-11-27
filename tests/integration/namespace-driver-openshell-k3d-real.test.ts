import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import Type from "typebox";
import { Check } from "typebox/value";
import { asRecord } from "../../packages/utils/src/index.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { boundedTeardown } from "../helpers/bounded-teardown.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.ts";
import { waitForOpenShellRevisionActivation } from "../helpers/openshell-kubernetes-real.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createOpenShellNamespaceLifecycle } from "../helpers/openshell-namespace-lifecycle.ts";
import { redactedQaTail } from "../helpers/qa-secrets.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const selected = process.env.OCC_TEST_NAMESPACE_OPENSHELL_REAL === "1";

const podView = Type.Object({
  metadata: Type.Object({
    name: Type.String(),
    namespace: Type.Optional(Type.String()),
    labels: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
  spec: Type.Object({
    serviceAccountName: Type.Optional(Type.String()),
    containers: Type.Array(
      Type.Object({
        name: Type.String(),
        image: Type.String(),
        env: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              value: Type.Optional(Type.String()),
            }),
          ),
        ),
      }),
    ),
  }),
  status: Type.Optional(
    Type.Object({
      conditions: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.String(),
            status: Type.String(),
          }),
        ),
      ),
    }),
  ),
});

function observedPod(value: unknown) {
  assert.ok(Check(podView, value), "expected a Pod with container details");
  return value;
}

function metadata(value: unknown) {
  const observed = asRecord(asRecord(value)?.metadata);
  assert.ok(observed, "expected Kubernetes resource metadata");
  return observed;
}

test(
  "bootstrap reconciles OpenShell gateways and Workspaces before any Agent, then runs Agents in both Namespaces",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_NAMESPACE_OPENSHELL_REAL=1 with prepared disposable OpenShell infrastructure.",
    timeout: 2_400_000,
  },
  async (testContext) => {
    const { context } = boundedTeardown(testContext, { label: "Namespace lifecycle bootstrap" });
    const env = process.env;
    assert.ok(env.OPENAI_API_KEY, "the live Agent proof requires an authorized model credential");
    assert.ok(
      env.OCC_TEST_OPENAI_MODEL,
      "the live Agent proof requires an explicitly selected model",
    );
    const lifecycle = await createOpenShellNamespaceLifecycle(context);
    let { app, request, worker } = lifecycle;
    context.after(() => app.close());
    context.after(() => worker.stop());
    await worker.start();
    const {
      fixture,
      startupPath,
      configuration,
      originalQuota,
      templates,
      apiDiagnostic,
      loadDrivers,
      startApi,
      startWorker,
      prepareNamespace,
      connected,
      placements,
      service,
      initial,
      pool,
      namespaceOutcomes,
      credentials,
      authBaseURL,
      workspaceGateway,
      gatewayEndpointPort,
      environment,
      authSecret,
      sandboxAccount,
      drivers,
      modelBaseUrl,
    } = lifecycle;

    const resourceMetadata = async (kind: string, name: string, namespace?: string) =>
      metadata(await fixture.resource(kind, name, namespace));
    const observedPods = async (namespace: string) => {
      const pods = await fixture.resources("pods", namespace);
      assert.ok(pods, "expected a Pod list");
      return pods.map(observedPod);
    };
    const ready = async (id: string) => {
      const placement = await prepareNamespace(id);
      if (id === initial[0].id) {
        // Zero replicas makes real gateway readiness pending. Interrupt the worker, repair
        // configuration, and let a successor resume queued work without replacing its key.
        await fixture.waitFor("Driver-created gateway Service", () =>
          fixture.maybeResource("service", service, placement),
        );
        assert.equal((await request("GET", `/namespaces/${id}`)).data.status, "provisioning");
        assert.equal(
          (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
          0,
        );
        const signingKey = await resourceMetadata("secret", `${service}-jwt-keys`, placement);
        await worker.stop();
        for (const object of templates) {
          if (object.kind === "Deployment" || object.kind === "StatefulSet") {
            object.spec.replicas = 1;
          }
        }
        await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
        // The gateway templates contribute to the Sandbox registration. The API must admit
        // Agent revisions against the same repaired configuration as the successor worker.
        await app.close();
        app = await startApi(await loadDrivers(true));
        request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
        worker = startWorker(await loadDrivers());
        await worker.start();
        assert.equal(
          (await resourceMetadata("secret", `${service}-jwt-keys`, placement)).uid,
          signingKey.uid,
        );
      }
      await fixture.waitFor(
        "all Namespace participants complete",
        async () => {
          const observed = await request("GET", `/namespaces/${id}`);
          assert.equal(observed.status, 200);
          assert.notEqual(observed.data.status, "failed", JSON.stringify(namespaceOutcomes));
          return observed.data.status === "ready" ? true : undefined;
        },
        300_000,
      );
      assert.equal(
        (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
        0,
        "both gateway and Workspace must precede every Agent",
      );
      const serviceResource = await resourceMetadata("service", service, placement);
      assert.equal(asRecord(serviceResource.labels)?.["openclaw.dev/namespace"], id);
      const pods = await observedPods(placement);
      assert.ok(
        pods.some(
          (pod) =>
            pod.metadata.labels?.["app.kubernetes.io/instance"] === service &&
            pod.metadata.labels?.["openclaw.dev/namespace"] === id &&
            pod.metadata.labels?.["openclaw.dev/namespace-gateway"] === "true" &&
            pod.spec.containers.some(({ image }) =>
              image.endsWith(`@${env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE!.split("@")[1]}`),
            ) &&
            pod.status?.conditions?.some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            ),
        ),
      );
      const { client } = await connected(placement);
      await client.health(AbortSignal.timeout(10_000));
      const workspace = await client.getWorkspace(placement, AbortSignal.timeout(10_000));
      assert.ok(workspace);
      assert.equal(workspace.labels["openclaw.dev/namespace-id"], id);
      return placement;
    };
    await ready(initial[0].id);
    testContext.diagnostic(
      "OpenShell Namespace proof: default gateway and Workspace ready with zero persisted Agents",
    );
    const later = await request("POST", "/namespaces", { name: "later" });
    assert.equal(later.status, 201);
    assert.notEqual(await ready(later.data.id), kubernetesNamespaceName(initial[0].id));
    testContext.diagnostic(
      "OpenShell Namespace proof: later gateway and Workspace ready with zero persisted Agents",
    );

    // Only now create Agents: both persisted zero-Agent checkpoints above have already proved
    // the shipped Namespace worker created healthy gateways and owned Workspaces independently.
    const proveAgent = async (namespaceId: string, name: string) => {
      const placement = kubernetesNamespaceName(namespaceId);
      const { client: provider } = await connected(placement);
      const workspaceBefore = await provider.getWorkspace(placement, AbortSignal.timeout(10_000));
      const source = await request("POST", `/namespaces/${namespaceId}/credential-sources`, {
        name: "model-source",
        type: "static",
        config: { provider_preset: "openai" },
        secret: env.OPENAI_API_KEY,
      });
      assert.equal(source.status, 201, `${JSON.stringify(source.error)} ${apiDiagnostic()}`);
      assert.equal(source.data.state, "ready");
      assert.equal(JSON.stringify(source).includes(env.OPENAI_API_KEY!), false);
      const base = createHarnessConfiguration(
        "openclaw",
        env.OCC_TEST_OPENAI_MODEL!.replace(/^openai\//u, ""),
      );
      assert.ok(base.models.providers.openai);
      const native = {
        ...base,
        models: {
          providers: {
            openai: {
              ...base.models.providers.openai,
              baseUrl: modelBaseUrl,
              apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" },
            },
          },
        },
        secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
        gateway: {
          ...base.gateway,
          ...workspaceGateway.nativeOptions.gatewayAuth,
          auth: {
            ...workspaceGateway.nativeOptions.gatewayAuth.auth,
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
        },
      };
      const agentConfiguration = await request(
        "POST",
        `/namespaces/${namespaceId}/configurations`,
        {
          kind: "agent",
          values: native,
        },
      );
      assert.equal(agentConfiguration.status, 201, JSON.stringify(agentConfiguration.error));
      const agent = await request("POST", `/namespaces/${namespaceId}/agents`, {
        name: "namespace-lifecycle-agent",
        configurationId: agentConfiguration.data.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: source.data.id },
        credentialSources: [{ sourceId: source.data.id }],
      });
      assert.equal(agent.status, 201, JSON.stringify(agent.error));
      const path = `/namespaces/${namespaceId}/agents/${agent.data.id}`;
      const credentials = await request("POST", `${path}/runtime-credentials`, {});
      assert.equal(credentials.status, 200, JSON.stringify(credentials.error));
      assert.equal(credentials.data.transportConfigured, true);
      // The normal Agent principal needs permission on its exact source, not on the Secret.
      const role = await request("POST", `/namespaces/${namespaceId}/iam/roles`, {
        name: "Exact model source operate",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      });
      assert.equal(role.status, 201, JSON.stringify(role.error));
      const binding = await request("POST", `/namespaces/${namespaceId}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: agent.data.servicePrincipalId,
        roleId: role.data.id,
        resourceKind: "credential_source",
        resourceId: source.data.id,
      });
      assert.equal(binding.status, 201, JSON.stringify(binding.error));
      const deployed = await request("POST", `${path}/deploy`);
      assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
      assert.equal(deployed.data.harness.mode, "dedicated");
      assert.equal(deployed.data.harness.id, "openclaw");
      assert.deepEqual(deployed.data.harnessAuth, agent.data.harnessAuth);
      try {
        await waitForOpenShellRevisionActivation(fixture.waitFor, {
          request,
          agentPath: path,
          revisionId: deployed.data.id,
        });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : "Agent activation failed"} ${apiDiagnostic()}`,
          { cause: error },
        );
      }
      const sandbox = await fixture.waitForSandbox(placement, deployed.data);
      const harness = observedPod(
        await fixture.waitForProviderHarnessPod(placement, deployed.data),
      );
      assert.equal(harness.metadata.namespace, placement);
      assert.equal(harness.spec.serviceAccountName, sandboxAccount);
      // The authorized gateway-configured identity uses the maintained launcher's Namespace account.
      await fixture.assertProviderOwnedHarness(
        placement,
        deployed.data,
        sandbox,
        harness,
        "maintainedLauncher",
      );
      const workspaceAfter = await provider.getWorkspace(placement, AbortSignal.timeout(10_000));
      assert.ok(workspaceBefore);
      assert.ok(workspaceAfter);
      assert.equal(workspaceAfter.name, workspaceBefore.name);
      assert.equal(
        workspaceAfter.id,
        workspaceBefore.id,
        "Agent deployment must reuse the Workspace created by Namespace reconciliation",
      );
      assert.deepEqual(workspaceAfter.labels, workspaceBefore.labels);
      // Enrollment updates the Gateway Pod template. Wait for its replacement to carry
      // the node ID before comparing that ID with the live Gateway's connection.
      const workspaceNodeId = await fixture.waitFor(
        "the revision's single Gateway Pod with its enrolled node ID",
        async () => {
          const gatewayPods = (await observedPods(placement)).filter(
            (pod) =>
              pod.metadata.labels?.["openclaw.dev/agent"] === agent.data.id &&
              pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
          );
          const [gatewayPod] = gatewayPods;
          if (gatewayPods.length !== 1 || !gatewayPod) {
            return undefined;
          }
          assert.equal(gatewayPod.metadata.labels?.["openclaw.dev/namespace"], namespaceId);
          assert.equal(gatewayPod.metadata.labels?.["openclaw.dev/revision"], deployed.data.id);
          const gateway = gatewayPod.spec.containers.find(
            (container) => container.name === "gateway",
          );
          return (
            gateway?.env?.find((entry) => entry.name === "OPENCLAW_WORKSPACE_NODE_ID")?.value ||
            undefined
          );
        },
        120_000,
      );
      const { GatewayClient } = await import(require.resolve("@openclaw/gateway-client"));
      const hello = Promise.withResolvers();
      const client = new GatewayClient({
        url: `wss://${workspaceGateway.routing.hostname}:${gatewayEndpointPort}${path}`,
        edgeAuthHeaders: { "x-api-key": workspaceGateway.apiKey },
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        scopes: [],
        deviceIdentity: null,
        onHelloOk: hello.resolve,
        onConnectError: (error: { code?: string; details?: { httpStatus?: number } }) => {
          // The real client retries startup admission; authentication refusals still fail immediately.
          if (error.code === "UNAVAILABLE" && error.details?.httpStatus === 503) {
            return;
          }
          hello.reject(error);
        },
      });
      const timeout = setTimeout(
        () => hello.reject(new Error("Agent gateway connection timed out")),
        120_000,
      );
      try {
        client.start();
        await hello.promise;
        // Runtime Pod readiness precedes native node enrollment. Use the live Gateway contract
        // to wait for this revision's exact paired node before exercising its remote workspace.
        await fixture.waitFor(
          "the revision's native workspace node connection",
          async () => {
            const { nodes } = await client.request("node.list", {});
            return nodes.some(
              (node: { nodeId: string; paired: boolean; connected: boolean }) =>
                node.nodeId === workspaceNodeId && node.paired && node.connected,
            )
              ? true
              : undefined;
          },
          120_000,
        );
        const nonce = `namespace-proof-${randomUUID()}`;
        const sessionKey = `agent:main:${nonce}`;
        const turn = {
          sessionKey,
          idempotencyKey: randomUUID(),
          message: `Reply with exactly this nonce and no other text: ${nonce}`,
        };
        // A paired worker can be visible before the Gateway admits chat. Retry only the
        // Gateway's explicit startup refusal and keep the same turn identity.
        const sent = await fixture.waitFor("Gateway chat admission", async () => {
          try {
            return await client.request("chat.send", turn);
          } catch (error) {
            const failure = asRecord(error);
            if (
              failure?.gatewayCode === "UNAVAILABLE" &&
              failure.retryable === true &&
              asRecord(failure.details)?.reason === "startup-sidecars"
            ) {
              return undefined;
            }
            throw error;
          }
        });
        await fixture.waitFor(
          "real Agent model turn completion",
          async () => {
            const outcome = await client.request("agent.wait", {
              runId: sent.runId,
              timeoutMs: 3_000,
            });
            if (["pending", "timeout"].includes(outcome.status) && outcome.endedAt === undefined) {
              return undefined;
            }
            assert.equal(
              outcome.status,
              "ok",
              `the real provider-backed Agent run must succeed: ${redactedQaTail(
                JSON.stringify(outcome),
                {
                  ...environment,
                  AUTH_SECRET: authSecret,
                  BOOTSTRAP_PASSWORD: credentials.password,
                  GATEWAY_API_KEY: workspaceGateway.apiKey,
                },
                { lines: 4, lineChars: 2000 },
              ).join("\n")}`,
            );
            return true;
          },
          600_000,
        );
        const history = await client.request("chat.history", { sessionKey, limit: 20 });
        assert.ok(
          history.messages.some(
            (message: { role: string; content: string | { type: string; text?: string }[] }) =>
              message.role === "assistant" &&
              (typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
              ).includes(nonce),
          ),
          "the real model must return the unique nonce",
        );
      } catch (error) {
        const pods = await observedPods(placement);
        const messages: string[] = [];
        for (const pod of pods.filter(
          (pod) =>
            pod.metadata.labels?.["openclaw.dev/agent"] === agent.data.id &&
            pod.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
        )) {
          const logs = String(
            await fixture
              .kubectl(
                "logs",
                pod.metadata.name,
                "--namespace",
                placement,
                "--container",
                "gateway",
                "--tail=150",
              )
              .catch(() => "unavailable"),
          );
          messages.push(
            ...logs
              .split("\n")
              .filter((line) =>
                /unauthor|forbidden|denied|admission|origin|proxy|error|failed/iu.test(line),
              )
              .slice(-16),
          );
        }
        // eslint-disable-next-line preserve-caught-error -- Raw gateway responses may contain credentials; retain only the redacted diagnostic.
        throw new Error(
          redactedQaTail(
            `${error instanceof Error ? error.message : "Agent model turn failed"}\n${messages.join("\n")}`,
            {
              ...environment,
              AUTH_SECRET: authSecret,
              BOOTSTRAP_PASSWORD: credentials.password,
              GATEWAY_API_KEY: workspaceGateway.apiKey,
            },
            { lines: 18, lineChars: 900 },
          )
            .join("\n")
            .replace(/[A-Za-z0-9_+/.=-]{40,}/g, "[opaque]"),
        );
      } finally {
        clearTimeout(timeout);
        await client.stopAndWait();
      }
      // Teardown goes through the regular Agent operation before Namespace cleanup can run.
      assert.equal((await request("DELETE", path)).status, 202);
      await fixture.waitFor(
        "Agent deletion",
        async () => ((await request("GET", path)).status === 404 ? true : undefined),
        120_000,
      );
      // Namespace deletion requires each independent resource owner to finish its cleanup.
      for (const resource of [
        `credential-sources/${source.data.id}`,
        `configurations/${agentConfiguration.data.id}`,
      ]) {
        const removed = await request("DELETE", `/namespaces/${namespaceId}/${resource}`);
        assert.equal(removed.status, 204, JSON.stringify(removed.error));
      }
      await provider.health(AbortSignal.timeout(10_000));
      assert.ok(await provider.getWorkspace(placement, AbortSignal.timeout(10_000)));
      testContext.diagnostic(
        `OpenShell Namespace proof: ${name} Agent completed a real model turn and API teardown`,
      );
    };
    await proveAgent(initial[0].id, "default");
    await proveAgent(later.data.id, "later");

    // IAM denial must commit audit evidence without queuing or provisioning a Namespace.
    const ungranted = {
      email: "ungranted@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const ungrantedAccount = await request("POST", "/api/auth/accounts", ungranted);
    assert.equal(ungrantedAccount.status, 201);
    const ungrantedRequest = await createAuthenticatedControllerRequest(
      app,
      ungranted,
      authBaseURL,
    );
    const workBefore = (
      await pool.query(
        "select count(*)::int as count from occ.controller_work where work_kind = 'lifecycle' and namespace_target is not null",
      )
    ).rows[0].count;
    assert.equal((await ungrantedRequest("POST", "/namespaces", { name: "denied" })).status, 403);
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.namespaces where name = 'denied'"))
        .rows[0].count,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as count from occ.controller_work where work_kind = 'lifecycle' and namespace_target is not null",
        )
      ).rows[0].count,
      workBefore,
    );
    assert.ok(
      (
        await pool.query(
          "select id from occ.audit_events where actor_id = $1 and outcome = 'denied'",
          [ungrantedAccount.data.principalId],
        )
      ).rows.length > 0,
    );

    // Apply a real Installation IAM configuration, then remove its grant while queued
    // work is paused. Account disable is a sign-in control, not an IAM grant revocation.
    await worker.stop();
    const accessPolicy = {
      roles: [{ id: "namespace_creator", permissions: ["namespace:create"] }],
      defaultUserGroups: ["namespace-creators"],
      roleBindings: [
        { group: "namespace-creators", role: "namespace_creator", scope: "installation" },
      ],
    };
    Object.assign(configuration, { iam: accessPolicy });
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await app.close();
    app = await startApi(await loadDrivers(true));
    request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
    const queuedActor = {
      email: "queued-actor@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const queuedAccount = await request("POST", "/api/auth/accounts", queuedActor);
    assert.equal(queuedAccount.status, 201);
    const queuedRequest = await createAuthenticatedControllerRequest(app, queuedActor, authBaseURL);
    const revoked = await queuedRequest("POST", "/namespaces", { name: "revoked-before-dispatch" });
    assert.equal(revoked.status, 201);
    placements.push(kubernetesNamespaceName(revoked.data.id));
    accessPolicy.roleBindings = [];
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await app.close();
    app = await startApi(await loadDrivers(true));
    request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
    worker = startWorker(await loadDrivers());
    await worker.start();
    await fixture.waitFor("revoked queued actor fails before infrastructure", async () => {
      const observed = (
        await pool.query(
          "select state, actor_id from occ.controller_work where namespace_id = $1 and namespace_target = 'ready'",
          [revoked.data.id],
        )
      ).rows[0];
      assert.equal(observed.actor_id, queuedAccount.data.principalId);
      return observed.state === "failed_permanent" ? true : undefined;
    });
    assert.equal(
      String(
        await fixture.kubectl(
          "get",
          "namespace",
          kubernetesNamespaceName(revoked.data.id),
          "--ignore-not-found=true",
          "-o",
          "json",
        ),
      ).trim(),
      "",
    );
    assert.ok(
      (
        await pool.query(
          "select id from occ.audit_events where namespace_id = $1 and actor_id = $2 and outcome = 'denied'",
          [revoked.data.id, queuedAccount.data.principalId],
        )
      ).rows.length > 0,
    );

    // Kubernetes quota is a real provider refusal after owned Secrets have been created.
    // Deleting this partial setup must remove those resources without requiring a gateway.
    await worker.stop();
    Object.assign(configuration.drivers.compute.configuration.resources.namespace.quota, {
      services: "0",
    });
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    worker = startWorker(await loadDrivers());
    await worker.start();
    const refused = await request("POST", "/namespaces", { name: "quota-refused" });
    assert.equal(refused.status, 201);
    const refusedPlacement = await prepareNamespace(refused.data.id);
    await fixture.waitFor("provider refusal blocks readiness", async () => {
      const observed = await request("GET", `/namespaces/${refused.data.id}`);
      assert.equal(observed.status, 200);
      assert.notEqual(observed.data.status, "ready");
      return observed.data.status === "failed" ? true : undefined;
    });
    assert.ok(await fixture.maybeResource("secret", `${service}-jwt-keys`, refusedPlacement));
    assert.equal(await fixture.maybeResource("service", service, refusedPlacement), undefined);
    const remove = async (id: string, { retainBackingNamespace = false } = {}) => {
      assert.equal((await request("DELETE", `/namespaces/${id}`)).status, 202);
      await fixture.waitFor("Namespace cleanup completes through the worker", async () => {
        if ((await request("GET", `/namespaces/${id}`)).status === 404) {
          return true;
        }
        const work = (
          await pool.query(
            "select state from occ.controller_work where namespace_id = $1 and namespace_target = 'deleted'",
            [id],
          )
        ).rows[0];
        assert.notEqual(
          work?.state,
          "failed_permanent",
          JSON.stringify(namespaceOutcomes.slice(-5)),
        );
        return undefined;
      });
      if (retainBackingNamespace) {
        return;
      }
      assert.equal(
        String(
          await fixture.kubectl(
            "get",
            "namespace",
            kubernetesNamespaceName(id),
            "--ignore-not-found=true",
            "-o",
            "json",
          ),
        ).trim(),
        "",
      );
    };
    await remove(refused.data.id);
    await worker.stop();
    configuration.drivers.compute.configuration.resources.namespace.quota = originalQuota;
    for (const object of templates) {
      if (object.kind === "Deployment" || object.kind === "StatefulSet") {
        object.spec.replicas = 0;
      }
    }
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    worker = startWorker(await loadDrivers());
    await worker.start();
    // A Service can exist without a reachable gateway. Deletion must remove the actual
    // partially prepared resources rather than retry an RPC to an absent backend forever.
    const cold = await request("POST", "/namespaces", { name: "gateway-never-started" });
    assert.equal(cold.status, 201);
    const coldPlacement = await prepareNamespace(cold.data.id);
    await fixture.waitFor("unavailable gateway Service created by the Driver", () =>
      fixture.maybeResource("service", service, coldPlacement),
    );
    assert.notEqual((await request("GET", `/namespaces/${cold.data.id}`)).data.status, "ready");
    await remove(cold.data.id);

    await worker.stop();
    const externalPlacement = `ext-${randomUUID().slice(0, 8)}`;
    await fixture.kubectl("create", "namespace", externalPlacement);
    placements.push(externalPlacement);
    await fixture.kubectl(
      "annotate",
      "namespace",
      externalPlacement,
      "openclaw.dev/namespace-lifecycle=external",
    );
    await fixture.kubectl(
      "label",
      "namespace",
      externalPlacement,
      "pod-security.kubernetes.io/enforce=baseline",
      "pod-security.kubernetes.io/audit=restricted",
      "pod-security.kubernetes.io/warn=restricted",
    );
    await fixture.kubectl(
      "create",
      "configmap",
      "operator-sentinel",
      "--namespace",
      externalPlacement,
      "--from-literal=owner=operator",
    );
    const externalUid = (await resourceMetadata("namespace", externalPlacement)).uid;
    const sentinelUid = (
      await resourceMetadata("configmap", "operator-sentinel", externalPlacement)
    ).uid;
    const external = await request("POST", "/namespaces", {
      name: "unclaimed-external",
      existingNamespace: externalPlacement,
    });
    assert.equal(external.status, 201);
    await prepareNamespace(external.data.id, externalPlacement);
    worker = startWorker(await loadDrivers());
    await worker.start();
    // An incompatible operator Pod Security setting refuses adoption before ownership is claimed.
    // Require the committed Compute refusal, so an undispatched queue item cannot satisfy this.
    await fixture.waitFor("Compute refuses external adoption before claiming", async () => {
      const evidence = (
        await pool.query(
          "select details from occ.audit_events where namespace_id = $1 and action = 'openclaw.namespaces.lifecycle.ensure'",
          [external.data.id],
        )
      ).rows;
      return evidence.some(({ details }) =>
        details.participants?.some(
          (participant: { registrationId: string; outcome: string }) =>
            participant.registrationId === drivers.computeDriver.id &&
            participant.outcome === "permanent",
        ),
      )
        ? true
        : undefined;
    });
    assert.equal((await request("GET", `/namespaces/${external.data.id}`)).data.status, "failed");
    const unclaimed = await resourceMetadata("namespace", externalPlacement);
    assert.equal(asRecord(unclaimed.labels)?.["openclaw.dev/namespace"], undefined);
    assert.equal(asRecord(unclaimed.annotations)?.["openclaw.dev/namespace-id"], undefined);
    assert.equal(await fixture.maybeResource("service", service, externalPlacement), undefined);
    await remove(external.data.id, { retainBackingNamespace: true });
    assert.equal((await resourceMetadata("namespace", externalPlacement)).uid, externalUid);
    assert.equal(
      (await resourceMetadata("configmap", "operator-sentinel", externalPlacement)).uid,
      sentinelUid,
    );
    const cleanupEvidence = (
      await pool.query(
        "select details from occ.audit_events where namespace_id = $1 and action = 'openclaw.namespaces.lifecycle.delete'",
        [external.data.id],
      )
    ).rows;
    assert.ok(cleanupEvidence.length > 0);
    assert.ok(
      cleanupEvidence.every(({ details }) =>
        details.participants?.every(
          ({ registrationId }: { registrationId: string }) =>
            registrationId !== drivers.sandboxDriver!.id,
        ),
      ),
    );
    await remove(later.data.id);
    const remaining = await connected(kubernetesNamespaceName(initial[0].id));
    await remaining.client.health(AbortSignal.timeout(10_000));
    assert.ok(
      await remaining.client.getWorkspace(
        kubernetesNamespaceName(initial[0].id),
        AbortSignal.timeout(10_000),
      ),
    );
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
      0,
    );
  },
);
