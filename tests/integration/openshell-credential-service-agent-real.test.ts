import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  SOURCE_ID_LABEL,
  openShellProviderName,
  openShellSourceCredentialEnvironment,
} from "../../apps/controller/src/backends/openshell.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { CredentialSourceWire } from "../../packages/contracts/src/api/resources.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { waitFor, waitUntil } from "../helpers/wait-for.ts";

const selection = "OCC_TEST_OPENSHELL_CREDENTIAL_SERVICE_AGENT";
const gatewayInput = "OCC_TEST_OPENSHELL_CREDENTIAL_SERVICE";
const poll = { intervalMs: 1000, timeoutMs: 120_000 };
const readiness = "PROVIDER_READINESS_STATE_READY";

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Missing required native Agent test input ${name}.`);
  return value;
}

function loopbackOrigin(name: string, protocol: string): URL {
  let url: URL;
  try {
    url = new URL(required(name));
  } catch {
    throw new Error(`Set ${name} to a disposable loopback ${protocol} origin.`);
  }
  assert.ok(
    url.protocol === protocol &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
      url.href === url.origin + "/",
    `Set ${name} to a disposable loopback ${protocol} origin.`,
  );
  return url;
}

async function serviceKey(): Promise<string> {
  try {
    const input = (await readFile(required("OCC_SERVICE_KEY_FILE"), "utf8")).trim();
    const key: unknown = input.startsWith("{") ? JSON.parse(input).data?.key : input;
    assert.ok(typeof key === "string" && /^\S+$/.test(key));
    return key;
  } catch {
    throw new Error("Could not read the prepared Installation service key file.");
  }
}

async function json<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`Invalid JSON response (HTTP ${response.status}).`);
  }
}

type Agent = { id: string; activeRevisionId?: string };
type Deployment = { deploymentId: string; status: string; error?: { code: string } };
type Withdrawal = {
  agentId: string;
  namespaceId: string;
  credentialSourceId: string;
  revisionId: string;
  state: string;
  reason?: string;
  withdrawalInProgress: boolean;
};

test(
  "OpenShell-owned static Source serves a dedicated Agent and remains authoritative through rotation and withdrawal",
  {
    skip:
      process.env[`${selection}_REAL`] !== "1" &&
      "requires an owned prepared OpenShell Installation",
    timeout: 25 * 60_000,
  },
  async (t) => {
    const origin = loopbackOrigin("OCC_URL", "http:");
    const endpoint = loopbackOrigin(`${gatewayInput}_GATEWAY_ENDPOINT`, "https:");
    const key = await serviceKey();
    const namespaceId = required(`${selection}_NAMESPACE_ID`);
    const sourceId = required(`${selection}_SOURCE_ID`);
    const model = required(`${selection}_MODEL`);
    const binary = process.env[`${selection}_RUNTIME_BINARY`] ?? "/usr/local/bin/node";
    assert.match(namespaceId, /^ns_[a-f0-9-]{36}$/);
    assert.match(sourceId, /^cs_[a-f0-9-]{36}$/);
    assert.match(model, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
    assert.match(binary, /^\/[^\s]+$/);
    const base = `/namespaces/${namespaceId}`;
    const sourcePath = `${base}/credential-sources/${sourceId}`;
    const workspace = kubernetesNamespaceName(namespaceId);
    const providerName = openShellProviderName(sourceId);
    const gateway = new GrpcOpenShellGatewayClient({
      endpoint: endpoint.origin,
      rootCertificatePath: required(`${gatewayInput}_CA_FILE`),
      requestTimeoutMs: 20_000,
      auth: {
        mode: "mutualTls",
        certificatePath: required(`${gatewayInput}_MANAGEMENT_CERT_FILE`),
        privateKeyPath: required(`${gatewayInput}_MANAGEMENT_KEY_FILE`),
      },
    });
    const rpc = () => AbortSignal.timeout(20_000);

    async function request(
      method: string,
      path: string,
      expected: number | readonly number[],
      body?: unknown,
      { authenticated = true, timeout = 45_000 } = {},
    ): Promise<Response> {
      const response = await fetch(new URL(path, origin), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers: {
          ...(authenticated ? { "x-api-key": key } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const accepted = typeof expected === "number" ? [expected] : expected;
      if (!accepted.includes(response.status)) {
        await response.body?.cancel();
        assert.fail(
          `${method} ${path} returned HTTP ${response.status}; expected ${accepted.join("/")}.`,
        );
      }
      return response;
    }

    async function data<T>(
      method: string,
      path: string,
      status: number,
      body?: unknown,
    ): Promise<T> {
      return (await json<{ data: T }>(await request(method, path, status, body))).data;
    }

    function assertSource(source: CredentialSourceWire): void {
      assert.ok(
        source.id === sourceId &&
          source.namespaceId === namespaceId &&
          source.type === "static" &&
          source.state === "ready" &&
          source.config?.provider_preset === "openai",
        "The exact managed Source must be ready.",
      );
      assert.ok(
        ["secret", "secrets", "ownerCapability", "backendRef"].every(
          (field) => !Object.hasOwn(source, field),
        ),
        "The public Source response omits custody fields.",
      );
    }

    const cleanup: Array<() => Promise<void>> = [];
    t.after(async () => {
      const failures: unknown[] = [];
      try {
        for (const dispose of cleanup.reverse()) {
          try {
            await dispose();
          } catch (error) {
            failures.push(error);
          }
        }
      } finally {
        gateway.close();
      }
      assert.ok(
        failures.length === 0,
        new AggregateError(failures, "Native Agent cleanup failed."),
      );
    });

    // Confirm the supplied disposable Source and its exact Workspace Provider before using either.
    const namespace = await data<{ id: string; status: string }>("GET", base, 200);
    assert.equal(namespace.id, namespaceId);
    assert.equal(namespace.status, "ready");
    const existingAgents = await data<Agent[]>("GET", `${base}/agents`, 200);
    assert.ok(
      Array.isArray(existingAgents) && existingAgents.length === 0,
      "Use a fresh Namespace with no Agents because the test rotates and deletes the Source.",
    );
    assertSource(await data<CredentialSourceWire>("GET", sourcePath, 200));
    const placed = await gateway.getWorkspace(workspace, rpc());
    assert.ok(placed?.id && placed.labels["openclaw.dev/namespace-id"] === namespaceId);
    const provider = await gateway.getProvider(workspace, providerName, rpc());
    assert.ok(provider?.id);
    assert.equal(provider.workspace, workspace);
    assert.equal(provider.type, providerName);
    const profile = await gateway.getProviderProfile(workspace, providerName, rpc());
    assert.ok(profile?.resourceVersion);
    const credentials = profile.definition?.credentials;
    assert.ok(Array.isArray(credentials) && credentials.length === 1);
    assert.equal(credentials[0].name, openShellSourceCredentialEnvironment(sourceId));
    assert.deepEqual(credentials[0].env_vars, [openShellSourceCredentialEnvironment(sourceId)]);
    assert.equal(provider.labels[MANAGED_BY_LABEL], MANAGED_BY);
    assert.equal(provider.labels[SOURCE_ID_LABEL], sourceId);
    assert.equal(provider.labels["openclaw.dev/token-service"], "openshell");
    assert.equal(provider.labels["openclaw.dev/credential-proxy-delivery"], undefined);
    cleanup.push(async () => {
      await request("DELETE", sourcePath, 204);
      await (await request("GET", sourcePath, 404)).body?.cancel();
      assert.equal(await gateway.getProvider(workspace, providerName, rpc()), undefined);
      assert.equal(await gateway.getProviderProfile(workspace, providerName, rpc()), undefined);
    });

    const configuration = await data<{ id: string }>("POST", `${base}/configurations`, 201, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", model),
    });
    const configurationPath = `${base}/configurations/${configuration.id}`;
    cleanup.push(async () => {
      await request("DELETE", configurationPath, 204);
    });

    const agent = await data<Agent>("POST", `${base}/agents`, 201, {
      name: `native-source-${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
      credentialSources: [{ sourceId }],
      harnessAuth: { method: "credential_source", sourceId },
    });
    const agentPath = `${base}/agents/${agent.id}`;
    const deploymentTarget: { sandboxName?: string } = {};
    cleanup.push(async () => {
      // DELETE also retires a deployment that failed after selecting a revision.
      await (await request("DELETE", agentPath, 202)).body?.cancel();
      await waitUntil(
        "exact Agent deletion",
        async () => {
          const read = await request("GET", agentPath, [200, 404]);
          await read.body?.cancel();
          return read.status === 404;
        },
        poll,
      );
      if (deploymentTarget.sandboxName !== undefined) {
        assert.equal(
          await gateway.getSandbox({ workspace, name: deploymentTarget.sandboxName }, rpc()),
          undefined,
          "Agent deletion must remove its exact Sandbox.",
        );
      }
    });

    const networking = `${agentPath}/sandbox-policy/networking`;
    await (await request("PATCH", `${networking}/editing`, 200, { enabled: true })).body?.cancel();
    const { policy } = await data<{ policy: { version: number } }>("GET", networking, 200);
    await (
      await request("PUT", networking, 200, {
        expectedVersion: policy.version,
        additions: [
          { id: "model-egress", binary, host: "api.openai.com", ports: [{ from: 443, to: 443 }] },
        ],
      })
    ).body?.cancel();
    const revision = await data<{ id: string }>("POST", `${agentPath}/deploy`, 202);
    const sandboxName = `os-${createHash("sha256").update(revision.id).digest("hex").slice(0, 16)}`;
    deploymentTarget.sandboxName = sandboxName;
    const deploymentPath = `${agentPath}/deployments/${revision.id}`;
    await waitUntil(
      "dedicated Agent deployment",
      async () => {
        const status = await data<Deployment>("GET", deploymentPath, 200);
        assert.equal(status.deploymentId, revision.id);
        assert.notEqual(
          status.status,
          "failed",
          `Deployment failed (${status.error?.code ?? "unknown"}).`,
        );
        return status.status === "succeeded";
      },
      { ...poll, timeoutMs: 8 * 60_000 },
    );
    assert.equal((await data<Agent>("GET", agentPath, 200)).activeRevisionId, revision.id);

    const readSandbox = () => gateway.getSandbox({ workspace, name: sandboxName }, rpc());
    const sandbox = await readSandbox();
    assert.ok(sandbox?.id && sandbox.mainProcessInstanceId);
    assert.equal(sandbox.workspace, workspace);
    assert.equal(sandbox.annotations["openclaw.dev/namespace-id"], namespaceId);
    assert.equal(sandbox.annotations["openclaw.dev/agent-id"], agent.id);
    assert.equal(sandbox.annotations["openclaw.dev/revision-id"], revision.id);
    assert.ok(
      Array.isArray(sandbox.spec?.providers) && sandbox.spec.providers.includes(providerName),
    );
    async function waitForAppliedProvider(version: string): Promise<void> {
      // Request one observation for this version, then poll only its exact receipt.
      const initial = await gateway.getSandboxProviderStatus(
        workspace,
        sandboxName,
        providerName,
        rpc(),
      );
      const receiptId = initial.receipt?.receiptId;
      assert.ok(receiptId);
      assert.equal(initial.receipt?.desired?.providerResourceVersion, version);
      await waitUntil(
        "the exact Provider version to reach the running Sandbox",
        async () => {
          const { state, receipt, observed } = await gateway.getSandboxProviderStatus(
            workspace,
            sandboxName,
            providerName,
            rpc(),
            receiptId,
          );
          assert.equal(receipt?.receiptId, receiptId);
          if (state !== readiness) {
            return false;
          }
          const desired = receipt?.desired;
          assert.ok(desired);
          assert.equal(desired.providerResourceVersion, version);
          assert.equal(receipt?.provider, providerName);
          assert.equal(receipt?.workspace, workspace);
          assert.equal(desired.providerId, provider?.id);
          assert.equal(desired.sandboxId, sandbox?.id);
          assert.ok(
            observed?.credentialsInstalled &&
              observed.policyActive &&
              observed.launchEnvironmentInstalled,
          );
          assert.equal(observed.providerEnvRevision, desired.providerEnvRevision);
          assert.equal(observed.configRevision, desired.configRevision);
          assert.equal(observed.attachmentEpoch, desired.attachmentEpoch);
          assert.equal(observed.policyHash, desired.policyHash);
          return true;
        },
        poll,
      );
    }
    await waitForAppliedProvider(provider.resourceVersion);

    // The live model key was enrolled through the Source API and never enters this test.
    const nonce = `OPEN-SHELL-${randomUUID()}`;
    const chatPath = `/agents/${agent.id}/chat`;
    const chat = {
      messages: [
        {
          role: "user",
          content: `Reply with exactly this text, without tools or any other words: ${nonce}`,
        },
      ],
      stream: false,
    };
    await (await request("POST", chatPath, 401, chat, { authenticated: false })).body?.cancel();
    const { choices } = await json<{ choices: { message: { role: string; content: string } }[] }>(
      await request("POST", chatPath, 200, chat, { timeout: 8 * 60_000 }),
    );
    const message = choices?.[0]?.message;
    assert.ok(
      message?.role === "assistant" && message.content?.trim() === nonce,
      "Expected the exact live Agent nonce.",
    );

    // An invalid synthetic replacement is private to the Gateway. Observe the serving version
    // through supervisor readiness so the test does not send this value to the model endpoint.
    assertSource(
      await data<CredentialSourceWire>("PATCH", sourcePath, 200, {
        secret: `synthetic-native-agent-${randomUUID()}`,
      }),
    );
    const rotated = await gateway.getProvider(workspace, providerName, rpc());
    assert.ok(rotated);
    assert.equal(rotated.id, provider.id);
    assert.ok(BigInt(rotated.resourceVersion) > BigInt(provider.resourceVersion));
    assert.equal(
      (await gateway.getProviderProfile(workspace, providerName, rpc()))?.resourceVersion,
      profile.resourceVersion,
    );
    await waitForAppliedProvider(rotated.resourceVersion);
    const stillRunning = await readSandbox();
    assert.equal(stillRunning?.id, sandbox.id);
    assert.equal(stillRunning?.mainProcessInstanceId, sandbox.mainProcessInstanceId);

    // Withdrawal revokes delivery from this active revision while custody remains with the Source.
    const withdrawalPath = `${agentPath}/credential-sources/${sourceId}`;
    const withdrawal = await data<Withdrawal>("POST", `${withdrawalPath}/withdraw`, 202);
    assert.equal(withdrawal.state, "pending");
    assert.equal(withdrawal.agentId, agent.id);
    assert.equal(withdrawal.namespaceId, namespaceId);
    assert.equal(withdrawal.credentialSourceId, sourceId);
    assert.equal(withdrawal.revisionId, revision.id);
    let reason: string | undefined;
    const completedWithdrawal = await waitFor(
      () => `confirmed native withdrawal${reason ? ` (${reason})` : ""}`,
      async () => {
        const status = await data<Withdrawal>("GET", `${withdrawalPath}/withdrawal`, 200);
        reason = status.reason;
        return status.state === "revoked" && !status.withdrawalInProgress ? status : undefined;
      },
      poll,
    );
    assert.equal(completedWithdrawal.revisionId, revision.id);
    assert.equal(completedWithdrawal.credentialSourceId, sourceId);
    const detached = await readSandbox();
    assert.equal(detached?.id, sandbox.id);
    assert.equal(detached?.mainProcessInstanceId, sandbox.mainProcessInstanceId);
    assert.ok(Array.isArray(detached?.spec?.providers));
    assert.ok(!detached.spec.providers.includes(providerName));
    assert.equal((await data<Agent>("GET", agentPath, 200)).activeRevisionId, revision.id);
    const retained = await gateway.getProvider(workspace, providerName, rpc());
    assert.equal(retained?.id, provider.id);
    assert.equal(retained?.resourceVersion, rotated.resourceVersion);
    assertSource(await data<CredentialSourceWire>("GET", sourcePath, 200));
  },
);
