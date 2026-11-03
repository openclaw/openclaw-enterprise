import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Clock } from "../../../credentials/backend-contracts.ts";
import type { ProviderAttempt, ProviderResponse } from "../provider-transport.ts";
import type { ProviderScope } from "./request-options.ts";
import { providerRequestOptions } from "./request-options.ts";
import { createProviderResponseBody } from "./response-body.ts";
import {
  observeProvider,
  providerErrorClass,
  type ProviderObservation,
} from "../provider-diagnostics.ts";

interface ProviderRequestDependencies {
  readonly endpoint: ProviderScope;
  readonly ca: Uint8Array | undefined;
  readonly clock: Clock;
  readonly operation: "issue" | "revoke";
  readonly authorization: string;
  readonly attempt: ProviderAttempt;
  readonly onDispatch: () => void;
  readonly assertMaterialCurrent: () => void;
  readonly observeResponse: (response: ProviderResponse) => void;
  readonly observe?: (observation: ProviderObservation) => void;
}

export function sendProviderRequest({
  endpoint,
  ca,
  clock,
  operation,
  authorization,
  attempt,
  onDispatch,
  assertMaterialCurrent,
  observeResponse,
  observe,
}: ProviderRequestDependencies): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    const responseBody = createProviderResponseBody();
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let result: ProviderResponse | undefined;
    let failed = false;
    let settled = false;
    let cancelDeadline: () => void = () => {};
    let stage: ProviderObservation["stage"] = "fence";
    const report = (observation: ProviderObservation) => {
      stage = observation.stage;
      observeProvider(observe, observation);
    };

    // A dispatched request settles only after its actual close event.
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      cancelDeadline();
      attempt.signal.removeEventListener("abort", cancel);
      responseBody.discard();
      if (failed || !result) {
        if (!failed) {
          report({ stage, error: "response-error" });
        }
        result?.body.fill(0);
        reject(new Error("provider-unavailable"));
      } else {
        resolve(result);
      }
    };
    const fail = (error: ProviderObservation["error"] = "request-error") => {
      if (!failed) {
        report({ stage, error });
      }
      failed = true;
      response?.destroy();
      request?.destroy();
      if (!request) {
        settle();
      }
    };
    const cancel = () => fail("cancelled");
    const receiveResponse = (incoming: IncomingMessage) => {
      response = incoming;
      report({
        stage: "response-started",
        ...(incoming.statusCode !== undefined ? { httpStatus: incoming.statusCode } : {}),
        responseComplete: false,
      });
      incoming.on("error", () => fail("response-error"));
      incoming.on("aborted", () => fail("response-error"));
      if (
        incoming.headers["content-encoding"] &&
        incoming.headers["content-encoding"] !== "identity"
      ) {
        fail("response-encoding");
        return;
      }
      incoming.on("data", function receiveChunk(chunk: Buffer) {
        if (failed) {
          chunk.fill(0);
        } else if (!responseBody.append(chunk)) {
          fail("response-limit");
        }
      });
      incoming.on("end", function completeResponse() {
        if (!failed) {
          report({ stage: "complete", responseComplete: incoming.complete });
          result = { status: incoming.statusCode ?? 0, body: responseBody.assemble() };
          try {
            observeResponse(result);
          } catch {
            fail("observer-error");
          }
        }
        responseBody.discard();
      });
    };

    try {
      const prepared = providerRequestOptions(endpoint, operation, authorization, ca);
      attempt.assertAdmitted();
      assertMaterialCurrent();
      const remaining = attempt.deadlineMonoMs - clock.monotonicNow();
      if (attempt.signal.aborted || remaining <= 0) {
        throw new Error("not-admitted");
      }
      // No request byte can leave before TCP connects (the request itself is written
      // only after the TLS handshake), so DNS and connect failures stay definite.
      // Admission is checked again with the latch at that point.
      const observeDispatch = () => {
        if (failed) {
          return;
        }
        try {
          attempt.observeDispatch();
          onDispatch();
        } catch {
          fail("admission-fenced");
        }
      };
      request = httpsRequest(prepared.options);
      report({ stage: "request-created" });
      request.on("error", (error) => fail(providerErrorClass(error)));
      request.on("close", settle);
      request.on("response", receiveResponse);
      const send = () => {
        if (failed) {
          return;
        }
        try {
          // TLS may finish long after connect. Recheck the bounds and signing authority before writing.
          try {
            attempt.assertAdmitted();
          } catch (error) {
            fail("admission-fenced");
            throw error;
          }
          try {
            assertMaterialCurrent();
          } catch (error) {
            fail("signer-fenced");
            throw error;
          }
          // Calling end can send bytes; it is not evidence that GitHub received them.
          report({ stage: "request-end-called" });
          request!.end(prepared.body);
        } catch {
          fail();
        }
      };
      request.once("socket", (socket) => {
        socket.once("secureConnect", () => report({ stage: "tls-ready" }));
        if (socket.connecting) {
          socket.once("connect", observeDispatch);
          socket.once("secureConnect", send);
        } else {
          observeDispatch();
          send();
        }
      });
      cancelDeadline = clock.schedule(Math.min(30000, remaining), () => fail("deadline"));
      attempt.signal.addEventListener("abort", cancel, { once: true });
      if (attempt.signal.aborted) {
        cancel();
        return;
      }
    } catch {
      fail("request-setup");
    }
  });
}
