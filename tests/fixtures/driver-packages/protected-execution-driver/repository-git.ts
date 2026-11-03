/** A controlled external Driver and its actual terminal sender. Both delivery profiles are limited to test-owned HTTPS peers on loopback. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, verify, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer, json } from "node:stream/consumers";
import { isDeepStrictEqual } from "node:util";
import { createDriver as releaseDriver } from "./index.ts";
import type {
  DriverRegistration,
  ErrorDetail,
  EgressInstallation,
  ProtectedRepositoryGitAuthority as Authority,
  ProtectedRepositoryGitMaterial as Material,
  RepositoryGitInstallationFence as Route,
  RepositoryGitSendPermit,
  ProxyPlan,
  CredentialPolicyReduction,
  CredentialProviderDefinition,
  CredentialProxyExchange,
  AcceptedEgressAssociation,
  CapturedEgressUse,
  RepositoryGitMaterialVersion,
} from "@openclaw-enterprise/contracts";

// This external adapter supports one credential-free metadata operation beside Git.
// Its platform grant is still admitted and authorized by OCC; the peer enforces exact routes.
const metadata: CredentialProviderDefinition = {
  ref: { id: "credential-free-repository-metadata", generation: 1 },
  schemaVersion: 1,
  sourceType: {
    type: "credential-free-repository-metadata",
    rotation: "none",
    secrets: [],
    config: ["origin", "repository_id", "repository", "agent_id", "authority"].map((name) => ({
      name,
      required: true,
    })),
  },
  normalizeConfig(config) {
    assert.equal(new URL(config.origin!).hostname, "127.0.0.1");
    assert.equal(new URL(config.origin!).protocol, "https:");
    assert.equal(config.authority, "execution");
    return config;
  },
  normalizeGrant(_models, config = {}) {
    return {
      kind: "credential_free_repository_metadata",
      profile: "metadata-read",
      repositoryId: config.repository_id!,
      repository: config.repository!,
      isolationId: config.agent_id!,
    };
  },
  routes(source, binding) {
    assert.equal(source.egress?.adoption, "credential_free");
    assert.equal(binding.grant.kind, "credential_free_repository_metadata");
    return [
      {
        route: { id: binding.binding.id, generation: 1 },
        binding,
        origin: source.config.origin!,
        path: "/repos/" + source.config.repository,
        method: "GET",
        operationPolicy: { id: "external-metadata", generation: 1 },
        responsePolicy: { id: "external-metadata", generation: 1 },
        deadlineMs: 5000,
      },
    ];
  },
  classify(route, request) {
    const grant = route.binding.grant;
    if (
      grant.kind !== "credential_free_repository_metadata" ||
      request.method !== "GET" ||
      request.url !== route.origin + route.path ||
      request.body.byteLength !== 0
    ) {
      return undefined;
    }
    return { kind: grant.kind, repository: grant.repository, repositoryId: grant.repositoryId };
  },
  inject() {
    throw new Error("Credential-free operation cannot inject material");
  },
  credentialRejected() {
    return false;
  },
  protectResponse(response, _value, _request, operation) {
    if (operation.kind !== "credential_free_repository_metadata" || response.status !== 200) {
      return undefined;
    }
    const body = JSON.parse(Buffer.from(response.body).toString());
    if (body.id !== Number(operation.repositoryId) || body.full_name !== operation.repository) {
      return undefined;
    }
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ id: body.id, full_name: body.full_name })),
      headers: [["content-type", "application/json"]],
      trailers: [],
    };
  },
};

export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["origin", "certFile", "peerOrigin", "capabilityOrigin", "releaseKey"],
  properties: {
    policyReduction: { type: "boolean" },
    ...Object.fromEntries(
      [
        "origin",
        "certFile",
        "peerOrigin",
        "capabilityOrigin",
        "releaseKey",
        "installationApiOrigin",
        "controlSecretFile",
      ].map((k) => [k, { type: "string" }]),
    ),
  },
};
type Config = {
  origin: string;
  certFile: string;
  peerOrigin: string;
  capabilityOrigin: string;
  releaseKey: string;
  installationApiOrigin?: string;
  policyReduction?: boolean;
  controlSecretFile?: string;
};
export function validateConfiguration(config: Readonly<Config>): readonly ErrorDetail[] {
  try {
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      Object.keys(config).some(
        (key) =>
          ![
            "origin",
            "certFile",
            "peerOrigin",
            "capabilityOrigin",
            "releaseKey",
            "installationApiOrigin",
            "policyReduction",
            "controlSecretFile",
          ].includes(key),
      ) ||
      [
        config.origin,
        config.certFile,
        config.peerOrigin,
        config.capabilityOrigin,
        config.releaseKey,
      ].some((value) => typeof value !== "string") ||
      (config.installationApiOrigin !== undefined &&
        typeof config.installationApiOrigin !== "string") ||
      (config.controlSecretFile !== undefined && typeof config.controlSecretFile !== "string") ||
      (config.policyReduction !== undefined && typeof config.policyReduction !== "boolean")
    ) {
      throw new Error("Invalid fixture configuration");
    }
    for (const origin of [
      config.origin,
      config.peerOrigin,
      config.capabilityOrigin,
      config.installationApiOrigin,
    ]) {
      if (origin === undefined) {
        continue;
      }
      const parsed = new URL(origin);
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "127.0.0.1" ||
        parsed.origin !== origin
      ) {
        throw new Error("Invalid fixture origin");
      }
    }
    if (config.capabilityOrigin === config.peerOrigin) {
      throw new Error("Invalid fixture scope");
    }
    return [];
  } catch {
    return [
      {
        path: "",
        code: "INVALID_VALUE",
        message:
          "Protected Git fixture requires distinct, exact loopback TLS origins and valid configuration.",
      },
    ];
  }
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
  reduction: {
    attempts: number;
    applies: number;
    requests: { operation: CredentialPolicyReduction; current: EgressInstallation | undefined }[];
    applied: { operationId: string; installation: EgressInstallation }[];
    observations: string[];
    loseReply: boolean;
    hideObservation: boolean;
    beforeApply?: () => Promise<void>;
  };
  observePolicy(): Promise<EgressInstallation>;
  delivery: {
    stage: string;
    metadataRefusal?: { stage: string; kind: string; code?: string };
    attempts: number;
    installs: number;
    reconciliations: number;
    loseReply: boolean;
    hideObservation: boolean;
    reportedVersion?: RepositoryGitMaterialVersion;
    confirmations: RepositoryGitMaterialVersion[];
    rejectedConfirmations: number;
    settled?: { materialVersion: string; expiresAt: string };
  };
};
export function createDriver(options: {
  id: string;
  implementation: string;
  configuration: Config;
}): DriverRegistration {
  const config = options.configuration;
  if (validateConfiguration(config).length > 0) {
    throw new Error(
      "Protected Git fixture requires distinct, exact loopback TLS origins and valid configuration.",
    );
  }
  const { origin, installationApiOrigin } = config;
  const base = releaseDriver({
    ...options,
    configuration: { endpoint: origin, ca: "unused" },
  });
  const { sandbox, credential_proxy: proxy } = base.capabilities;
  assert.ok(sandbox && proxy);
  const sender = proxy.sourceControl.sender;
  const clientSecret = randomUUID();
  const observationSecret = config.controlSecretFile
    ? readFileSync(config.controlSecretFile, "utf8")
    : randomUUID();
  const sandboxId = randomUUID();
  let status: EgressInstallation | undefined;
  const reductions = new Map<string, EgressInstallation>();
  const reduction: typeof peer.reduction = {
    attempts: 0,
    applies: 0,
    requests: [],
    applied: [],
    observations: [],
    loseReply: false,
    hideObservation: false,
  };
  const capabilityUrl = new URL("/capability", config.capabilityOrigin);
  const url = new URL(config.peerOrigin);
  const ca = readFileSync(config.certFile);
  const peerKeyId = createHash("sha256")
    .update(new X509Certificate(ca).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url");
  let exchangeAuthority: CredentialProxyExchange | undefined;
  const accepted = new Map<
    string,
    { use: CapturedEgressUse; association: AcceptedEgressAssociation }
  >();
  let authority: Authority;
  let route: Route | undefined;
  type Broad = NonNullable<Authority["githubInstallation"]>;
  type InstallationMaterial = Extract<
    Awaited<ReturnType<Broad["readMaterial"]>>,
    { value: string }
  >;
  type InstallationOperation = Parameters<Broad["authorize"]>[0]["operation"];
  let installed: Material | InstallationMaterial | undefined;
  // This receipt belongs to the recipient and survives controller binding replacement.
  let installedOperation: (Route & RepositoryGitMaterialVersion) | undefined;
  const delivery: typeof peer.delivery = {
    stage: "unbound",
    attempts: 0,
    installs: 0,
    reconciliations: 0,
    loseReply: false,
    hideObservation: false,
    confirmations: [],
    rejectedConfirmations: 0,
  };
  let apiUrl: URL;
  let checkedCapability = false;
  let authorization: "online-request" | undefined;
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
  const observe = async (
    lifetime = signal(),
  ): Promise<{
    installation: EgressInstallation;
    preparationAttemptId?: string;
    materialVersion?: string;
    operation?: Route & RepositoryGitMaterialVersion;
  }> => {
    const res = await exchange(new URL("/installation", url), {
      signal: lifetime,
      headers: { authorization: observationSecret },
    });
    assert.equal(res.statusCode, 200, "authenticated sender installation");
    return (await json(res)) as Awaited<ReturnType<typeof observe>>;
  };
  function configure(plan: ProxyPlan) {
    assert.ok(plan.repositoryGit && (config.policyReduction || !plan.routes.length));
    if (installationApiOrigin) {
      assert.equal(plan.repositoryGit.bindings[0]?.profile, "github-installation");
      assert.equal(checkedCapability, true, "release requires the installation delivery profile");
    }
    assert.equal(plan.repositoryGitAuthorization, authorization);
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
        ...(authorization ? {} : { peerKeyId }),
        policyHash: hash(JSON.stringify(plan)),
        repositoryGitRecipient: {
          attachmentEpoch: execution,
          providerId: sender.id,
          ...(authorization && { authorization }),
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
    route = undefined;
    const server = counterpart;
    assert.ok(server.listening, "only the worker binds the test-owned HTTPS counterpart");
    server.on(
      "request",
      async function serveProtectedRepositoryGitRequest(req: IncomingMessage, res: ServerResponse) {
        try {
          if (
            req.url === "/installation" &&
            req.method === "POST" &&
            req.headers.authorization === observationSecret
          ) {
            // Count authenticated delivery attempts even when parsing or duplicate rejection fails.
            delivery.attempts++;
            const input = (await json(req)) as {
              operation: Route & RepositoryGitMaterialVersion;
              material: Material | InstallationMaterial;
            };
            assert.deepEqual(input.operation.observed, status);
            assert.equal(input.operation.preparationAttemptId, input.material.preparationAttemptId);
            assert.equal(input.operation.materialVersion, input.material.materialVersion);
            assert.notEqual(
              input.operation.fence,
              installedOperation?.fence,
              "never reinstall an operation",
            );
            installedOperation = input.operation;
            installed = input.material;
            delivery.installs++;
            if (delivery.loseReply) {
              req.socket.destroy();
              return;
            }
            res.writeHead(204).end();
            return;
          }
          if (
            req.url === "/installation" &&
            req.method === "GET" &&
            req.headers.authorization === observationSecret
          ) {
            const { preparationAttemptId, materialVersion } =
              delivery.reportedVersion ?? installed ?? {};
            res.writeHead(status ? 200 : 503).end(
              JSON.stringify({
                installation: status,
                preparationAttemptId,
                materialVersion,
                ...(!delivery.hideObservation &&
                  installedOperation && { operation: installedOperation }),
              }),
            );
            return;
          }
          if (
            req.url === "/policy-reduction" &&
            req.method === "POST" &&
            req.headers.authorization === observationSecret &&
            config.policyReduction
          ) {
            // Count every authenticated POST, including malformed or repeated operations.
            reduction.attempts++;
            const operation = (await json(req)) as CredentialPolicyReduction;
            reduction.requests.push(structuredClone({ operation, current: status }));
            await reduction.beforeApply?.();
            assert.equal(operation.version, 2);
            assert.ok(status);
            assert.equal(reductions.has(operation.operationId), false, "never replay mutation");
            assert.deepEqual(
              operation.expected,
              status,
              "compare the actual recipient and current policy",
            );
            const before = status.plan;
            const next = operation.retained;
            assert.equal(next.generation, before.generation + 1);
            const gitRemoved =
              before.repositoryGit !== undefined && next.repositoryGit === undefined;
            assert.deepEqual(
              {
                ...next,
                generation: before.generation,
                routes: before.routes,
                ...(gitRemoved && { repositoryGit: before.repositoryGit }),
              },
              before,
            );
            assert.ok(gitRemoved || next.routes.length < before.routes.length);
            let cursor = 0;
            for (const entry of before.routes) {
              if (isDeepStrictEqual(entry, next.routes[cursor])) {
                cursor++;
              }
            }
            assert.equal(cursor, next.routes.length, "retained routes cannot widen");
            status = {
              ...status,
              plan: next,
              enforcement: {
                ...status.enforcement,
                configurationId: operation.operationId,
                policyHash: hash(JSON.stringify(next)),
              },
            };
            if (gitRemoved) {
              installed = undefined;
            }
            reductions.set(operation.operationId, structuredClone(status));
            reduction.applies++;
            reduction.applied.push({
              operationId: operation.operationId,
              installation: structuredClone(status),
            });
            if (reduction.loseReply) {
              req.socket.destroy();
              return;
            }
            res.writeHead(204).end();
            return;
          }
          if (
            req.url?.startsWith("/policy-reduction/") &&
            req.method === "GET" &&
            req.headers.authorization === observationSecret
          ) {
            const operationId = req.url.slice("/policy-reduction/".length);
            reduction.observations.push(operationId);
            const found = reductions.get(operationId);
            if (reduction.hideObservation || !found || !isDeepStrictEqual(found, status)) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(200).end(JSON.stringify({ operationId, installation: status }));
            return;
          }
          if (
            req.url?.startsWith("/repos/") &&
            req.method === "GET" &&
            req.headers.authorization === clientSecret
          ) {
            const selected = status?.plan.routes.find(
              (entry) => entry.path === req.url && entry.method === req.method,
            );
            if (!selected || !exchangeAuthority || !status) {
              res.writeHead(403).end();
              return;
            }
            // UUIDv7 identifies this one accepted transport exchange, never a caller-selected operation.
            const acceptedAt = Date.now();
            const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
            bytes.writeUIntBE(acceptedAt, 0, 6);
            bytes[6] = (bytes[6]! & 15) | 112;
            const hex = bytes.toString("hex");
            const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
            const input = {
              id,
              method: "GET",
              url: selected.origin + selected.path,
              headers: [] as [string, string][],
              body: new Uint8Array(),
              deadlineAt: new Date(acceptedAt + 5000).toISOString(),
              verifiedExecutionPolicyHash: status.enforcement.policyHash,
            };
            const resolved = await exchangeAuthority.resolve(
              observationSecret,
              status.sandboxId,
              input,
              signal(),
            );
            if (resolved.kind !== "ready_without_material") {
              if (resolved.kind === "refused") {
                delivery.metadataRefusal = {
                  stage: "resolve",
                  kind: resolved.error.kind,
                  ...("code" in resolved.error ? { code: resolved.error.code } : {}),
                };
              }
              res.writeHead(403).end();
              return;
            }
            const decision = await exchangeAuthority.authorizeSend(
              observationSecret,
              status.sandboxId,
              id,
              resolved.handle,
              true,
              hash(""),
              input.deadlineAt,
              signal(),
            );
            if (decision.kind !== "allow" || Date.now() >= Date.parse(decision.sendStartBy)) {
              if (decision.kind === "refused") {
                delivery.metadataRefusal = {
                  stage: "authorize-send",
                  kind: decision.error.kind,
                  ...("code" in decision.error ? { code: decision.error.code } : {}),
                };
              }
              res.writeHead(403).end();
              return;
            }
            const upstream = await exchange(new URL(input.url), { method: "GET" });
            const responseHandle = await exchangeAuthority.beginResponse(
              observationSecret,
              status.sandboxId,
              id,
            );
            const safe =
              responseHandle &&
              (await exchangeAuthority.protectResponse(
                responseHandle,
                {
                  status: upstream.statusCode!,
                  body: await buffer(upstream),
                  headers: [["content-type", "application/json"]],
                  trailers: [],
                },
                signal(),
              ));
            accepted.delete(id);
            if (!safe) {
              res.writeHead(502).end();
              return;
            }
            res.writeHead(safe.status, Object.fromEntries(safe.headers)).end(safe.body);
            return;
          }
          const m = installed;
          if (!status?.plan.repositoryGit || !route || !m) {
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
              (authorization ? host.online : host).githubInstallation!.authorize(
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
          if (decision.kind === "denied") {
            res.writeHead(403).end();
            return;
          }
          const online = decision.kind === "allow";
          assert.equal(online, authorization === "online-request");
          const deadline = online
            ? { replyBy: decision.replyBy }
            : { sendStartBy: decision.sendStartBy };
          assert.deepEqual(decision, {
            kind: online ? "allow" : "permit",
            exchangeId,
            requestDigestSha256,
            preparationAttemptId,
            materialVersion,
            ...deadline,
            ...(broad && {
              scope: "github-installation",
              operation,
              revisionId: route.revisionId,
              fence: route.fence,
            }),
          });
          const until = Date.parse(online ? decision.replyBy : decision.sendStartBy);
          assert.ok(Date.now() < until && until <= Date.parse(deadlineAt));
          // An online allow ends at the decision boundary. Only exact dispatch promises a start cutoff.
          const monoUntil = performance.now() + (until - Date.now());
          const current = () =>
            installed === m && (online || (Date.now() < until && performance.now() < monoUntil));
          const beforeSend = (stage: "connect" | "request") =>
            !online && peer.beforeSend?.(stage, decision, deadlineAt);
          await beforeSend("connect");
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
                void Promise.resolve(beforeSend("request"))
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
      reduction,
      observePolicy: async () => (await observe()).installation,
      delivery,
    };
    return {
      async reconcile(lifetime: AbortSignal) {
        lifetime.throwIfAborted();
        delivery.reconciliations++;
        delivery.stage = "awaiting-enrollment";
        if (!status) {
          return;
        }
        delivery.stage = "observe-installation";
        const seen = await observe(lifetime);
        if (seen.operation) {
          const original = seen.operation.observed as EgressInstallation;
          assert.equal(seen.installation.sandboxId, original.sandboxId);
          assert.deepEqual(seen.installation.sender, original.sender);
          assert.deepEqual(seen.installation.plan.execution, original.plan.execution);
          assert.equal(seen.installation.enforcement.instanceId, original.enforcement.instanceId);
          assert.deepEqual(
            seen.installation.enforcement.repositoryGitRecipient,
            original.enforcement.repositoryGitRecipient,
          );
          const { preparationAttemptId, materialVersion } = seen;
          if (!preparationAttemptId || !materialVersion) {
            return;
          }
          const evidence = { ...seen.operation, preparationAttemptId, materialVersion };
          delivery.stage = "confirm-installation";
          const confirmed = await host.recipients.confirmInstall(evidence);
          if (confirmed) {
            delivery.confirmations.push({ preparationAttemptId, materialVersion });
          } else if (
            preparationAttemptId !== seen.operation.preparationAttemptId ||
            materialVersion !== seen.operation.materialVersion
          ) {
            delivery.rejectedConfirmations++;
            return;
          }
        }
        delivery.stage = "resolve-recipient";
        route = await host.recipients.observe(seen.installation);
        if (!route) {
          return;
        }
        const sender = authorization ? host.online : host;
        const selected = installationApiOrigin ? sender.githubInstallation! : sender;
        if (installationApiOrigin) {
          const wrong = (authorization ? host : host.online).githubInstallation!;
          assert.deepEqual(
            await wrong.readMaterial(route!, lifetime),
            { absent: "unprepared" },
            "the other sender guarantee cannot receive this credential, including online on v4",
          );

          const legacy = await host.readMaterial(route!, lifetime);
          assert.ok(
            !legacy || !("value" in legacy),
            "repository Git port cannot disclose installation material",
          );
          const stale = await selected.readMaterial(
            { ...route!, fence: route!.fence - 1 },
            lifetime,
          );
          assert.ok(
            !stale || !("value" in stale),
            "a previous recipient cannot receive the current installation token",
          );
        }

        delivery.stage = "read-material";
        const m = await selected.readMaterial(route, lifetime);
        if (!m || !("value" in m)) {
          return;
        }
        if (
          seen.preparationAttemptId === m.preparationAttemptId &&
          seen.materialVersion === m.materialVersion
        ) {
          delivery.settled = { materialVersion: m.materialVersion, expiresAt: m.expiresAt };
          return;
        }
        delivery.stage = "begin-installation";
        const pending = await host.recipients.beginInstall(route, m);
        if (!pending) {
          return;
        }
        delivery.stage = "post-installation";
        const response = await exchange(
          new URL("/installation", url),
          {
            method: "POST",
            signal: lifetime,
            headers: { authorization: observationSecret },
          },
          Buffer.from(JSON.stringify({ operation: pending, material: m })),
        );
        response.resume();
        assert.equal(response.statusCode, 204);
        // Readback is always a separate authenticated request, even after a successful write.
        delivery.stage = "installation-readback";
        const observed = await observe(lifetime);
        if (
          observed.operation &&
          observed.preparationAttemptId === m.preparationAttemptId &&
          observed.materialVersion === m.materialVersion
        ) {
          route = await host.recipients.confirmInstall(observed.operation);
          if (route) {
            delivery.confirmations.push({
              preparationAttemptId: m.preparationAttemptId,
              materialVersion: m.materialVersion,
            });
            delivery.settled = { materialVersion: m.materialVersion, expiresAt: m.expiresAt };
          }
        }
      },
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
          routeReadiness: () => (route && delivery.settled ? "ready" : "pending"),
          materialSettledAt: () => undefined,
          isRouteBlockedError: () => false,
        },
      },
      credential_proxy: {
        ...proxy,
        ...(config.policyReduction && {
          policyReduction: {
            version: 2 as const,
            async assertAvailable(signal: AbortSignal) {
              const response = await exchange(
                new URL("/reduction-capability", config.capabilityOrigin),
                { signal },
              );
              assert.equal(response.statusCode, 200);
              assert.deepEqual(await json(response), {
                version: 2,
                repositoryGit: true,
                denyAll: true,
              });
            },
            async apply(_context: unknown, operation: CredentialPolicyReduction) {
              const response = await exchange(
                new URL("/policy-reduction", url),
                { method: "POST", headers: { authorization: observationSecret } },
                Buffer.from(JSON.stringify(operation)),
              );
              response.resume();
              assert.equal(response.statusCode, 204);
            },
            async observe(_context: unknown, operation: CredentialPolicyReduction) {
              const response = await exchange(
                new URL("/policy-reduction/" + operation.operationId, url),
                { headers: { authorization: observationSecret } },
              );
              if (response.statusCode !== 200) {
                response.resume();
                return undefined;
              }
              return (await json(response)) as {
                operationId: string;
                installation: EgressInstallation;
              };
            },
          },
        }),
        sourceControl: {
          ...proxy.sourceControl,
          providers: config.policyReduction ? [metadata] : [],
          assertAvailable: async (signal, profile) => {
            if (profile === undefined && config.policyReduction) {
              const response = await exchange(
                new URL("/reduction-capability", config.capabilityOrigin),
                { signal },
              );
              assert.equal(response.statusCode, 200);
              assert.deepEqual(await json(response), {
                version: 2,
                repositoryGit: true,
                denyAll: true,
              });
              return;
            }
            assert.equal(profile, installationApiOrigin ? "github_installation" : "repository_git");
            // The API registration knows only the configured peer and its public TLS certificate.
            const res = await exchange(capabilityUrl, { signal });
            assert.equal(res.statusCode, 200);
            const confirmed = await json(res);
            if (
              typeof confirmed === "object" &&
              confirmed !== null &&
              "profile" in confirmed &&
              confirmed.profile === profile &&
              "authorization" in confirmed &&
              confirmed.authorization === "online-request"
            ) {
              authorization = "online-request";
              checkedCapability = true;
              return { profile, authorization };
            }
            authorization = undefined;
            checkedCapability = confirmed === profile;
            return checkedCapability && profile === "github_installation" ? profile : undefined;
          },
        },
        async bindExchange(connect) {
          // A bound local control session has one expiry; revalidation cannot renew its identity.
          const expiresAt = new Date(Date.now() + 240_000).toISOString();
          exchangeAuthority = connect({
            async verify(authorization) {
              if (authorization !== observationSecret || !status) {
                return undefined;
              }
              return {
                sender,
                sandboxId: status.sandboxId,
                instanceId: status.enforcement.instanceId,
                peerKeyId,
                expiresAt,
              };
            },
            capture(use) {
              const association: AcceptedEgressAssociation = {
                execution: use.installation.plan.execution,
                installation: {
                  sandboxId: use.installation.sandboxId,
                  instanceId: use.installation.enforcement.instanceId,
                  configurationId: use.installation.enforcement.configurationId,
                  ...(use.installation.enforcement.peerKeyId === undefined
                    ? {}
                    : { peerKeyId: use.installation.enforcement.peerKeyId }),
                  policyHash: use.installation.enforcement.policyHash,
                  authorityScope: use.installation.enforcement.authorityScope,
                  plan: {
                    id: use.installation.plan.id,
                    generation: use.installation.plan.generation,
                  },
                },
                exchangeId: hash(use.id),
                responseId: randomBytes(32).toString("hex"),
                custodyId: randomBytes(32).toString("hex"),
              };
              accepted.set(use.id, { use, association });
              return association;
            },
            owns(association, use) {
              return isDeepStrictEqual(accepted.get(use.id)?.association, association);
            },
          });
          return {
            close() {
              exchangeAuthority = undefined;
              accepted.clear();
            },
          };
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
