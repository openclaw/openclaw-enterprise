/** A controlled external Driver and its actual terminal sender. Both delivery profiles are limited to test-owned HTTPS peers on loopback. */
import assert from "node:assert/strict";
import { createHash, randomUUID, verify, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer, json } from "node:stream/consumers";
import { isDeepStrictEqual } from "node:util";
import { createDriver as releaseDriver } from "./index.ts";
import type {
  DriverRegistration,
  EgressInstallation,
  ProtectedRepositoryGitAuthority as Authority,
  ProtectedRepositoryGitMaterial as Material,
  RepositoryGitInstallationFence as Route,
  RepositoryGitSendPermit,
  ProxyPlan,
} from "../../../../packages/contracts/src/index.ts";

export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["origin", "certFile", "peerOrigin", "capabilityOrigin", "releaseKey"],
  properties: Object.fromEntries(
    [
      "origin",
      "certFile",
      "peerOrigin",
      "capabilityOrigin",
      "releaseKey",
      "installationApiOrigin",
    ].map((k) => [k, { type: "string" }]),
  ),
};
type Config = {
  origin: string;
  certFile: string;
  peerOrigin: string;
  capabilityOrigin: string;
  releaseKey: string;
  installationApiOrigin?: string;
};
export function validateConfiguration({ origin }: Config) {
  const { protocol, hostname, origin: expectedOrigin } = new URL(origin);
  assert.equal(protocol, "https:");
  assert.equal(hostname, "127.0.0.1", "fixture Git must never leave loopback");
  assert.equal(origin, expectedOrigin, "expected an origin without a path");
}

// The test has the workload's credential-free endpoint and can drive ordinary installer work.
// The installed credential is private to the sender, and each Git request has one send opportunity.
let counterpart: ReturnType<typeof createServer>;
export function createCounterpart(tls: ServerOptions) {
  counterpart = createServer(tls);
  return counterpart;
}

