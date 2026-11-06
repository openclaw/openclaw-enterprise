import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  savedAccountBindingId,
  type AgentRevision,
  type Namespace,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver, type OpenClawController } from "../../packages/occ/src/index.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { installEgressAuthority } from "../../apps/controller/src/composition/egress-authority.ts";
import { savedAccountCapability } from "../../apps/controller/src/drivers/egress-proxy/openshell-saved-account.ts";
import { bindReservedPortInProcess, reservePort } from "./available-port.mjs";
import { harnessTlsFixture } from "./harness-tls.mjs";
import { grpc, invoke, openShellMiddlewareClient, token } from "./openshell-online-wire.mjs";

export const savedAccountSandboxRegistration = {
  capability: "sandbox" as const,
  driverId: "saved-account-proxy",
  implementation: "openshell",
  definition: OpenShellSandboxDriver,
};

export interface SavedAccountPeer {
  readonly brokerUrl: string;
  readonly brokerCaPem: string;
  readonly audience: string;
  readonly supervisorToken: string;
  readonly sandboxId: string;
  readonly sandboxName: string;
  readonly workspace: string;
  readonly middlewareName: string;
  readonly bindingConfig: Record<string, string>;
  resolve(target: URL, body: Record<string, unknown>): Promise<string | undefined>;
}

/** Real OCC, request authority, Plugin Driver and OAuth issuer; the test owns the Gateway inventory. */
export function installSavedAccountPlacement(controller: OpenClawController) {
  // This existing PostgreSQL fixture provides Compute lifecycle without Kubernetes. Use the
  // normal Namespace mapping so the real OpenShell verifier looks up the installed Sandbox.
  const compute = {
    ...controller.selectedDriver("compute"),
    id: "saved-account-compute",
    async resolveSandboxNamespace(namespace: Readonly<Namespace>) {
      return { ...namespace, name: kubernetesNamespaceName(namespace.id) };
    },
  };
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);
}

export async function installSavedAccountProxy(t: TestContext, controller: OpenClawController) {
  const tls = await harnessTlsFixture(t);
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(tls.directory, "supervisor-issuer.pem");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  const reservation = await reservePort();
  t.after(reservation.release);
  await bindReservedPortInProcess(reservation);
  const id = savedAccountSandboxRegistration.driverId;
  const middlewareName = "oauth-credential";
  const audience = "saved-account-credential";
  const boxes = new Map<string, { id: string; annotations: Record<string, string> }>();
  const backend = {
    id: "saved-account-gateway",
    drivers: { sandbox: id },
    client: {
      clientForNamespace: () => ({
        async getGatewayInfo() {
          return {
            extensions: [
              {
                configured_name: middlewareName,
                kind: 4,
                protocol_major: 1,
                supported_capabilities: [savedAccountCapability],
              },
            ],
          };
        },
        async getSandbox(ref: { workspace: string; name: string }) {
          return boxes.get(ref.workspace + "/" + ref.name);
        },
      }),
    },
  };
  const sandbox = new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        userNamespaces: false,
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model",
            binaries: [{ path: "/usr/bin/codex" }],
            endpoints: [{ host: "api.openai.com", ports: [443] }],
          },
        ],
      },
    },
    { id, implementation: "openshell", backend: backend as never },
  );
  const opts = { middlewareName, authorityScope: "execution" as const };
  const proxy = new OpenShellCredentialProxyDriver(opts, {
    id,
    sandbox,
    backend: backend as never,
    exchangeAuthority: {
      host: "127.0.0.1",
      port: reservation.port,
      issuer: "https://gateway.example.test",
      audience,
      keyId: "gateway-key",
      certificatePath: tls.certPath,
      privateKeyPath: tls.keyPath,
      issuerPublicKeyPath,
    },
  });
  const owner = new InstalledDriver(
    {
      id,
      implementation: "openshell",
      configuration: opts,
    },
    { capabilities: { sandbox, credential_proxy: proxy } },
  );
  controller.installDriver(owner, ["sandbox", "credential_proxy"]);
  const listener = await installEgressAuthority(controller, owner);
  assert.ok(listener);
  t.after(listener.close);
  await reservation.release();
  const client = openShellMiddlewareClient(
    t,
    reservation.port,
    tls.caBundle,
    "HttpRequestCredential",
  );
  return {
    peer(
      namespace: Readonly<Namespace>,
      revision: Readonly<AgentRevision>,
      pluginId: string,
      slotId: string,
      sourceId: string,
    ): SavedAccountPeer {
      const workspace = kubernetesNamespaceName(namespace.id);
      const { resourceName: sandboxName } = sandbox.harnessResource({
        namespace: { ...namespace, name: workspace },
        revision,
      });
      const sandboxId = randomUUID();
      boxes.set(workspace + "/" + sandboxName, {
        id: sandboxId,
        annotations: {
          "openclaw.dev/namespace-id": namespace.id,
          "openclaw.dev/agent-id": revision.agentId,
          "openclaw.dev/revision-id": revision.id,
        },
      });
      const bearer = token(keys, "supervisor", sandboxId, audience);
      const bindingConfig = {
        namespace_id: namespace.id,
        agent_id: revision.agentId,
        revision_id: revision.id,
        plugin_id: pluginId,
        slot_id: slotId,
        binding_id: savedAccountBindingId(revision.id, pluginId, slotId, sourceId),
      };
      return {
        brokerUrl: `https://localhost:${reservation.port}`,
        brokerCaPem: tls.caBundle,
        audience,
        supervisorToken: bearer.slice("Bearer ".length),
        sandboxName,
        sandboxId,
        workspace,
        middlewareName,
        bindingConfig,
        async resolve(target, body) {
          const request_id = randomUUID();
          try {
            const response = await invoke(
              client,
              "Resolve",
              {
                middleware_name: middlewareName,
                phase: 3,
                context: { request_id, sandbox_id: sandboxId, workspace },
                config: {
                  fields: Object.fromEntries(
                    Object.entries(bindingConfig).map(([name, value]) => [
                      name,
                      { stringValue: value },
                    ]),
                  ),
                },
                target: {
                  scheme: "https",
                  method: "POST",
                  host: target.hostname,
                  port: Number(target.port || 443),
                  path: target.pathname,
                  query: target.search.slice(1),
                },
                headers: [{ name: "content-type", value: "application/json" }],
                body: Buffer.from(JSON.stringify(body)),
              },
              bearer,
            );
            assert.equal(response.request_id, request_id);
            return response.bearer_token;
          } catch (error) {
            if ((error as { code?: number }).code === grpc.status.PERMISSION_DENIED) {
              return undefined;
            }
            throw error;
          }
        },
      };
    },
  };
}
