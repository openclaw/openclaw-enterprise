import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { createServer, request, type ClientRequest } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { admissionIdTimestamp } from "../../../apps/controller/src/drivers/repo/access/admission-id.ts";
import { matchesRepositorySessionId } from "../../../apps/controller/src/drivers/repo/access/client-contracts.ts";
import type { FixtureOwner } from "./registry/material.ts";

export interface DroppedAdmission {
  readonly admissionId: string;
  readonly sessionId: string;
}

type AdmissionFault =
  { kind: "armed" } | { kind: "dropped"; admission: DroppedAdmission } | { kind: "invalid" };

function readAdmission(admissionId: string | string[] | undefined, body: Buffer) {
  if (typeof admissionId !== "string" || admissionIdTimestamp(admissionId) === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || !("session" in value)) {
    return undefined;
  }
  const { session } = value;
  if (session === null || typeof session !== "object" || !("sessionId" in session)) {
    return undefined;
  }
  const { sessionId } = session;
  if (typeof sessionId !== "string" || !matchesRepositorySessionId(sessionId)) {
    return undefined;
  }
  return { admissionId, sessionId };
}

export async function startControlResponseRelay(
  scope: FixtureOwner,
  { directory, target }: { directory: string; target: string },
) {
  const socketPath = join(directory, "control-relay.sock");
  const connections = new Set<Socket | ClientRequest>();
  let fault: AdmissionFault | undefined;
  let hideCapabilities = false;

  const track = (connection: Socket | ClientRequest) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  };

  const server = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        socketPath: target,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 128 * 1024) {
            response.destroy();
            outgoing.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", () => outgoing.destroy());
        response.once("end", () => {
          const status = response.statusCode;
          if (!response.complete || status === undefined || outgoing.destroyed) {
            outgoing.destroy();
            return;
          }
          if (
            hideCapabilities &&
            incoming.method === "GET" &&
            incoming.url === "/v1/capabilities"
          ) {
            outgoing.writeHead(404, { "content-type": "application/json" });
            outgoing.end('{"error":"not-found"}');
            return;
          }

          const body = Buffer.concat(chunks);
          if (
            fault?.kind === "armed" &&
            incoming.method === "POST" &&
            incoming.url === "/v1/sessions" &&
            status === 201
          ) {
            // The broker has committed the admission. Disconnect before the worker receives
            // any response bytes, and hide the capability before its next claim.
            const admission = readAdmission(incoming.headers["x-admission-id"], body);
            hideCapabilities = true;
            outgoing.destroy();
            fault = admission === undefined ? { kind: "invalid" } : { kind: "dropped", admission };
            return;
          }
          outgoing.writeHead(status, response.headers);
          outgoing.end(body);
        });
      },
    );
    track(upstream);
    upstream.once("socket", track);
    upstream.on("error", () => outgoing.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.on("error", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", track);

  async function closeRelay() {
    const listener = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    const closed = [...connections].map(
      (connection) =>
        new Promise<void>((resolve) => {
          connection.once("close", () => resolve());
          connection.destroy();
        }),
    );
    await Promise.all([listener, ...closed]);
  }

  let closing: Promise<void> | undefined;
  scope.after(() => (closing ??= closeRelay()));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    setCapabilitiesHidden(hidden: boolean) {
      hideCapabilities = hidden;
    },
    dropNextAdmissionResponse(): () => DroppedAdmission | undefined {
      assert.equal(fault, undefined, "only one admission response may be dropped");
      fault = { kind: "armed" };
      return () => {
        assert.notEqual(
          fault?.kind,
          "invalid",
          "the completed broker 201 must identify the admission and session",
        );
        return fault?.kind === "dropped" ? fault.admission : undefined;
      };
    },
  };
}
