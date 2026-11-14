import type { IncomingMessage } from "node:http";
import { createServer, request, type ServerOptions } from "node:https";
import type { Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import type { ProtectedRepositoryGitAuthority } from "@openclaw-enterprise/contracts";
import { loadPublicCa } from "../../composition/repository-credentials/public-ca.ts";
import { readProtectedFile } from "../../composition/repository-credentials/protected-file.ts";
import type { RemotePreparedGitConfiguration } from "./remote-prepared-git-config.ts";
import { inspectRequestHead } from "../../drivers/repo/access/transport/request.ts";

const path = "/v1/prepared-git/authority";
const maxBytes = 128 * 1024;
const unavailable = () => new Error("PREPARED_REPOSITORY_GIT_UNAVAILABLE");
const denied = { kind: "denied", reason: "unavailable" } as const;
const revisionPattern = /^rev_[0-9a-f-]{36}$/;
const versionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readJson(message: IncomingMessage): Promise<unknown> {
  const buffers: Buffer[] = [];
  try {
    let length = 0;
    for await (const chunk of message) {
      const buffer = Buffer.from(chunk);
      buffers.push(buffer);
      length += buffer.length;
      if (length > maxBytes) {
        throw unavailable();
      }
    }
    const bytes = Buffer.concat(buffers, length);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const buffer of buffers) {
      buffer.fill(0);
    }
  }
}

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw unavailable();
  }
  return input as Record<string, unknown>;
}

function fields(input: Record<string, unknown>, ...keys: string[]) {
  if (
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(input, key))
  ) {
    throw unavailable();
  }
}

type Authority = ProtectedRepositoryGitAuthority;
type Recipient = Parameters<Authority["recipients"]["observe"]>[0];
type Route = NonNullable<Awaited<ReturnType<Authority["recipients"]["observe"]>>>;
type Version = Parameters<Authority["recipients"]["beginInstall"]>[1];
type Repository = NonNullable<Authority["online"]["githubRepository"]>;
type UseRequest = Parameters<Repository["authorize"]>[0];

function route(input: unknown, withVersion = false): Route {
  const value = record(input);
  fields(
    value,
    "revisionId",
    "fence",
    "observed",
    ...(withVersion ? ["preparationAttemptId", "materialVersion"] : []),
  );
  if (
    typeof value.revisionId !== "string" ||
    !revisionPattern.test(value.revisionId) ||
    typeof value.fence !== "number" ||
    !Number.isSafeInteger(value.fence) ||
    value.fence < 1
  ) {
    throw unavailable();
  }
  record(value.observed);
  return {
    revisionId: value.revisionId,
    fence: value.fence,
    observed: value.observed,
  };
}

function version(value: unknown, withRoute = false): Version {
  const input = record(value);
  if (!withRoute) {
    fields(input, "preparationAttemptId", "materialVersion");
  }
  const { preparationAttemptId, materialVersion } = input;
  if (
    typeof preparationAttemptId !== "string" ||
    !versionPattern.test(preparationAttemptId) ||
    typeof materialVersion !== "string" ||
    !versionPattern.test(materialVersion)
  ) {
    throw unavailable();
  }
  return { preparationAttemptId, materialVersion };
}

function dispatch(authority: Authority, input: Record<string, unknown>, signal: AbortSignal) {
  const repository = authority.online.githubRepository!;
  switch (input.operation) {
    case "observe": {
      fields(input, "operation", "installation");
      const installation = record(input.installation);
      record(record(installation.plan).execution);
      return authority.recipients.observe(installation as unknown as Recipient);
    }
    case "read":
      fields(input, "operation", "route");
      return repository.readMaterial(route(input.route), signal);
    case "begin":
      fields(input, "operation", "route", "version");
      return authority.recipients.beginInstall(route(input.route), version(input.version));
    case "confirm":
      fields(input, "operation", "pending");
      return authority.recipients.confirmInstall({
        ...route(input.pending, true),
        ...version(input.pending, true),
      });
    case "authorize": {
      fields(input, "operation", "request", "installed");
      const installed = record(input.installed);
      fields(installed, "preparationAttemptId", "materialVersion", "route");
      return repository.authorize(
        input.request as UseRequest,
        { ...version(installed, true), route: route(installed.route) },
        signal,
      );
    }
    default:
      throw unavailable();
  }
}

function authorizedWorker(socket: Socket, expected: string) {
  return (
    socket instanceof TLSSocket &&
    socket.authorized &&
    socket.getPeerX509Certificate()?.fingerprint256.replaceAll(":", "").toLowerCase() === expected
  );
}

