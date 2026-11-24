import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { asRecord } from "../../packages/utils/src/index.ts";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import { openShellProjectedCredentialProviderName } from "../../apps/controller/src/drivers/sandbox/openshell-credential-policy.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  AgentRevisionWire,
  CredentialSourceWire,
} from "../../packages/contracts/src/api/resources.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { waitUntil } from "../helpers/wait-for.ts";

const selection = "OCC_TEST_OPENSHELL_TOKEN_SERVICE_GIT_AGENT";
const management = "OCC_TEST_OPENSHELL_TOKEN_SERVICE";
const poll = { intervalMs: 1_000, timeoutMs: 8 * 60_000 };
const repositoryName = /^(?:[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Missing required real Git Agent test input ${name}.`);
  return value;
}

function loopback(name: string, protocol: string): URL {
  let url: URL;
  try {
    url = new URL(required(name));
  } catch {
    throw new Error(`Set ${name} to a disposable loopback origin.`);
  }
  assert.ok(
    url.protocol === protocol &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
      url.href === `${url.origin}/`,
    `Set ${name} to a disposable loopback origin.`,
  );
  return url;
}

async function serviceKey(): Promise<string> {
  try {
    const file = (await readFile(required("OCC_SERVICE_KEY_FILE"), "utf8")).trim();
    const key: unknown = file.startsWith("{") ? JSON.parse(file).data?.key : file;
    assert.ok(typeof key === "string" && /^\S+$/.test(key));
    return key;
  } catch {
    throw new Error("Could not read the prepared Installation service key file.");
  }
}

type Agent = { id: string; activeRevisionId?: string };
type RepositoryOption = {
  repositoryRef: string;
  githubAccess?: { repository: string; access: string };
};

test(
  "OCC TokenService deploys one Dedicated Codex Agent with a real model turn and scoped native Git",
  {
    skip:
      process.env[`${selection}_REAL`] !== "1" &&
      "requires an owned prepared OCC TokenService Installation",
    timeout: 25 * 60_000,
  },
  async (t) => {
    const origin = loopback("OCC_URL", "http:");
    const endpoint = loopback(`${management}_GATEWAY_ENDPOINT`, "https:");
    const key = await serviceKey();
    const namespaceId = required(`${selection}_NAMESPACE_ID`);
    const modelSourceId = required(`${selection}_MODEL_SOURCE_ID`);
    const model = required(`${selection}_MODEL`);
    const binary = required(`${selection}_MODEL_BINARY`);
    const host = required(`${selection}_MODEL_HOST`);
    const runtimeImage = required(`${selection}_RUNTIME_IMAGE`);
    const clientId = required(`${selection}_GITHUB_APP_CLIENT_ID`);
    const allowedRef = required(`${selection}_ALLOWED_REPOSITORY_REF`);
    const deniedRef = required(`${selection}_DENIED_REPOSITORY_REF`);
    assert.ok(/^ns_[a-f0-9-]{36}$/.test(namespaceId) && /^cs_[a-f0-9-]{36}$/.test(modelSourceId));
    assert.ok(/^ccr_[a-f0-9-]{36}$/.test(clientId));
    assert.ok(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model));
    assert.ok(OPEN_SHELL_CODEX_BINARIES.some((approved) => approved === binary));
    assert.ok(host === "chatgpt.com");
    assert.ok(/^\S+@sha256:[a-f0-9]{64}$/.test(runtimeImage));
    assert.ok(
      allowedRef !== deniedRef,
      "Select distinct approved and denied repository references.",
    );

    const base = `/namespaces/${namespaceId}`;
    const workspace = kubernetesNamespaceName(namespaceId);
    const gateway = new GrpcOpenShellGatewayClient({
      endpoint: endpoint.origin,
      rootCertificatePath: required(`${management}_CA_FILE`),
      requestTimeoutMs: 20_000,
      auth: {
        mode: "mutualTls",
        certificatePath: required(`${management}_MANAGEMENT_CERT_FILE`),
        privateKeyPath: required(`${management}_MANAGEMENT_KEY_FILE`),
      },
    });
    const rpc = () => AbortSignal.timeout(20_000);
    async function request(
      method: string,
      path: string,
      expected: number | readonly number[],
      body?: unknown,
      timeout = 45_000,
    ) {
      const response = await fetch(new URL(path, origin), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers: {
          "x-api-key": key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const accepted = typeof expected === "number" ? [expected] : expected;
      if (!accepted.includes(response.status)) {
        await response.body?.cancel();
        assert.fail(
          `OCC ${method} returned HTTP ${response.status}; expected ${accepted.join("/")}.`,
        );
      }
      return response;
    }
    async function data<T>(
      method: string,
      path: string,
      expected: number,
      body?: unknown,
    ): Promise<T> {
      return ((await (await request(method, path, expected, body)).json()) as { data: T }).data;
    }

    const created: { configurationId?: string; agentId?: string; gitSourceId?: string } = {};
    t.after(async () => {
      try {
        if (created.agentId) {
          const path = `${base}/agents/${created.agentId}`;
          await (await request("DELETE", path, 202)).body?.cancel();
          await waitUntil(
            "test Agent deletion",
            async () => {
              const response = await request("GET", path, [200, 404]);
              await response.body?.cancel();
              return response.status === 404;
            },
            poll,
          );
        }
        if (created.gitSourceId) {
          await (
            await request("DELETE", `${base}/credential-sources/${created.gitSourceId}`, 204)
          ).body?.cancel();
        }
        if (created.configurationId) {
          await (
            await request("DELETE", `${base}/configurations/${created.configurationId}`, 204)
          ).body?.cancel();
        }
      } finally {
        gateway.close();
      }
    });

    const namespace = await data<{ status: string }>("GET", base, 200);
    assert.ok(namespace.status === "ready", "Use a ready disposable Namespace.");
    const modelSource = await data<CredentialSourceWire>(
      "GET",
      `${base}/credential-sources/${modelSourceId}`,
      200,
    );
    assert.ok(
      modelSource.state === "ready" &&
        modelSource.type === "oauth2-refresh-token" &&
        modelSource.consent.kind === "builtin_codex",
      "Use a ready builtin Codex OAuth Source.",
    );
    const clients = await data<{ id: string; kind: string }[]>("GET", "/oauth-clients", 200);
    assert.ok(
      clients.some((client) => client.id === clientId && client.kind === "github-app"),
      "Use a registered GitHub App Client.",
    );
    const options = await data<RepositoryOption[]>("GET", `${base}/agents/repository-options`, 200);
    const allowed = options.find(({ repositoryRef }) => repositoryRef === allowedRef)?.githubAccess;
    const denied = options.find(({ repositoryRef }) => repositoryRef === deniedRef)?.githubAccess;
    assert.ok(
      allowed &&
        denied &&
        repositoryName.test(allowed.repository) &&
        repositoryName.test(denied.repository),
      "Both repository references must be in the finite Namespace registry.",
    );
    const previous = new Set(
      (await data<CredentialSourceWire[]>("GET", `${base}/credential-sources`, 200)).map(
        ({ id }) => id,
      ),
    );

    const configuration = await data<{ id: string }>("POST", `${base}/configurations`, 201, {
      kind: "agent",
      values: createHarnessConfiguration("codex", model),
    });
    created.configurationId = configuration.id;
    const agent = await data<Agent>("POST", `${base}/agents`, 201, {
      name: `native-git-${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
      credentialSources: [{ sourceId: modelSourceId }],
      harnessAuth: { method: "credential_source", sourceId: modelSourceId },
      repositoryAccess: {
        githubAppClientId: clientId,
        defaultProfile: "github-repository",
        repositories: [{ repositoryRef: allowedRef, access: "read" }],
      },
    });
    const agentId = agent.id;
    created.agentId = agentId;
    const agentPath = `${base}/agents/${agentId}`;
    const deployed = await data<AgentRevisionWire>("POST", `${agentPath}/deploy`, 202);
    const submittedSourceIds = deployed.credentialSources?.map(({ sourceId }) => sourceId) ?? [];
    const gitSourceId = submittedSourceIds.find((id) => id !== modelSourceId);
    if (gitSourceId && !previous.has(gitSourceId)) {
      created.gitSourceId = gitSourceId;
    }
    await waitUntil(
      "native Git Agent deployment",
      async () => {
        const result = await data<{ status: string; error?: { code: string } }>(
          "GET",
          `${agentPath}/deployments/${deployed.id}`,
          200,
        );
        assert.ok(
          result.status !== "failed",
          `Deployment failed (${result.error?.code ?? "unknown"}).`,
        );
        return result.status === "succeeded";
      },
      poll,
    );
    assert.ok((await data<Agent>("GET", agentPath, 200)).activeRevisionId === deployed.id);
    const revision = await data<AgentRevisionWire>(
      "GET",
      `${agentPath}/revisions/${deployed.id}`,
      200,
    );
    const sourceIds = revision.credentialSources?.map(({ sourceId }) => sourceId) ?? [];
    assert.ok(
      sourceIds.includes(modelSourceId) &&
        sourceIds.length === 2 &&
        gitSourceId !== undefined &&
        sourceIds.includes(gitSourceId),
      "The active revision must bind the model and one derived Git Source.",
    );
    const gitSource = await data<CredentialSourceWire>(
      "GET",
      `${base}/credential-sources/${gitSourceId}`,
      200,
    );
    assert.ok(
      gitSource.type === "github-app-installation" &&
        gitSource.clientId === clientId &&
        gitSource.scope.repositories.length === 1,
      "Deployment must derive the finite Git Source from the selected Client.",
    );
    const allowedName = gitSource.scope.repositories[0]!.repository;
    assert.ok(
      repositoryName.test(allowedName) &&
        allowedName.includes("/") &&
        (allowed.repository === allowedName || allowed.repository === allowedName.split("/")[1]),
      "The issued repository must match the saved reference.",
    );
    const owner = allowedName.split("/")[0]!;
    const deniedName = denied.repository.includes("/")
      ? denied.repository
      : `${owner}/${denied.repository}`;
    assert.ok(
      repositoryName.test(deniedName) &&
        deniedName !== allowedName &&
        deniedName.split("/")[0] === owner,
      "Use distinct repositories in the same approved installation.",
    );
    assert.ok(
      revision.repositoryCredentials?.bindings.length === 1 &&
        revision.repositoryCredentials.bindings[0]?.repositoryRef === allowedRef,
      "Only the selected Repository may enter the active revision.",
    );

    const sandboxName = `os-${createHash("sha256").update(deployed.id).digest("hex").slice(0, 16)}`;
    const sandbox = await gateway.getSandbox({ workspace, name: sandboxName }, rpc());
    const gitProvider = openShellProjectedCredentialProviderName(gitSourceId, "GITHUB_TOKEN");
    assert.ok(
      sandbox?.id &&
        sandbox.mainProcessInstanceId &&
        asRecord(sandbox.spec?.template)?.image === runtimeImage,
      "The inspected digest-pinned Dedicated Codex runtime must be running.",
    );
    const workspacePath = asRecord(sandbox.spec?.environment)?.OPENCLAW_WORKSPACE_DIR;
    assert.ok(
      typeof workspacePath === "string" && /^\/sandbox\/[A-Za-z0-9_./-]+$/.test(workspacePath),
      "The inspected Sandbox must declare its approved Harness workspace mount.",
    );
    assert.ok(
      Array.isArray(sandbox.spec?.providers) && sandbox.spec.providers.includes(gitProvider),
      "The running Sandbox must attach its native Git Provider.",
    );
    const loaded = await gateway.getPolicyStatus({ workspace, sandbox: sandboxName }, rpc());
    assert.ok(
      loaded.state === "POLICY_STATUS_LOADED" && loaded.activeVersion === loaded.version,
      "The native policy must be loaded.",
    );
    const policies = asRecord(loaded.policy.network_policies);
    const nodeEndpoints = asRecord(policies?.["workspace-node-enrollment"])?.endpoints;
    assert.ok(
      policies &&
        Array.isArray(nodeEndpoints) &&
        nodeEndpoints.some(
          (entry) => asRecord(entry)?.path === `/namespaces/${namespaceId}/agents/${agentId}/node`,
        ),
      "Dedicated Codex requires the exact managed Workspace node route.",
    );
    const modelProvider = openShellProviderName(modelSourceId);
    assert.ok(
      Object.values(policies).some((entry) => {
        const rule = asRecord(entry);
        const binaries = rule?.binaries;
        const endpoints = rule?.endpoints;
        return (
          Array.isArray(binaries) &&
          binaries.some((item) => asRecord(item)?.path === binary) &&
          Array.isArray(endpoints) &&
          endpoints.some(
            (item) =>
              asRecord(item)?.host === host &&
              asRecord(asRecord(item)?.credential_binding)?.provider === modelProvider,
          )
        );
      }),
      "The Codex OAuth preset must admit its exact stock executable and model destination automatically.",
    );
    const credentialed = Object.values(policies).flatMap((entry) => {
      const endpoints = asRecord(entry)?.endpoints;
      return Array.isArray(endpoints)
        ? endpoints.filter(
            (endpoint) =>
              asRecord(asRecord(endpoint)?.credential_binding)?.provider === gitProvider,
          )
        : [];
    });
    assert.ok(
      credentialed.length > 0 &&
        credentialed.every((entry) => asRecord(entry)?.host === "github.com"),
      "Only the GitHub destination may use the Git Provider.",
    );
    const policyText = JSON.stringify(credentialed);
    assert.ok(
      policyText.includes(`/${allowedName}.git/`) && !policyText.includes(`/${deniedName}.git/`),
      "The loaded credential policy must admit only the selected repository.",
    );

    async function chat(message: string): Promise<string> {
      const response = await request(
        "POST",
        `/agents/${agentId}/chat`,
        200,
        { messages: [{ role: "user", content: message }], stream: false },
        8 * 60_000,
      );
      const result = (await response.json()) as {
        choices?: { message?: { role?: string; content?: string } }[];
      };
      assert.ok(result.choices?.[0]?.message?.role === "assistant");
      return result.choices[0]!.message!.content?.trim() ?? "";
    }
    const modelNonce = `MODEL-${randomUUID()}`;
    assert.ok(
      (await chat(`Reply with exactly this text and no other words: ${modelNonce}`)) === modelNonce,
      "A genuine model turn must return the exact nonce.",
    );
    const gitNonce = `GIT-${randomUUID()}`;
    const marker = `${workspacePath}/.occ-git-${randomUUID()}`;
    const script = `git ls-remote --exit-code https://github.com/${allowedName}.git HEAD >/dev/null 2>&1 && ! git ls-remote --exit-code https://github.com/${deniedName}.git HEAD >/dev/null 2>&1 && printf %s ${gitNonce} > ${marker}`;
    assert.ok(
      (await chat(
        `Use your native shell tool to run exactly this command, without changing Git settings or credentials: sh -ceu '${script}'. Reply with exactly ${gitNonce} only if it succeeds.`,
      )) === gitNonce,
      "The Agent must complete the stock Git allow/deny command.",
    );
    const markerStatus = await gateway.execSandbox(
      {
        workspace,
        sandbox: sandboxName,
        command: ["sh", "-ceu", 'test "$(cat "$1")" = "$2"; rm -f "$1"', "sh", marker, gitNonce],
        environment: {},
        stdin: "",
        timeoutSeconds: 20,
      },
      rpc(),
    );
    assert.ok(
      markerStatus === 0,
      "The actual Harness shell must create the exact Git success marker.",
    );
  },
);
