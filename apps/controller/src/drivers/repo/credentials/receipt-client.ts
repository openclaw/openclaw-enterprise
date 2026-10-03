import { request } from "node:http";
import { dirname, join } from "node:path";
import type { RepositoryCredentialBoundSessionInput, SessionStatus } from "./service-contracts.ts";
import { sameBinding } from "./sessions.ts";

/** The broker sends only admission identities and already-observed terminal evidence. */
export class RepositoryReceiptClient {
  private readonly path: string;
  private readonly generation: string;

  constructor(controlSocket: string, generation: string) {
    this.path = join(dirname(controlSocket), "receipt.sock");
    this.generation = generation;
  }

  async admission(id: string, input: RepositoryCredentialBoundSessionInput, recoverOnly: boolean) {
    const result = await this.call({
      kind: recoverOnly ? "recover" : "reserve",
      admissionId: id,
      generation: this.generation,
      input,
    });
    if (result.kind === "missing") {
      return { kind: "missing" as const };
    }
    if (result.kind === "reserved") {
      return { kind: "reserved" as const };
    }
    if (result.kind === "disposed") {
      const observed = this.terminal(result.status);
      if (
        !sameBinding(observed.binding, input.expectedBinding) ||
        observed.deadlineWallMs > input.deadlineWallMs
      ) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      return { kind: "disposed" as const, status: observed };
    }
    throw new Error("RECEIPT_UNAVAILABLE");
  }

  async bind(
    id: string,
    input: RepositoryCredentialBoundSessionInput,
    status: SessionStatus,
  ): Promise<void> {
    const result = await this.call({
      kind: "bind",
      admissionId: id,
      generation: this.generation,
      input,
      status,
    });
    if (result.kind !== "acknowledged") {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
  }

  async dispose(
    id: string,
    input: RepositoryCredentialBoundSessionInput,
    status: SessionStatus,
  ): Promise<void> {
    const result = await this.call({
      kind: "dispose",
      admissionId: id,
      generation: this.generation,
      input,
      status,
    });
    if (result.kind !== "acknowledged") {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
  }

  async fence(id: string, input: RepositoryCredentialBoundSessionInput): Promise<void> {
    const result = await this.call({
      kind: "fence",
      admissionId: id,
      generation: this.generation,
      input,
    });
    if (result.kind !== "acknowledged") {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
  }

  async status(sessionId: string): Promise<SessionStatus | undefined> {
    const result = await this.call({ kind: "status", sessionId });
    if (result.kind === "missing") {
      return undefined;
    }
    if (result.kind !== "disposed") {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
    const observed = this.terminal(result.status);
    if (observed.sessionId !== sessionId) {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
    return observed;
  }

  private terminal(value: unknown): SessionStatus {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
    const status = value as SessionStatus;
    if (
      status.state !== "DISPOSED" ||
      typeof status.sessionId !== "string" ||
      !Number.isSafeInteger(status.deadlineWallMs) ||
      status.deadlineWallMs <= 0 ||
      !status.binding ||
      !status.cleanup ||
      status.activeUses !== 0 ||
      status.cleanup.active !== 0 ||
      status.cleanup.pending !== 0 ||
      status.cleanup.uncertain !== 0 ||
      status.cleanup.auxiliaryPending !== false ||
      !Number.isSafeInteger(status.cleanup.revoked) ||
      status.cleanup.revoked < 0 ||
      !Number.isSafeInteger(status.cleanup.expired) ||
      status.cleanup.expired < 0
    ) {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
    return status;
  }

  private async call(input: object): Promise<Record<string, unknown>> {
    const body = Buffer.from(JSON.stringify(input));
    if (body.length > 16384) {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
    return new Promise((done, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const outgoing = request(
        {
          socketPath: this.path,
          path: "/v1/receipt",
          method: "POST",
          agent: false,
          signal: AbortSignal.timeout(5000),
          headers: {
            host: "localhost",
            connection: "close",
            "content-type": "application/json",
            "content-length": body.length,
          },
        },
        (incoming) => {
          incoming.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16384) {
              incoming.destroy();
            } else {
              chunks.push(chunk);
            }
          });
          incoming.once("error", reject);
          incoming.once("end", () => {
            try {
              if (
                !incoming.complete ||
                incoming.statusCode !== 200 ||
                incoming.headers["content-type"] !== "application/json"
              ) {
                throw new Error("RECEIPT_UNAVAILABLE");
              }
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                throw new Error("RECEIPT_UNAVAILABLE");
              }
              done(value as Record<string, unknown>);
            } catch {
              reject(new Error("RECEIPT_UNAVAILABLE"));
            }
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  }
}
