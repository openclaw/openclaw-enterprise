import assert from "node:assert/strict";
import { createConnection } from "node:net";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";

export interface NativeHttpTarget {
  port: number;
  nativeHeaders: { host: string; origin: string; cookie: string };
}

export interface NativeHttpResponse {
  statusCode: number | null | undefined;
  headers: IncomingHttpHeaders;
  body: string;
  complete: boolean;
  ended: boolean;
  aborted: boolean;
  error: string | null;
}

interface LiveNativeRequestOptions {
  method?: string;
  headers?: OutgoingHttpHeaders;
  chunks?: readonly (string | Buffer)[];
  onFirstData?: (response: IncomingMessage, request: ClientRequest) => void;
}

export function liveNativeRequest(
  context: NativeHttpTarget,
  path: string,
  options: LiveNativeRequestOptions = {},
): Promise<NativeHttpResponse> {
  return new Promise((resolve, reject) => {
    const result: NativeHttpResponse = {
      statusCode: null,
      headers: {},
      body: "",
      complete: false,
      ended: false,
      aborted: false,
      error: null,
    };
    let receivedResponse = false;
    let settled = false;
    let actedOnData = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      result.body = Buffer.concat(chunks).toString("utf8");
      resolve(result);
    };
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: context.port,
        path,
        method: options.method ?? "GET",
        agent: false,
        headers: { ...context.nativeHeaders, ...options.headers },
      },
      (response) => {
        receivedResponse = true;
        result.statusCode = response.statusCode;
        result.headers = { ...response.headers };
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) {
            result.error = "response-bound-exceeded";
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
          if (!actedOnData) {
            actedOnData = true;
            options.onFirstData?.(response, request);
          }
        });
        response.once("aborted", () => {
          result.aborted = true;
        });
        response.once("error", (error: NodeJS.ErrnoException) => {
          result.error = error.code ?? error.name;
        });
        response.once("end", () => {
          result.ended = true;
        });
        response.once("close", () => {
          result.complete = response.complete;
          finish();
        });
      },
    );
    const deadline = setTimeout(() => {
      settled = true;
      request.destroy();
      reject(new Error("native HTTP request deadline exceeded"));
    }, 6_000);
    request.once("error", (error: NodeJS.ErrnoException) => {
      result.error ??= error.code ?? error.name;
      if (!receivedResponse) {
        finish();
      }
    });
    for (const chunk of options.chunks ?? []) {
      request.write(chunk);
    }
    request.end();
  });
}

export function rawNativeRequest(
  context: NativeHttpTarget,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = "",
): Promise<string> {
  return new Promise((resolve, reject: (error: Error) => void) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let socketError: Error | undefined;
    const socket = createConnection({ host: "127.0.0.1", port: context.port });
    const deadline = setTimeout(() => socket.destroy(new Error("raw request deadline")), 6_000);
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) {
        socket.destroy(new Error("raw response bound exceeded"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socketError = error;
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      if (socketError) {
        reject(socketError);
      } else {
        resolve(Buffer.concat(chunks).toString("latin1"));
      }
    });
    socket.once("connect", () => {
      const fields = { ...context.nativeHeaders, connection: "close", ...headers };
      socket.write(
        [
          method + " " + path + " HTTP/1.1",
          ...Object.entries(fields).map(([name, value]) => name + ": " + value),
          "",
          body,
        ].join("\r\n"),
      );
    });
  });
}

export async function waitForNativeIntegrity(
  predicate: () => boolean,
  message: string,
  milliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
