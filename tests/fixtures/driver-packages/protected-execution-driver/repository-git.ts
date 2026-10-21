/** A controlled external Driver and its actual terminal sender. Only loopback Git fetch is implemented. */
import assert from "node:assert/strict";
import { createHash, randomUUID, verify, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:https";
import type { IncomingMessage } from "node:http";
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
  required: ["origin", "certFile", "keyFile", "releaseKey"],
  properties: Object.fromEntries(
    ["origin", "certFile", "keyFile", "releaseKey"].map((k) => [k, { type: "string" }]),
  ),
};
type Config = { origin: string; certFile: string; keyFile: string; releaseKey: string };
export function validateConfiguration({ origin }: Config) {
  const { protocol, hostname, origin: expectedOrigin } = new URL(origin);
  assert.equal(protocol, "https:");
  assert.equal(hostname, "127.0.0.1", "fixture Git must never leave loopback");
  assert.equal(origin, expectedOrigin, "expected only the private Git origin");
}

// The test has the workload's credential-free endpoint and can drive ordinary installer work.
// The installed credential is private to the sender, and each Git request has one send opportunity.
export let peer: {
  url: URL;
  clientHeader: string;
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
  const { origin } = config;
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
  let url: URL;
  let ca: Buffer;
  let peerKeyId: string;
  let authority: Authority;
  let route: Route | undefined;
  let installed: Material | undefined;
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
        },
      },
    };
    assert.deepEqual(plan, status.plan, "this fixture owns exactly one execution");
  }
  async function bind(host: Authority) {
    authority = host;
    ca = await readFile(config.certFile);
    peerKeyId = new X509Certificate(ca).fingerprint256;
    const server = createServer(
      { cert: ca, key: await readFile(config.keyFile) },
      async (req, res) => {
        try {
          if (req.url === "/installation" && req.headers.authorization === observationSecret) {
            const { preparationAttemptId, materialVersion } = installed ?? {};
            res
              .writeHead(status ? 200 : 503)
              .end(JSON.stringify({ installation: status, preparationAttemptId, materialVersion }));
            return;
          }
          const m = installed;
          if (!route || !m || req.headers.authorization !== clientSecret) {
            res.writeHead(403).end();
            return;
          }
          // Construct the outbound request from the installed repository and a closed operation.
          // Compare the raw inbound target exactly; never resolve it against the credentialed origin.
          const upload = req.method === "POST";
          const method = upload ? "POST" : "GET";
          const service = upload ? "git-upload-pack" : "info/refs?service=git-upload-pack";
          const path = `/${m.repository}.git/${service}`;
          if (req.method !== method || req.url !== path) {
            res.writeHead(403).end();
            return;
          }
          const operation = upload ? "upload-pack" : "advertise-upload-pack";
          const body = await buffer(req);
          const contentType = upload ? req.headers["content-type"] : undefined;
          const {
            sessionId,
            grantId,
            repositoryId,
            providerInstanceId,
            pushRef,
            preparationAttemptId,
            materialVersion,
          } = m;
          const requestDigestSha256 = hash(
            Buffer.concat([Buffer.from(JSON.stringify([method, origin, path, contentType])), body]),
          );
          const exchangeId = randomUUID();
          const deadlineAt = new Date(Date.now() + 20_000).toISOString();
          const decision = await host.authorize(
            {
              sessionId,
              grantId,
              repositoryId,
              providerInstanceId,
              pushRef,
              operation,
              exchangeId,
              requestDigestSha256,
              deadlineAt,
            },
            { route, preparationAttemptId, materialVersion },
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
              origin,
              {
                method,
                path,
                ca,
                agent: false,
                signal: AbortSignal.timeout(15_000),
                headers: {
                  authorization:
                    "Basic " + Buffer.from("x-access-token:" + m.value).toString("base64"),
                  ...(upload && {
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
    ).listen(0, "127.0.0.1");
    await once(server, "listening");
    url = new URL("https://127.0.0.1:" + (server.address() as { port: number }).port);
    peer = {
      url,
      clientHeader: "Authorization: " + clientSecret,
      decisions,
      async install() {
        const m = await host.readMaterial(route!, signal());
        assert.ok(m && "value" in m, "expected live material for this observed recipient");
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
    return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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
            installation: EgressInstallation["enforcement"] & { sandboxId: string };
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
            await authority.recipients.observe({ ...live, sandboxId: randomUUID() }),
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
          assertAvailable: async (_signal, profile) => {
            assert.equal(profile, "repository_git");
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
