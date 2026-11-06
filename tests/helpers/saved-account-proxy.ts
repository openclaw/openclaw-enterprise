import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { request } from "node:https";
import { promisify } from "node:util";
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
  readonly brokerCaPath: string;
  readonly tokenUrl: string;
  readonly audience: string;
  readonly supervisorToken: string;
  readonly sandboxId: string;
  readonly sandboxName: string;
  readonly workspace: string;
  readonly middlewareName: string;
  readonly bindingConfig: {
    readonly namespace_id: string;
    readonly agent_id: string;
    readonly revision_id: string;
    readonly binding_id: string;
  };
  authorize(
    target: URL,
    body: Record<string, unknown>,
    wire?: { middlewareName?: string; audience?: string },
  ): Promise<string | undefined>;
  redeem(
    requestId: string,
    input?: { svidAudience?: string; bindingId?: string },
  ): Promise<string | undefined>;
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

export async function savedAccountProxyFixture(t: TestContext) {
  const tls = await harnessTlsFixture(t);
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(tls.directory, "supervisor-issuer.pem");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  const identity = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const trustDomain = "test.example";
  const kid = randomUUID();
  const signingKey = { ...identity.publicKey.export({ format: "jwk" }), kid, use: "jwt-svid" };
  const runner = process.env.OCC_TEST_OPENSHELL_CREDENTIAL_SENDER;
  // The optional stock supervisor obtains a real SVID via its Workload API socket.
  // The CI client signs a separate test SVID and exercises the same verifier.
  const nativeKeys = runner
    ? JSON.parse((await promisify(execFile)(runner, ["jwt-bundle"], { timeout: 10_000 })).stdout)
        .keys
    : [];
  const bundlePath = join(tls.directory, "sandbox-jwt-bundle.json");
  await writeFile(bundlePath, JSON.stringify({ keys: [signingKey, ...nativeKeys] }), {
    mode: 0o600,
  });
  const authority = await reservePort();
  const grants = await reservePort();
  t.after(authority.release);
  t.after(grants.release);
  const tokenUrl = `https://localhost:${grants.port}/token`;
  const tokenGrant = { endpoint: tokenUrl, port: grants.port, trustDomain, bundlePath };
  return { t, tls, keys, issuerPublicKeyPath, identity, kid, authority, grants, tokenGrant };
}

export async function installSavedAccountProxy(
  fixture: Awaited<ReturnType<typeof savedAccountProxyFixture>>,
  controller: OpenClawController,
  middlewareName = "oauth-credential",
  bindHost = "127.0.0.1",
) {
  const { t, tls, keys, issuerPublicKeyPath, identity, kid, authority, grants, tokenGrant } =
    fixture;
  const { endpoint: tokenUrl, trustDomain } = tokenGrant;
  const id = savedAccountSandboxRegistration.driverId;
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
                supported_capabilities: ["openshell.supervisor-middleware.contract"],
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
  const opts = { middlewareName, authorityScope: "execution" as const, tokenGrant };
  const proxy = new OpenShellCredentialProxyDriver(opts, {
    id,
    sandbox,
    backend: backend as never,
    exchangeAuthority: {
      host: bindHost,
      port: authority.port,
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
  await bindReservedPortInProcess(authority);
  await bindReservedPortInProcess(grants);
  const listener = await installEgressAuthority(controller, owner);
  assert.ok(listener);
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await listener.close();
    }
  };
  t.after(close);
  await authority.release();
  await grants.release();
  const client = openShellMiddlewareClient(
    t,
    authority.port,
    tls.caBundle,
    "SupervisorMiddleware",
    bindHost,
  );
  return {
    driver: owner.ref,
    close,
    peer(
      namespace: Readonly<Namespace>,
      revision: Readonly<AgentRevision>,
      pluginId: string,
      slotId: string,
      sourceId: string,
      sandboxId: string = randomUUID(),
    ): SavedAccountPeer {
      const workspace = kubernetesNamespaceName(namespace.id);
      const { resourceName: sandboxName } = sandbox.harnessResource({
        namespace: { ...namespace, name: workspace },
        revision,
      });
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
        binding_id: savedAccountBindingId(revision.id, pluginId, slotId, sourceId),
      };
      return {
        brokerUrl: `https://localhost:${authority.port}`,
        tokenUrl,
        brokerCaPem: tls.caBundle,
        brokerCaPath: tls.rootCertificatePath,
        audience,
        supervisorToken: bearer.slice("Bearer ".length),
        sandboxName,
        sandboxId,
        workspace,
        middlewareName,
        bindingConfig,
        async authorize(target, body, wire) {
          const request_id = randomUUID();
          try {
            const response = await invoke(
              client,
              "EvaluateHttpRequest",
              {
                middleware_name: wire?.middlewareName ?? middlewareName,
                phase: 1,
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
              wire?.audience === undefined
                ? bearer
                : token(keys, "supervisor", sandboxId, wire.audience),
            );
            return response.decision === 1 ? request_id : undefined;
          } catch (error) {
            if ((error as { code?: number }).code === grpc.status.PERMISSION_DENIED) {
              return undefined;
            }
            throw error;
          }
        },
        async redeem(requestId, override) {
          const now = Math.floor(Date.now() / 1000);
          const pack = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
          const signed =
            pack({ alg: "ES256", kid, typ: "JWT" }) +
            "." +
            pack({
              aud: [override?.svidAudience ?? tokenUrl],
              sub: `spiffe://${trustDomain}/openshell/sandbox/${sandboxId}`,
              iat: now,
              exp: now + 120,
            });
          const signature = sign("sha256", Buffer.from(signed), {
            key: identity.privateKey,
            dsaEncoding: "ieee-p1363",
          }).toString("base64url");
          const form = new URLSearchParams({
            grant_type: "client_credentials",
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: signed + "." + signature,
            audience: override?.bindingId ?? bindingConfig.binding_id,
          });
          return new Promise<string | undefined>((resolve, reject) => {
            const exchange = request(
              tokenUrl,
              {
                method: "POST",
                ca: tls.caBundle,
                hostname: bindHost,
                servername: "localhost",
                family: 4,
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  "x-openshell-request-id": requestId,
                },
              },
              (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => {
                  data += chunk;
                });
                res.once("error", reject);
                res.once("end", () => {
                  try {
                    if (
                      res.statusCode === 400 ||
                      res.statusCode === 401 ||
                      res.statusCode === 403
                    ) {
                      resolve(undefined);
                      return;
                    }
                    assert.equal(res.statusCode, 200);
                    const reply = JSON.parse(data);
                    assert.equal(typeof reply.access_token, "string");
                    assert.ok(reply.expires_in > 0);
                    resolve(reply.access_token);
                  } catch (error) {
                    reject(error);
                  }
                });
              },
            );
            exchange.once("error", reject);
            exchange.end(form.toString());
          });
        },
      };
    },
  };
}
