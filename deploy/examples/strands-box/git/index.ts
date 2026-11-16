import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:https";
import type { Agent } from "node:https";
import { isAbsolute, join } from "node:path";
import { TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import type {
  CredentialProxyDriver,
  DriverRegistrationRef,
  EgressExecution,
  EgressInstallation,
  EgressRef,
  PreparedGitHubRepositoryUseRequest,
  ProtectedGitHubRepositoryMaterial,
  ProtectedRepositoryGitAuthority,
  RepositoryGitInstallationFence,
  RepositoryGitMaterialVersion,
} from "@openclaw-enterprise/contracts";
import {
  API_ORIGIN,
  boundedBody,
  confirmedDraft,
  planRequest,
  REPLY_LIMIT,
  repositorySelection,
  requestDigest,
} from "./protocol.ts";
import type { PlannedRequest, RepositorySelection } from "./protocol.ts";

type OnlineAuthority = NonNullable<ProtectedRepositoryGitAuthority["online"]["githubRepository"]>;
type Operation = PlannedRequest["operation"];
type Stage =
  | "received"
  | "execution-refused"
  | "request-refused"
  | "material-refused"
  | "write-already-attempted"
  | "authorization-refused"
  | "authorized"
  | "not-sent"
  | "provider-replied"
  | "outcome-unknown";

/** Read by the selected Driver from its real current recipient; never decoded from an HTTP request. */
export interface CurrentGitRecipient {
  readonly installation: EgressInstallation;
  readonly route: RepositoryGitInstallationFence;
  readonly version: RepositoryGitMaterialVersion;
  readonly original: {
    readonly running: true;
    readonly executionId: string;
    readonly bootId: string;
    readonly pid: number;
    readonly startTicks: string;
  };
  readonly clientKeySha256: string;
}

export interface GitReceipt {
  readonly requestId: string;
  readonly stage: Stage;
  readonly operation?: Operation;
  readonly exchangeId?: string;
  readonly reason?: "withdrawn" | "unprepared" | "unavailable";
  readonly providerStatus?: number;
}

export interface RepositorySenderOptions {
  readonly execution: EgressExecution;
  readonly driver: DriverRegistrationRef;
  readonly sender: EgressRef;
  readonly repository: RepositorySelection;
  /** Existing private directory outside Box, unique to this execution. */
  readonly journalDir: string;
  readonly current: (signal: AbortSignal) => Promise<CurrentGitRecipient | undefined>;
  readonly record: (receipt: GitReceipt) => void;
  /** Private construction dependency, never selected from a request or a deployment setting. */
  readonly upstreamAgent?: Agent;
}

type Snapshot = CurrentGitRecipient;
const REQUEST_MS = 15_000;
const MAX_REQUESTS = 4;
type WriteKind = "draft" | `push-${string}`;
const hex = /^[a-f0-9]{64}$/;
const boot = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function privateJournal(path: string): void {
  const info = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    !info.isDirectory() ||
    (info.mode & 0o7777) !== 0o700 ||
    uid === undefined ||
    uid === 0 ||
    info.uid !== uid
  ) {
    throw new Error("A canonical owner-only journal directory is required.");
  }
}

