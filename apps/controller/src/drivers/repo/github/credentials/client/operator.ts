import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepositoryCredentialBoundSessionInput } from "../../../credentials/service-contracts.ts";
import { readPrivateFile } from "./private-files.ts";
import { hasControlCharacter } from "../../../credentials/client-contracts.ts";
import type { ControlRequest, ControlResponse } from "../../../credentials/control-contracts.ts";
import { writeClientConfiguration } from "./config.ts";

export async function callControl(
  socket: string,
  request: ControlRequest,
  admissionId = `${Date.now()}-${randomUUID()}`,
): Promise<ControlResponse> {
  if (
    !socket.startsWith("/") ||
    socket.length > 103 ||
    !/^\/v1\/sessions(?:\/[A-Za-z0-9_-]{1,128}(?:\/close)?)?$/.test(request.path)
  ) {
    throw new Error("invalid-control-request");
  }
  if (!/^[0-9]{13}-[0-9a-f-]{36}$/.test(admissionId)) {
    throw new Error("invalid-admission-id");
  }
  const body = "body" in request ? JSON.stringify(request.body) : "";
  if (Buffer.byteLength(body) > 16 * 1024) {
    throw new Error("invalid-control-request");
  }
  return new Promise((resolveResponse, reject) => {
    const fail = (): void => reject(new Error(`control-request-failed admission=${admissionId}`));
    const outgoing = httpRequest(
      {
        socketPath: socket,
        path: request.path,
        method: request.method,
        agent: false,
        headers: {
          Host: "localhost",
          ...(request.path === "/v1/sessions" ? { "X-Admission-Id": admissionId } : {}),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) {
            response.destroy();
            outgoing.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", fail);
        response.once("end", () => {
          try {
            if (!response.complete || response.statusCode === undefined) {
              throw new Error("control-request-failed");
            }
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ControlResponse;
            if (value === null || typeof value !== "object") {
              throw new Error("control-request-failed");
            }
            if ("error" in value) {
              if (
                ![
                  "invalid-request",
                  "not-found",
                  "admission-missing",
                  "unavailable",
                  "overloaded",
                ].includes(value.error)
              ) {
                throw new Error("control-request-failed");
              }
              resolveResponse({ error: value.error });
            } else {
              if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error("control-request-failed");
              }
              resolveResponse(value);
            }
          } catch {
            fail();
          }
        });
      },
    );
    const timer = setTimeout(() => outgoing.destroy(new Error("control-request-timeout")), 5000);
    outgoing.once("error", fail);
    outgoing.once("close", () => clearTimeout(timer));
    outgoing.end(body);
  });
}