export async function serveRemotePreparedGit(
  authority: Authority,
  tls: Pick<ServerOptions, "cert" | "key" | "ca">,
  endpoint: { host: string; port: number; workerFingerprintSha256: string },
) {
  if (
    !authority.online.githubRepository ||
    !/^[0-9a-f]{64}$/.test(endpoint.workerFingerprintSha256)
  ) {
    throw unavailable();
  }
  const stop = new AbortController();
  const pending = new Set<Promise<void>>();
  const sockets = new Set<Socket>();
  const server = createServer(
    {
      ...tls,
      minVersion: "TLSv1.2",
      requestCert: true,
      rejectUnauthorized: true,
      maxHeaderSize: 4096,
      headersTimeout: 3000,
      requestTimeout: 10_000,
    },
    (req, res) => {
      if (!authorizedWorker(req.socket, endpoint.workerFingerprintSha256) || stop.signal.aborted) {
        res.writeHead(403, { connection: "close" }).end();
        return;
      }
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      const signal = AbortSignal.any([stop.signal, abort.signal, AbortSignal.timeout(10_000)]);
      const execute = async () => {
        const head = inspectRequestHead(req, {
          authority: req.headers.host ?? "",
          receivedMonoMs: 0,
          headerBytes: 4096,
          headerPairs: 8,
          targetBytes: 128,
        });
        if (
          head.kind === "denied" ||
          head.authorization !== undefined ||
          head.expectContinue ||
          head.head.contentEncoding !== "identity" ||
          head.head.method !== "POST" ||
          head.head.rawTarget !== path ||
          head.head.headers["content-type"] !== "application/json" ||
          head.head.framing.kind !== "length" ||
          (head.head.framing.bytes ?? 0) > maxBytes
        ) {
          throw unavailable();
        }
        const input = record(await readJson(req));
        signal.throwIfAborted();
        const headers = { "cache-control": "no-store", connection: "close" };
        if (input.operation === "probe") {
          fields(input, "operation");
          res.writeHead(204, headers).end();
          return;
        }
        const result = await dispatch(authority, input, signal);
        signal.throwIfAborted();
        if (result === undefined) {
          res.writeHead(204, headers).end();
          return;
        }
        const body = Buffer.from(JSON.stringify(result));
        res.writeHead(200, {
          ...headers,
          "content-type": "application/json",
          "content-length": body.length,
        });
        res.end(body, () => body.fill(0));
      };
      const running = execute().catch(() => {
        if (!res.destroyed && !res.headersSent) {
          res
            .writeHead(503, {
              connection: "close",
              "cache-control": "no-store",
            })
            .end();
        }
      });
      pending.add(running);
      void running.finally(() => pending.delete(running));
    },
  );
  server.maxRequestsPerSocket = 1;
  server.on("connection", (socket) => {
    if (stop.signal.aborted || sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.port, endpoint.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw unavailable();
  }
  return {
    port: address.port,
    async close() {
      stop.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) {
        socket.destroy();
      }
      await closed;
      await Promise.allSettled(pending);
    },
  };
}

export async function preparedGitTlsIdentity(
  certificatePath: string,
  privateKeyPath: string,
  caPath: string,
) {
  const ca = await loadPublicCa(caPath);
  const cert = await loadPublicCa(certificatePath);
  const identity = await readProtectedFile(privateKeyPath, 65536);
  if (!identity.ok) {
    throw unavailable();
  }
  try {
    createSecureContext({
      cert,
      key: identity.bytes,
      ca,
      minVersion: "TLSv1.2",
    });
    return { cert, key: identity.bytes, ca };
  } catch {
    identity.bytes.fill(0);
    throw unavailable();
  }
}

export async function connectRemotePreparedGit(
  config: RemotePreparedGitConfiguration,
): Promise<{ readonly protectedGit: Authority; close(): Promise<void> }> {
  const tls = await preparedGitTlsIdentity(
    config.workerCertificatePath,
    config.workerPrivateKeyPath,
    config.issuerCaPath,
  );
  const origin = new URL(path, config.issuerEndpoint);
  const stop = new AbortController();
  const call = <T>(input: object, signal = stop.signal): Promise<T | undefined> => {
    const lifetime = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(10_000)]);
    const body = Buffer.from(JSON.stringify(input));
    return new Promise((resolve, reject) => {
      const req = request(
        origin,
        {
          ...tls,
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          agent: false,
          method: "POST",
          signal: lifetime,
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            connection: "close",
          },
        },
        (res) => {
          if (res.statusCode === 204) {
            res.resume();
            resolve(undefined);
          } else if (res.statusCode === 200 && res.headers["content-type"] === "application/json") {
            void readJson(res).then(
              (value) => resolve(value as T),
              () => reject(unavailable()),
            );
          } else {
            res.destroy();
            reject(unavailable());
          }
        },
      );
      req.once("error", () => reject(unavailable()));
      req.end(body);
    });
  };
  try {
    await call({ operation: "probe" });
  } catch (error) {
    stop.abort();
    tls.key.fill(0);
    throw error;
  }
  const repository: Repository = {
    readMaterial: (route, signal) => call({ operation: "read", route }, signal),
    authorize: async (request, installed, signal) => {
      try {
        return (
          (await call<Awaited<ReturnType<Repository["authorize"]>>>(
            { operation: "authorize", request, installed },
            signal,
          )) ?? denied
        );
      } catch {
        // There may be a committed possible-use receipt. Never repeat this exchange.
        return denied;
      }
    },
  };
  return {
    protectedGit: {
      recipients: {
        observe: (installation) => call({ operation: "observe", installation }),
        beginInstall: (route, version) => call({ operation: "begin", route, version }),
        confirmInstall: (pending) => call({ operation: "confirm", pending }),
      },
      online: {
        githubRepository: repository,
        readMaterial: async () => undefined,
        authorize: async () => denied,
      },
      readMaterial: async () => undefined,
      authorize: async () => denied,
    } satisfies Authority,
    async close() {
      stop.abort();
      tls.key.fill(0);
    },
  };
}