function certificateKey(request: IncomingMessage): string | undefined {
  if (!(request.socket instanceof TLSSocket) || !request.socket.authorized) {
    return;
  }
  const certificate = request.socket.getPeerCertificate().raw;
  if (!Buffer.isBuffer(certificate)) {
    return;
  }
  return createHash("sha256")
    .update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function eligible(
  input: Snapshot,
  options: Pick<RepositorySenderOptions, "execution" | "driver" | "sender">,
  key: string,
): boolean {
  const { plan, enforcement } = input.installation;
  const receiver = enforcement.repositoryGitRecipient;
  const git = plan.repositoryGit;
  const grants = git?.bindings;
  const original = input.original;
  return (
    isDeepStrictEqual(plan.execution, options.execution) &&
    isDeepStrictEqual(plan.driver, options.driver) &&
    plan.sandboxDriverId === options.driver.id &&
    plan.egressDriverId === options.driver.id &&
    isDeepStrictEqual(input.installation.sender, options.sender) &&
    input.installation.sandboxId.length > 0 &&
    enforcement.authorityScope === "execution" &&
    enforcement.peerKeyId === undefined &&
    enforcement.instanceId.length > 0 &&
    enforcement.configurationId.length > 0 &&
    hex.test(enforcement.policyHash) &&
    receiver !== undefined &&
    receiver.authorization === "online-request" &&
    receiver.deliveryProfile === "github_repository" &&
    receiver.observedHook === undefined &&
    receiver.providerId.length > 0 &&
    receiver.attachmentEpoch.length > 0 &&
    plan.repositoryGitAuthorization === "online-request" &&
    git !== undefined &&
    git.deadlineWallMs > Date.now() &&
    grants?.length === 1 &&
    grants[0]?.profile === "github-repository" &&
    original.running === true &&
    original.executionId === options.execution.executionId &&
    boot.test(original.bootId) &&
    Number.isSafeInteger(original.pid) &&
    original.pid > 1 &&
    /^[1-9][0-9]{0,19}$/.test(original.startTicks) &&
    receiver.processInstanceId === `${original.bootId}:${original.pid}:${original.startTicks}` &&
    input.clientKeySha256 === key &&
    hex.test(key) &&
    receiver.networkInstanceId === `mtls-sha256:${key}` &&
    input.route.revisionId === options.execution.revisionId &&
    Number.isSafeInteger(input.route.fence) &&
    input.route.fence > 0 &&
    isDeepStrictEqual(input.route.observed, input.installation) &&
    input.version.preparationAttemptId.length > 0 &&
    input.version.materialVersion.length > 0
  );
}

function matchesMaterial(
  material: ProtectedGitHubRepositoryMaterial,
  snapshot: Snapshot,
  repo: RepositorySelection,
): boolean {
  const grant = snapshot.installation.plan.repositoryGit?.bindings[0]?.grant;
  const [actual] = material.repositories;
  return (
    material.scope === "github-repository" &&
    material.installationId === repo.installationId &&
    material.apiOrigin === API_ORIGIN &&
    material.repositories.length === 1 &&
    actual?.repository === repo.repository &&
    actual.repositoryId === repo.repositoryId &&
    material.grantId === grant?.grantId &&
    material.providerInstanceId === grant?.providerInstanceId &&
    material.sessionId.length > 0 &&
    material.preparationAttemptId === snapshot.version.preparationAttemptId &&
    material.materialVersion === snapshot.version.materialVersion &&
    Date.parse(material.expiresAt) > Date.now() &&
    /^[A-Za-z0-9_.-]{8,512}$/.test(material.value)
  );
}

function reply(
  res: ServerResponse,
  status: number,
  body: Buffer = Buffer.alloc(0),
  type?: string,
): void {
  if (!res.destroyed && !res.headersSent) {
    res
      .writeHead(status, {
        "cache-control": "no-store",
        "content-length": String(body.length),
        ...(type === undefined ? {} : { "content-type": type }),
      })
      .end(body);
  }
}

async function journal(
  path: string,
  filename: `${WriteKind}-${"intent" | "result"}.json`,
  value: object,
) {
  privateJournal(path);
  const file = await open(join(path, filename), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(path, constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

interface ProviderResponse {
  readonly status: number;
  readonly type: string;
  readonly body: Buffer;
}

/** Connect only after authorization, and check again before any request bytes enter TLS. */
async function send(
  plan: PlannedRequest,
  value: string,
  agent: Agent | undefined,
  signal: AbortSignal,
  allowed: () => Promise<boolean>,
  sent: () => void,
): Promise<ProviderResponse> {
  const auth =
    plan.operation === "github-rest"
      ? `Bearer ${value}`
      : `Basic ${Buffer.from(`x-access-token:${value}`).toString("base64")}`;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const out = request(
      plan.origin,
      {
        method: plan.method,
        path: plan.path,
        headers: { ...plan.headers, authorization: auth },
        rejectUnauthorized: true,
        agent: agent ?? false,
        signal,
        maxHeaderSize: 8_192,
      },
      resolve,
    );
    out.once("error", reject);
    out.once("socket", (socket) => {
      if (!(socket instanceof TLSSocket)) {
        out.destroy(new Error("Expected a verified TLS socket."));
        return;
      }
      const start = () => {
        void (async () => {
          if (!socket.authorized || signal.aborted || !(await allowed()) || out.destroyed) {
            throw new Error("Send expired or withdrawn before writing.");
          }
          sent();
          out.end(plan.body);
        })().catch(() => out.destroy(new Error("Send expired or withdrawn before writing.")));
      };
      if (socket.authorized && !socket.connecting) {
        start();
      } else {
        socket.once("secureConnect", start);
      }
    });
  });
  const status = response.statusCode ?? 502;
  const types = response.headersDistinct["content-type"];
  const encoding = response.headersDistinct["content-encoding"];
  const type = types?.length === 1 ? (types[0]?.split(";")[0]?.toLowerCase() ?? "") : "";
  if (encoding !== undefined && (encoding.length !== 1 || encoding[0] !== "identity")) {
    response.destroy();
    throw new Error("Unexpected provider response encoding.");
  }
  const body = await boundedBody(response, REPLY_LIMIT, signal);
  if (
    body.includes(value) ||
    body.includes(auth) ||
    (auth.startsWith("Basic ") && body.includes(auth.slice(6)))
  ) {
    throw new Error("Provider response contains credential material.");
  }
  return { status, type, body };
}

/** Attach only as the selected paired Driver's Worker-side bindRepositoryGit capability. */
export function createRepositorySender(options: RepositorySenderOptions): {
  readonly bindRepositoryGit: NonNullable<CredentialProxyDriver["bindRepositoryGit"]>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
} {
  const repo = repositorySelection(options.repository);
  const fixed = structuredClone({
    execution: options.execution,
    driver: options.driver,
    sender: options.sender,
  });
  const { journalDir, record, current, upstreamAgent } = options;
  privateJournal(journalDir);
  const stopped = new AbortController();
  let authority: OnlineAuthority | undefined;
  let active = 0;

  const bindRepositoryGit: NonNullable<CredentialProxyDriver["bindRepositoryGit"]> = async (
    port,
  ) => {
    if (
      authority !== undefined ||
      stopped.signal.aborted ||
      port.online.githubRepository === undefined
    ) {
      throw new Error("The selected online GitHub repository authority is unavailable.");
    }
    authority = port.online.githubRepository;
    return { close: () => stopped.abort() };
  };

  return {
    bindRepositoryGit,
    async handle(req, res) {
      if (active >= MAX_REQUESTS) {
        reply(res, 503);
        return;
      }
      active++;
      const client = new AbortController();
      const closed = () => client.abort();
      res.once("close", closed);
      const signal = AbortSignal.any([
        stopped.signal,
        client.signal,
        AbortSignal.timeout(REQUEST_MS),
      ]);
      const requestId = randomUUID();
      let plan: PlannedRequest | undefined;
      let exchangeId: string | undefined;
      let phase: Stage = "execution-refused";
      let reserved: WriteKind | undefined;
      let sent = false;
      const emit = (stage: Stage, fields: Pick<GitReceipt, "reason" | "providerStatus"> = {}) => {
        try {
          record({
            requestId,
            stage,
            ...(plan === undefined ? {} : { operation: plan.operation }),
            ...(exchangeId === undefined ? {} : { exchangeId }),
            ...fields,
          });
        } catch {
          // Telemetry does not convert a completed provider send into a retry.
        }
      };
      try {
        const selected = authority;
        const key = certificateKey(req);
        const initial =
          selected !== undefined && key !== undefined && !signal.aborted
            ? await current(signal)
            : undefined;
        if (!selected || !key || !initial || !eligible(initial, fixed, key) || signal.aborted) {
          emit(phase);
          reply(res, 403);
          return;
        }
        const snapshot = structuredClone(initial);
        phase = "request-refused";
        plan = await planRequest(req, repo, signal);
        if (!plan) {
          emit(phase);
          reply(res, 403);
          return;
        }
        emit("received");
        phase = "material-refused";
        const material = await selected.readMaterial(snapshot.route, signal);
        if (
          !material ||
          "absent" in material ||
          !matchesMaterial(material, snapshot, repo) ||
          signal.aborted
        ) {
          emit(phase, {
            reason: material && "absent" in material ? material.absent : "unavailable",
          });
          reply(res, 403);
          return;
        }
        const candidate = randomUUID();
        const digest = requestDigest(plan);
        const write: WriteKind | undefined =
          plan.operation === "github-rest"
            ? "draft"
            : plan.operation === "receive-pack"
              ? `push-${createHash("sha256").update(plan.body).digest("hex")}`
              : undefined;
        if (write !== undefined) {
          phase = "not-sent";
          try {
            await journal(journalDir, `${write}-intent.json`, {
              requestId,
              exchangeId: candidate,
              requestDigestSha256: digest,
            });
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") {
              emit("write-already-attempted");
              reply(res, 403);
              return;
            }
            throw error;
          }
          reserved = write;
        }
        exchangeId = candidate;
        phase = "authorization-refused";
        const deadline = Date.now() + Math.min(5_000, Date.parse(material.expiresAt) - Date.now());
        if (!(Date.now() < deadline) || signal.aborted) {
          throw new Error("Request expired before authorization.");
        }
        const use: PreparedGitHubRepositoryUseRequest = {
          scope: "github-repository",
          operation: plan.operation,
          providerInstanceId: material.providerInstanceId,
          grantId: material.grantId,
          sessionId: material.sessionId,
          installationId: material.installationId,
          repositories: [{ repositoryId: repo.repositoryId, repository: repo.repository }],
          exchangeId,
          requestDigestSha256: digest,
          deadlineAt: new Date(deadline).toISOString(),
        };
        const decision = await selected.authorize(
          use,
          {
            route: snapshot.route,
            ...snapshot.version,
          },
          signal,
        );
        const replyBy = decision.kind === "allow" ? Date.parse(decision.replyBy) : 0;
        if (
          decision.kind !== "allow" ||
          decision.exchangeId !== exchangeId ||
          decision.requestDigestSha256 !== digest ||
          decision.preparationAttemptId !== snapshot.version.preparationAttemptId ||
          decision.materialVersion !== snapshot.version.materialVersion ||
          !(Date.now() < replyBy && replyBy <= deadline) ||
          signal.aborted
        ) {
          emit(phase, {
            reason:
              decision.kind === "denied" && decision.reason === "access_withdrawn"
                ? "withdrawn"
                : "unavailable",
          });
          if (reserved)
            await journal(journalDir, `${reserved}-result.json`, {
              exchangeId,
              status: "not-sent",
            });
          reply(res, 403);
          return;
        }
        emit("authorized");
        phase = "not-sent";
        const monoLimit = performance.now() + (replyBy - Date.now());
        const within = () =>
          !signal.aborted && Date.now() < replyBy && performance.now() < monoLimit;
        const allowed = async () => {
          if (!within()) return false;
          const refreshed = await current(signal);
          return (
            within() &&
            refreshed !== undefined &&
            eligible(refreshed, fixed, key) &&
            isDeepStrictEqual(snapshot, refreshed)
          );
        };
        if (!(await allowed())) throw new Error("The selected recipient changed before dispatch.");
        const provider = await send(plan, material.value, upstreamAgent, signal, allowed, () => {
          sent = true;
        });
        phase = "outcome-unknown";
        if (plan.operation === "github-rest") {
          if (provider.status !== 201 || provider.type !== plan.expectedContentType) {
            throw new Error("The provider did not return a verified new draft.");
          }
          const draft = confirmedDraft(provider.body, repo);
          await journal(journalDir, "draft-result.json", { exchangeId, status: "created", draft });
          emit("provider-replied", { providerStatus: 201 });
          reply(res, 201, Buffer.from(JSON.stringify(draft)), "application/json");
        } else {
          // A Git protocol response is evidence of a provider reply, not a push
          // verdict. The Git client interprets report-status and verifies refs.
          if (reserved?.startsWith("push-")) {
            await journal(journalDir, `${reserved}-result.json`, {
              exchangeId,
              status: "provider-replied",
              providerStatus: provider.status,
            });
          }
          emit("provider-replied", { providerStatus: provider.status });
          if (provider.status === 200 && provider.type === plan.expectedContentType) {
            reply(res, 200, provider.body, provider.type);
          } else {
            reply(res, 502);
          }
        }
      } catch {
        const failure = sent ? "outcome-unknown" : phase;
        if (reserved) {
          try {
            await journal(journalDir, `${reserved}-result.json`, {
              exchangeId,
              status: sent ? "outcome-unknown" : "not-sent",
            });
          } catch {
            // The exclusive durable intent remains. Never replay a write.
          }
        }
        emit(failure);
        reply(res, sent ? 502 : 403);
      } finally {
        res.off("close", closed);
        active--;
      }
    },
  };
}