async function readBoundRequest(path: string): Promise<RepositoryCredentialBoundSessionInput> {
  const value: unknown = JSON.parse(
    (await readPrivateFile(resolve(path), 16 * 1024)).toString("utf8"),
  );
  const isRecord = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  const isString = (input: unknown): input is string =>
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 512 &&
    !hasControlCharacter(input);
  if (!isRecord(value) || !isRecord(value.expectedBinding)) {
    throw new Error("invalid-arguments");
  }
  const binding = value.expectedBinding;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "durationSeconds",
          "profile",
          "namespaceId",
          "repositoryRef",
          "expectedBinding",
          "deadlineWallMs",
          "recoverOnly",
        ].includes(key),
    ) ||
    Object.keys(binding).some(
      (key) => !["providerInstanceId", "repositoryId", "grantId"].includes(key),
    ) ||
    !Number.isSafeInteger(value.durationSeconds) ||
    Number(value.durationSeconds) <= 0 ||
    !Number.isSafeInteger(value.deadlineWallMs) ||
    Number(value.deadlineWallMs) <= 0 ||
    !isString(value.profile) ||
    !isString(value.namespaceId) ||
    !isString(value.repositoryRef) ||
    !isString(binding.providerInstanceId) ||
    !isString(binding.repositoryId) ||
    !isString(binding.grantId) ||
    (Object.hasOwn(value, "recoverOnly") && value.recoverOnly !== true)
  ) {
    throw new Error("invalid-arguments");
  }
  const request: RepositoryCredentialBoundSessionInput = {
    durationSeconds: Number(value.durationSeconds),
    profile: value.profile,
    namespaceId: value.namespaceId,
    repositoryRef: value.repositoryRef,
    expectedBinding: {
      providerInstanceId: binding.providerInstanceId,
      repositoryId: binding.repositoryId,
      grantId: binding.grantId,
    },
    deadlineWallMs: Number(value.deadlineWallMs),
    durableAdmission: true,
  };
  return Object.hasOwn(value, "recoverOnly") ? { ...request, recoverOnly: true } : request;
}

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!name.startsWith("--") || !value || options.has(name)) {
      throw new Error("invalid-arguments");
    }
    options.set(name, value);
  }
  const allowed =
    operation === "open"
      ? [
          "--socket",
          "--duration-seconds",
          "--profile",
          "--request-json",
          "--output",
          "--ca",
          "--admission-id",
        ]
      : ["--socket", "--session"];
  if ([...options.keys()].some((key) => !allowed.includes(key))) {
    throw new Error("invalid-arguments");
  }
  const socket = options.get("--socket");
  if (!socket) {
    throw new Error("invalid-arguments");
  }
  if (operation === "open") {
    const requestPath = options.get("--request-json");
    const directory = options.get("--output");
    if (
      !directory ||
      (requestPath && (options.has("--duration-seconds") || options.has("--profile")))
    ) {
      throw new Error("invalid-arguments");
    }
    const body = requestPath
      ? await readBoundRequest(requestPath)
      : {
          durationSeconds: Number(options.get("--duration-seconds")),
          profile: options.get("--profile"),
        };
    if (!Number.isSafeInteger(body.durationSeconds) || body.durationSeconds <= 0) {
      throw new Error("invalid-arguments");
    }
    const caPath = options.get("--ca");
    const ca = caPath ? await readFile(caPath) : undefined;
    if (ca && ca.length > 64 * 1024) {
      throw new Error("invalid-ca");
    }
    const admissionId = options.get("--admission-id") ?? `${Date.now()}-${randomUUID()}`;
    if (!/^[0-9]{13}-[0-9a-f-]{36}$/.test(admissionId)) {
      throw new Error("invalid-admission-id");
    }
    process.stderr.write(
      `credential-admission ${admissionId}; recover with open --admission-id and the same inputs\n`,
    );
    const result = await callControl(
      socket,
      {
        method: "POST",
        path: "/v1/sessions",
        body,
      },
      admissionId,
    );
    if ("error" in result) {
      process.stderr.write(`credential-operator-${result.error}\n`);
      process.exitCode = 1;
      return;
    }
    if (!("bearer" in result)) {
      if (!("state" in result)) {
        throw new Error("invalid-control-response");
      }
      process.stdout.write(JSON.stringify({ ...result, recovered: true }) + "\n");
      process.stderr.write(
        `credential-admission-recovered session=${result.sessionId}; close this session, then open with a new admission ID\n`,
      );
      return;
    }
    try {
      await writeClientConfiguration(result, directory, ca);
    } catch {
      // Admission succeeded; retain the identifier for recovery, never the bearer.
      await callControl(socket, {
        method: "POST",
        path: `/v1/sessions/${result.session.sessionId}/close`,
      }).catch(() => undefined);
      process.stderr.write(
        `client-configuration-failed session=${result.session.sessionId}; inspect cleanup status\n`,
      );
      throw new Error("client-configuration-failed");
    }
    process.stdout.write(
      JSON.stringify({ ...result.session, clientDirectory: resolve(directory) }) + "\n",
    );
  } else if (operation === "status" || operation === "close") {
    const id = options.get("--session");
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error("invalid-arguments");
    }
    const result = await callControl(
      socket,
      operation === "status"
        ? { method: "GET", path: `/v1/sessions/${id}` }
        : { method: "POST", path: `/v1/sessions/${id}/close` },
    );
    if ("error" in result) {
      process.stderr.write(`credential-operator-${result.error}\n`);
      process.exitCode = 1;
      return;
    }
    if (!("state" in result)) {
      throw new Error("invalid-control-response");
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    throw new Error("invalid-arguments");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("credential-operator-failed\n");
    process.exitCode = 1;
  });
}