export let peer: {
  url: URL;
  clientHeader: string;
  // A nonsecret marker from the workload's host-scoped Git helper; no provider material.
  gitMarker: string;
  apiUrl: URL;
  replayLastInstallationExchange?(): Promise<void>;
  decisions: { operation: string; decision: unknown }[];
  /** The test can hold this already committed permit at either boundary, but cannot replace it. */
  beforeSend?(
    stage: "connect" | "request",
    permit: RepositoryGitSendPermit,
    deadlineAt: string,
  ): Promise<void>;
  install(): Promise<{ materialVersion: string; expiresAt: string }>;
};
export function createDriver(options: {
  id: string;
  implementation: string;
  configuration: Config;
}): DriverRegistration {
  const config = options.configuration;
  validateConfiguration(config);
  const { origin, installationApiOrigin } = config;
  if (installationApiOrigin) {
    validateConfiguration({ ...config, origin: installationApiOrigin });
  }
  const base = releaseDriver({
    ...options,
    configuration: { endpoint: origin, ca: "unused" },
  });
  const { sandbox, credential_proxy: proxy } = base.capabilities;
  assert.ok(sandbox && proxy);
  const sender = proxy.sourceControl.sender;
  const clientSecret = randomUUID();
  const observationSecret = randomUUID();
  const sandboxId = randomUUID();
  let status: EgressInstallation | undefined;
  validateConfiguration({ ...config, origin: config.peerOrigin });
  validateConfiguration({ ...config, origin: config.capabilityOrigin });
  assert.notEqual(
    config.capabilityOrigin,
    config.peerOrigin,
    "capability and protected listeners must differ",
  );
  const capabilityUrl = new URL("/capability", config.capabilityOrigin);
  const url = new URL(config.peerOrigin);
  const ca = readFileSync(config.certFile);
  const peerKeyId = new X509Certificate(ca).fingerprint256;
  let authority: Authority;
  let route: Route | undefined;
  type Broad = NonNullable<Authority["githubInstallation"]>;
  type InstallationMaterial = Extract<
    Awaited<ReturnType<Broad["readMaterial"]>>,
    { value: string }
  >;
  type InstallationOperation = Parameters<Broad["authorize"]>[0]["operation"];
  let installed: Material | InstallationMaterial | undefined;
  let apiUrl: URL;
  let checkedCapability = false;
  const gitMarker = "cedar-workload-marker";
  const basic = (v: string) => "Basic " + Buffer.from("x-access-token:" + v).toString("base64");
  const decisions: typeof peer.decisions = [];
  const signal = () => AbortSignal.timeout(5000);
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

  const exchange = (to: URL, opts: import("node:https").RequestOptions, body?: Buffer) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      request(to, { ca, agent: false, signal: signal(), ...opts }, resolve)
        .on("error", reject)
        .end(body);
    });
  const observe = async (): Promise<{
    installation: EgressInstallation;
    preparationAttemptId?: string;
    materialVersion?: string;
  }> => {
    const res = await exchange(new URL("/installation", url), {
      headers: { authorization: observationSecret },
    });
    assert.equal(res.statusCode, 200, "authenticated sender installation");
    return (await json(res)) as Awaited<ReturnType<typeof observe>>;
  };
  function configure(plan: ProxyPlan) {
    assert.ok(plan.repositoryGit && !plan.routes.length);
    if (installationApiOrigin) {
      assert.equal(plan.repositoryGit.bindings[0]?.profile, "github-installation");
      assert.equal(checkedCapability, true, "release requires the installation delivery profile");
    }
    const execution = plan.execution.executionId;
    status ??= {
      plan,
      sandboxId,
      sender,
      installedAt: new Date().toISOString(),
      enforcement: {
        authorityScope: "execution",
        instanceId: randomUUID(),
        configurationId: plan.id,
        peerKeyId,
        policyHash: hash(JSON.stringify(plan)),
        repositoryGitRecipient: {
          attachmentEpoch: execution,
          providerId: sender.id,
          processInstanceId: randomUUID(),
          networkInstanceId: url.origin,
          ...(installationApiOrigin && {
            deliveryProfile: "github_installation" as const,
          }),
        },
      },
    };
    assert.deepEqual(plan, status.plan, "this fixture owns exactly one execution");
  }
  async function bind(host: Authority) {
    authority = host;
    const server = counterpart;
    assert.ok(server.listening, "only the worker binds the test-owned HTTPS counterpart");
    server.on(
      "request",
      async function serveProtectedRepositoryGitRequest(req: IncomingMessage, res: ServerResponse) {
        try {
          if (req.url === "/installation" && req.headers.authorization === observationSecret) {
            const { preparationAttemptId, materialVersion } = installed ?? {};
            res.writeHead(status ? 200 : 503).end(
              JSON.stringify({
                installation: status,
                preparationAttemptId,
                materialVersion,
              }),
            );
            return;
          }
          const m = installed;
          if (!route || !m) {
            res.writeHead(403).end();
            return;
          }
          const broad = "scope" in m;
          const api = broad && req.headers.host === apiUrl.host;
          const path = req.url ?? "";
          const method = req.method;
          const marker = broad ? (api ? "Bearer " + gitMarker : basic(gitMarker)) : clientSecret;
          if ((!api && req.headers.host !== url.host) || !method) {
            res.writeHead(403).end();
            return;
          }
          if (req.headers.authorization !== marker) {
            // Ordinary Git challenges, invokes its host-scoped helper, and presents the marker.
            res
              .writeHead(401, {
                "www-authenticate": 'Basic realm="cedar-fixture"',
              })
              .end();
            return;
          }
          // Interpret the actual raw target without resolving or normalizing it. Git and API
          // arrive with different Host values and have separate fixed, TLS-verified origins.
          let operation: InstallationOperation;
          let contentType: string | undefined;
          let gitProtocol: string | undefined;
          if (api) {
            if (method === "POST" && path === "/graphql") {
              operation = "github-graphql";
            } else if (
              ["GET", "POST", "PATCH"].includes(method) &&
              /^\/repos\/[\w-]+\/[\w-]+(?:\/[\w/-]+)?$/.test(path)
            ) {
              operation = "github-rest";
            } else {
              res.writeHead(403).end();
              return;
            }
            contentType = req.headers["content-type"];
          } else {
            const match =
              /^\/([\w-]+\/[\w-]+)\.git\/(info\/refs\?service=)?git-(upload|receive)-pack$/.exec(
                path,
              );
            const [, repository, discovery, service] = match ?? [];
            if (
              !match ||
              method !== (discovery ? "GET" : "POST") ||
              (!broad && (m.repository !== repository || service !== "upload"))
            ) {
              res.writeHead(403).end();
              return;
            }
            operation = discovery
              ? service === "upload"
                ? "advertise-upload-pack"
                : "advertise-receive-pack"
              : service === "upload"
                ? "upload-pack"
                : "receive-pack";
            if (!discovery) {
              contentType = "application/x-git-" + service + "-pack-request";
            }
            if (contentType !== req.headers["content-type"]) {
              res.writeHead(403).end();
              return;
            }
            if (broad && req.headers["git-protocol"] === "version=2") {
              gitProtocol = "version=2";
            }
          }
          const upstreamOrigin = api ? installationApiOrigin! : origin;
          const body = await buffer(req);
          const { sessionId, grantId, providerInstanceId, preparationAttemptId, materialVersion } =
            m;
          const requestDigestSha256 = hash(
            Buffer.concat([
              Buffer.from(JSON.stringify([method, upstreamOrigin, path, contentType, gitProtocol])),
              body,
            ]),
          );
          const exchangeId = randomUUID();
          const deadlineAt = new Date(Date.now() + 20_000).toISOString();
          const q = {
            sessionId,
            grantId,
            providerInstanceId,
            exchangeId,
            requestDigestSha256,
            deadlineAt,
          };
          const confirmation = { route, preparationAttemptId, materialVersion };
          const allowInstallation = (operation: InstallationOperation, installationId: string) => {
            const authorize = () =>
              host.githubInstallation!.authorize(
                {
                  ...q,
                  scope: "github-installation",
                  installationId,
                  operation,
                },
                confirmation,
                signal(),
              );
            peer.replayLastInstallationExchange = async () => {
              assert.equal(
                (await authorize()).kind,
                "denied",
                "the same exchange cannot get a second send opportunity",
              );
            };
            return authorize();
          };
          const decision = broad
            ? await allowInstallation(operation, m.installationId)
            : await host.authorize(
                {
                  ...q,
                  operation: operation as "upload-pack" | "advertise-upload-pack",
                  repositoryId: m.repositoryId,
                  pushRef: m.pushRef,
                },
                confirmation,
                signal(),
              );
          decisions.push({ operation, decision });
          if (decision.kind !== "permit") {
            res.writeHead(403).end();
            return;
          }
          const { sendStartBy } = decision;
          assert.deepEqual(decision, {
            kind: "permit",
            exchangeId,
            requestDigestSha256,
            preparationAttemptId,
            materialVersion,
            sendStartBy,
            ...(broad && {
              scope: "github-installation",
              operation,
              revisionId: route.revisionId,
              fence: route.fence,
            }),
          });
          const until = Date.parse(sendStartBy);
          assert.ok(until <= Date.parse(deadlineAt));
          // Keep the original send cutoff across scheduling and TLS setup. Never renew or retry it.
          const monoUntil = performance.now() + (until - Date.now());
          const current = () =>
            installed === m && Date.now() < until && performance.now() < monoUntil;
          const beforeSend = peer.beforeSend;
          await beforeSend?.("connect", decision, deadlineAt);
          if (!current()) {
            res.writeHead(403).end();
            return;
          }
          const upstream = await new Promise<IncomingMessage | undefined>((resolve, reject) => {
            const out = request(
              upstreamOrigin,
              {
                method,
                path,
                ca,
                agent: false,
                signal: AbortSignal.timeout(15_000),
                headers: {
                  authorization: api ? "Bearer " + m.value : basic(m.value),
                  ...(gitProtocol && { "git-protocol": gitProtocol }),
                  ...(contentType && {
                    "content-type": contentType,
                    "content-length": String(body.length),
                  }),
                },
              },
              resolve,
            ).once("error", reject);
            // A fresh connection, one readiness callback and exactly one place that writes HTTP.
            // Expiry during the handshake can leave a connection, but sends no credential or request.
            out.once("socket", (socket) =>
              socket.once("secureConnect", () => {
                void Promise.resolve(beforeSend?.("request", decision, deadlineAt))
                  .then(() => {
                    if (!current()) {
                      resolve(undefined);
                      out.destroy();
                      return;
                    }
                    out.end(body);
                  })
                  .catch(reject);
              }),
            );
          });
          if (!upstream) {
            res.writeHead(403).end();
            return;
          }
          res.writeHead(upstream.statusCode!, {
            "content-type": upstream.headers["content-type"]!,
          });
          upstream.pipe(res);
        } catch {
          res.writeHead(502).end();
        }
      },
    );
    apiUrl = new URL(url);
    apiUrl.hostname = "localhost";
    peer = {
      url,
      apiUrl,
      gitMarker,
      clientHeader: "Authorization: " + clientSecret,
      decisions,
      async install() {
        const selected = installationApiOrigin ? host.githubInstallation! : host;
        if (installationApiOrigin) {
          const legacy = await host.readMaterial(route!, signal());
          assert.ok(
            !legacy || !("value" in legacy),
            "repository Git port cannot disclose installation material",
          );
          const stale = await selected.readMaterial(
            { ...route!, fence: route!.fence - 1 },
            signal(),
          );
          assert.ok(
            !stale || !("value" in stale),
            "a previous recipient cannot receive the current installation token",
          );
        }
        const m = await selected.readMaterial(route!, signal());
        assert.ok(m && "value" in m, "expected live material for this observed recipient");
        if ("scope" in m) {
          assert.equal(m.scope, "github-installation");
          assert.equal(m.apiOrigin, installationApiOrigin);
        }
        const { preparationAttemptId, materialVersion } = m;
        const pending = await host.recipients.beginInstall(route!, {
          preparationAttemptId,
          materialVersion,
        });
        assert.ok(pending, "installation fence");
        installed = m;
        assert.deepEqual(
          await observe(),
          {
            installation: status,
            preparationAttemptId,
            materialVersion,
          },
          "the sender observed that exact recipient, attempt and material version",
        );
        route = await host.recipients.confirmInstall(pending);
        assert.ok(route, "confirmed installation");
        return { materialVersion: m.materialVersion, expiresAt: m.expiresAt };
      },
    };
    return {
      async close() {
        server.removeAllListeners("request");
      },
    };
  }
  return {
    capabilities: {
      sandbox: {
        ...sandbox,
        async enrollHarness(_ctx, installation, release) {
          const { installation: live } = await observe();
          assert.deepEqual(live, installation);
          const startupId = randomUUID();
          const {
            challenge,
            installation: bound,
            expiresAt,
            signature,
          } = (await release(startupId)) as {
            challenge: { startupId: string };
            installation: EgressInstallation["enforcement"] & {
              sandboxId: string;
            };
            expiresAt: number;
            signature: string;
          };
          assert.equal(challenge.startupId, startupId);
          assert.ok(Date.now() < expiresAt);
          assert.equal(bound.sandboxId, live.sandboxId);
          assert.deepEqual(bound.repositoryGitRecipient, live.enforcement.repositoryGitRecipient);
          assert.ok(
            verify(
              null,
              Buffer.from(JSON.stringify([challenge, bound, expiresAt])),
              config.releaseKey,
              Buffer.from(signature, "base64url"),
            ),
          );
          assert.equal(
            await authority.recipients.observe({
              ...live,
              sandboxId: randomUUID(),
            }),
            undefined,
            "a different sandbox cannot receive this installation",
          );
          route ??= await authority.recipients.observe(live);
          assert.ok(
            route,
            "the host must recognize the released installation before preparing material",
          );
        },
        repositoryAccess: {
          async verifyExecution({ revision }) {
            const { plan, enforcement } = (await observe()).installation;
            assert.equal(plan.execution.revisionId, revision.id);
            return {
              executionId: plan.execution.executionId,
              fingerprint: hash(JSON.stringify(enforcement)),
            };
          },
          async retireExpired() {
            return "retire-runtime";
          },
          routeReadiness: () => (route ? "ready" : "pending"),
          materialSettledAt: () => undefined,
          isRouteBlockedError: () => false,
        },
      },
      credential_proxy: {
        ...proxy,
        sourceControl: {
          ...proxy.sourceControl,
          providers: [],
          assertAvailable: async (signal, profile) => {
            assert.equal(profile, installationApiOrigin ? "github_installation" : "repository_git");
            // The API registration knows only the configured peer and its public TLS certificate.
            const res = await exchange(capabilityUrl, { signal });
            assert.equal(res.statusCode, 200);
            checkedCapability = (await json(res)) === profile;
            return checkedCapability && profile === "github_installation" ? profile : undefined;
          },
        },
        bindRepositoryGit: bind,
        async configureRevision({ plan }) {
          configure(plan);
          return { plan, configuration: { recipient: sender } };
        },
        async wiringStatus() {
          return (await observe()).installation;
        },
        async verifyInstallation(_ctx, value) {
          return isDeepStrictEqual(value, (await observe()).installation);
        },
      },
    },
  };
}
