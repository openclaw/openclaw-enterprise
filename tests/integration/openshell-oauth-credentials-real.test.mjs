import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

// This opt-in proof uses the real OpenShell server, credential backend, refresh engine,
// operator auth, and OCE warm-read Driver. The OAuth issuer is a local synthetic fixture;
// it does not establish real Codex login, model execution, or revision deployment.
const execute = promisify(execFile);
const selected = process.env.OCE_OPENSHELL_OAUTH_REAL === "1";
const required = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required for the selected real-gateway proof`);
  return value;
};

test(
  "OpenShell owns rotating refresh material and permits only scoped operator warm reads",
  {
    skip: selected
      ? false
      : "set OCE_OPENSHELL_OAUTH_REAL=1 with the task-local gateway and OAuth issuer",
  },
  async (t) => {
    const kubeconfig = required("OCE_OPENSHELL_OAUTH_KUBECONFIG");
    const kubernetesContext = required("OCE_OPENSHELL_OAUTH_KUBERNETES_CONTEXT");
    const workspaceChart = required("OCE_OPENSHELL_OAUTH_WORKSPACE_CHART");
    assert.equal(
      kubernetesContext,
      "k3d-occ-dev-oce-oauth-poc",
      "this proof only mutates the owned PoC cluster",
    );
    const kubectl = async (...args) =>
      (
        await execute(
          "kubectl",
          ["--kubeconfig", kubeconfig, "--context", kubernetesContext, ...args],
          { maxBuffer: 8 * 1024 * 1024 },
        )
      ).stdout;
    const cluster = JSON.parse(await kubectl("config", "view", "--minify", "-o", "json"));
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(
        new URL(cluster.clusters[0].cluster.server).hostname,
      ),
      "the selected k3d API must be loopback",
    );
    const endpoint = required("OCE_OPENSHELL_OAUTH_GATEWAY_ENDPOINT");
    const rootCertificatePath = required("OCE_OPENSHELL_OAUTH_CA_FILE");
    const client = new GrpcOpenShellGatewayClient({
      endpoint,
      rootCertificatePath,
      requestTimeoutMs: 30_000,
      auth: { mode: "bearerTokenFile", path: required("OCE_OPENSHELL_OAUTH_OPERATOR_TOKEN_FILE") },
    });
    const deniedClient = new GrpcOpenShellGatewayClient({
      endpoint,
      rootCertificatePath,
      requestTimeoutMs: 30_000,
      auth: { mode: "bearerTokenFile", path: required("OCE_OPENSHELL_OAUTH_DENIED_TOKEN_FILE") },
    });
    const workspace = `oauth-proof-${randomUUID().slice(0, 6)}`;
    const sourceId = `poc-source-${randomUUID()}`;
    const name = openShellProviderName(sourceId);
    const credentialKey = "CODEX_ACCESS_TOKEN";
    const profileId = "oce-codex-oauth";
    const signal = AbortSignal.timeout(120_000);
    let providerCreated = false;
    let profileCreated = false;
    let workspaceCreated = false;
    let namespaceCreated = false;
    const directory = await mkdtemp(join(tmpdir(), "openshell-oauth-proof-"));
    t.after(async () => {
      try {
        const cleanup = AbortSignal.timeout(30_000);
        if (providerCreated) {
          await client.deleteProvider(workspace, name, cleanup);
        }
        if (profileCreated) {
          await client.deleteProviderProfile(workspace, profileId, cleanup);
        }
        if (workspaceCreated) {
          await client.deleteWorkspace(workspace, cleanup);
        }
      } finally {
        client.close();
        deniedClient.close();
        await rm(directory, { recursive: true, force: true });
        if (namespaceCreated) {
          await kubectl("delete", "namespace", workspace, "--wait=true", "--timeout=60s");
        }
      }
    });
    // Operator mode requires the real labelled Namespace and the same workspace chart
    // RBAC used by Sandbox provisioning; a gateway metadata row alone is insufficient.
    await kubectl("create", "namespace", workspace);
    namespaceCreated = true;
    await kubectl("label", "namespace", workspace, "openshell.ai/openclaw-workspace=true");
    const rendered = await execute(
      "helm",
      [
        "template",
        "openshell-workspace",
        workspaceChart,
        "--namespace",
        workspace,
        "--set-string=fullnameOverride=openshell-workspace",
        "--set-string=gateway.serviceAccount.name=openshell-gateway",
        "--set-string=gateway.serviceAccount.namespace=openshell-system",
        "--set-string=gateway.networkPolicy.podSelector.app\\.kubernetes\\.io/instance=openshell-gateway",
        "--set=gateway.allowDriverConfig=true",
        "--set-string=sandboxServiceAccount.name=openshell-sandbox",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const resources = join(directory, "workspace.yaml");
    await writeFile(resources, rendered.stdout, { mode: 0o600 });
    await kubectl("apply", "--namespace", workspace, "-f", resources);
    await client.createWorkspace(workspace, { "openclaw.dev/oauth-poc-proof": "true" }, signal);
    workspaceCreated = true;

    await client.importProviderProfile(
      workspace,
      {
        id: profileId,
        displayName: "Local OAuth refresh proof",
        category: "PROVIDER_PROFILE_CATEGORY_INFERENCE",
        credentials: [
          {
            name: "access_token",
            envVars: [credentialKey],
            required: true,
            authStyle: "bearer",
            headerName: "authorization",
            refresh: {
              tokenUrl: required("OCE_OPENSHELL_OAUTH_TEST_TOKEN_URL"),
              refreshBeforeSeconds: 300,
            },
          },
        ],
        endpoints: [{ host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/**" }],
        binaries: ["/usr/local/bin/codex"],
        inferenceCapable: true,
        annotations: {},
      },
      signal,
    );
    profileCreated = true;
    await client.createProvider(
      {
        workspace,
        name,
        type: profileId,
        credentials: {},
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/credential-source-id": sourceId,
        },
        config: {
          "oce.codex.account": JSON.stringify({ accountId: "poc-account", planType: "plus" }),
        },
      },
      signal,
    );
    providerCreated = true;
    const configured = await client.configureProviderRefresh(
      workspace,
      name,
      credentialKey,
      {
        client_id: "oauth-poc-client",
        refresh_token: `oauth-poc-refresh-initial-${randomUUID()}`,
      },
      new Date(Date.now() + 3_600_000).toISOString(),
      signal,
    );
    assert.equal(configured.status, "configured");

    const backend = createOpenShellBackend(
      {
        id: "openshell",
        implementation: "openshell",
        configuration: { endpoint },
        drivers: { sandbox: "sandbox", credential_gateway: "credential-gateway-openshell" },
      },
      { gatewayClient: client },
    );
    const driver = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/codex"] },
      { backend },
    );
    const context = {
      signal,
      namespace: { id: workspace, name: workspace },
      source: { id: sourceId, namespaceId: workspace, driverId: driver.id, type: "codex-oauth" },
    };
    const fingerprint = async ({ accessToken, accountId }) => {
      assert.equal(accountId, "poc-account");
      return createHash("sha256").update(accessToken).digest("hex");
    };
    assert.equal(
      (await client.rotateProviderCredential(workspace, name, credentialKey, signal)).status,
      "refreshed",
    );
    const first = await driver.withSourceToken(context, fingerprint);
    const firstAttachment = await driver.attachForRevision({
      signal,
      namespace: context.namespace,
      sources: [context.source],
    });
    assert.equal(
      firstAttachment[0].externalChatgptAuth.accessTokenPlaceholder,
      "openshell:resolve:env:CODEX_ACCESS_TOKEN",
    );

    // The issuer rejects reuse of the old refresh token. A second successful rotation proves
    // OpenShell persisted and used the replacement refresh token without OCE supplying it again.
    assert.equal(
      (await client.rotateProviderCredential(workspace, name, credentialKey, signal)).status,
      "refreshed",
    );
    const second = await driver.withSourceToken(context, fingerprint);
    assert.notEqual(first, second);
    assert.deepEqual(
      await driver.attachForRevision({
        signal,
        namespace: context.namespace,
        sources: [context.source],
      }),
      firstAttachment,
      "re-attaching reads the same source and metadata without reseeding its OAuth credentials",
    );
    assert.equal((await driver.sourceStatus(context)).state, "ready");
    const resolved = await client.resolveProviderCredential(workspace, name, credentialKey, signal);
    assert.ok(Date.parse(resolved.expirationTime) > Date.now());
    await assert.rejects(
      deniedClient.resolveProviderCredential(workspace, name, credentialKey, signal),
      (error) => error.grpcStatus === 7,
      "a platform admin without credential-read scope cannot read plaintext",
    );
    await assert.rejects(
      client.resolveProviderCredential(workspace, name, "refresh_token", signal),
      "refresh material is not an injectable provider credential",
    );
  },
);
