import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type {
  PreparedGitHubUseRequest,
  PreparedGitHubUseResponse,
} from "@openclaw-enterprise/contracts";
import type {
  Bounds,
  Clock,
  HeaderFields,
  OperationReceipt,
  PrivateUpstreamRequest,
} from "../../credentials/backend-contracts.ts";
import { isGitHubWireCredential } from "./wire-credential.ts";

type GitUse = Omit<PreparedGitHubUseRequest, "exchangeId" | "deadlineAt">;

function useOnce<T>(socketPath: string, use: object, signal: AbortSignal): Promise<T> {
  // An ambiguous owner response consumes this exchange. Never retry this request or
  // reuse its material, including when the owner committed but we did not receive it.
  const body = Buffer.from(JSON.stringify(use));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        hostname: "localhost",
        path: "/v1/prepared-git/use",
        method: "POST",
        agent: false,
        signal,
        maxHeaderSize: 4096,
        headers: { "content-type": "application/json", "content-length": body.length },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          res.headers["content-type"]?.split(";")[0] !== "application/json"
        ) {
          res.destroy();
          reject(new Error("prepared-git-unavailable"));
          return;
        }
        const chunks: Buffer[] = [];
        const wipe = () => {
          for (const chunk of chunks) {
            chunk.fill(0);
          }
          chunks.length = 0;
        };
        let length = 0;
        res.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 24576) {
            chunk.fill(0);
            res.destroy(new Error("invalid-prepared-git-use"));
          } else {
            chunks.push(chunk);
          }
        });
        res.once("error", () => reject(new Error("prepared-git-unavailable")));
        res.once("close", () => {
          wipe();
          if (!res.readableEnded) {
            reject(new Error("prepared-git-unavailable"));
          }
        });
        res.once("end", () => {
          const bytes = Buffer.concat(chunks);
          try {
            resolve(JSON.parse(bytes.toString("utf8")) as T);
          } catch {
            reject(new Error("invalid-prepared-git-use"));
          } finally {
            bytes.fill(0);
            wipe();
          }
        });
      },
    );
    req.once("error", () => reject(new Error("prepared-git-unavailable")));
    req.end(body);
  });
}

/** The only broker-to-owner operation. No grant creation, signing or preparation capability. */
export async function authorizePreparedGitSend(
  socketPath: string,
  clock: Clock,
  use: GitUse,
  requestHeaders: HeaderFields,
  { signal, deadlineMonoMs }: Bounds,
) {
  const started = clock.monotonicNow();
  const remaining = Math.floor(Math.min(30000, deadlineMonoMs - started));
  if (signal.aborted || remaining <= 0) {
    throw new Error("exchange-expired");
  }
  const deadline = Math.floor(clock.wallNow()) + remaining;
  const exchangeId = randomUUID();
  const result = await useOnce<PreparedGitHubUseResponse | OperationReceipt>(
    socketPath,
    {
      ...use,
      exchangeId,
      deadlineAt: new Date(deadline).toISOString(),
    },
    AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
  );

  if ("kind" in result) {
    if (
      use.pull &&
      result.kind === "recorded" &&
      (result.status === 201 || result.status === 409)
    ) {
      return result;
    }
    throw new Error("invalid-prepared-operation");
  }
  const wall = clock.wallNow();
  const now = clock.monotonicNow();
  const sendBy = Date.parse(result.sendStartBy);
  const sendByMono = Math.min(deadlineMonoMs, started + remaining, now + (sendBy - wall));
  if (
    result.exchangeId !== exchangeId ||
    typeof result.preparationAttemptId !== "string" ||
    !result.preparationAttemptId ||
    typeof result.materialVersion !== "string" ||
    !result.materialVersion ||
    !Number.isFinite(sendBy) ||
    sendBy > deadline ||
    sendBy - wall > 5000 ||
    !isGitHubWireCredential(result.value)
  ) {
    throw new Error("invalid-prepared-git-use");
  }
  const basic = use.pull ? undefined : Buffer.from("x-access-token:" + result.value);
  const authorization = basic ? "Basic " + basic.toString("base64") : "Bearer " + result.value;
  basic?.fill(0);
  // The receipt exists as possibly sent before the permit ever leaves the worker.
  // Finalization neither acquires a second permit nor inherits a cancelled Agent signal.
  const settle: PrivateUpstreamRequest["settle"] = use.pull
    ? (outcome) =>
        useOnce<OperationReceipt>(
          socketPath,
          { operation: "record-draft-pull", receiptId: exchangeId, outcome },
          AbortSignal.timeout(5000),
        )
    : undefined;
  let startedSend = false;
  return {
    headers: Object.freeze({
      ...requestHeaders,
      authorization,
    }),
    ...(settle ? { settle } : {}),
    // Called once after verified TLS and immediately before the first HTTP write.
    // Withdrawal stops later admissions, but cannot undo a send already authorized.
    assertSendStart() {
      if (
        startedSend ||
        signal.aborted ||
        clock.monotonicNow() >= sendByMono ||
        clock.wallNow() >= sendBy
      ) {
        throw new Error("prepared-git-send-expired");
      }
      startedSend = true;
    },
  };
}
