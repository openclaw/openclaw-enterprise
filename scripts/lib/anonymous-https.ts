import type { IncomingMessage } from "node:http";
import { get } from "node:https";
import { buffer } from "node:stream/consumers";

export type HttpFailure =
  | "invalid-input"
  | "redirect-refused"
  | "authentication-required"
  | "unexpected-content"
  | "response-too-large"
  | "incomplete-response"
  | "deadline-exceeded"
  | "unavailable";

interface ReadOptions {
  signal: AbortSignal;
  timeout: number;
  mediaType: "text/html" | "text/css";
  maxBytes: number;
}

function responseLength(response: IncomingMessage, options: ReadOptions): number | HttpFailure {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    return "redirect-refused";
  }
  if (status === 401 || status === 403) {
    return "authentication-required";
  }
  if (status !== 200) {
    return "unavailable";
  }
  const headers = response.headersDistinct;
  const types = headers["content-type"] ?? [];
  const encodings = headers["content-encoding"] ?? ["identity"];
  const lengths = headers["content-length"] ?? [];
  const media = /^([^;\s]+)(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*$/i.exec(
    types[0] ?? "",
  );
  if (
    headers["transfer-encoding"] !== undefined ||
    types.length !== 1 ||
    media?.[1]?.toLowerCase() !== options.mediaType ||
    encodings.length !== 1 ||
    encodings[0]!.toLowerCase() !== "identity" ||
    lengths.length !== 1 ||
    !/^[0-9]{1,10}$/.test(lengths[0]!)
  ) {
    return "unexpected-content";
  }
  const length = Number(lengths[0]);
  return length > options.maxBytes ? "response-too-large" : length;
}

export async function readAnonymousHttps(
  url: URL,
  options: ReadOptions,
): Promise<{ bytes: Buffer } | { result: HttpFailure }> {
  if (url.protocol !== "https:" || url.username || url.password) {
    return { result: "invalid-input" };
  }
  let response: IncomingMessage | undefined;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(
        url,
        {
          agent: false,
          headers: { "accept-encoding": "identity" },
          maxHeaderSize: 16 * 1024,
          rejectUnauthorized: true,
          signal: options.signal,
          timeout: options.timeout,
        },
        resolve,
      );
      request.once("timeout", () => request.destroy());
      request.once("error", reject);
    });
    const length = responseLength(response, options);
    if (typeof length === "string") {
      return { result: length };
    }
    // Node's strict HTTP parser limits the stream to the validated Content-Length.
    const bytes = await buffer(response);
    return response.complete && bytes.length === length
      ? { bytes }
      : { result: "incomplete-response" };
  } catch (error) {
    if (options.signal.aborted) {
      return { result: "deadline-exceeded" };
    }
    if (response) {
      return { result: "incomplete-response" };
    }
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return {
      result:
        typeof code === "string" && code.startsWith("HPE_") ? "unexpected-content" : "unavailable",
    };
  } finally {
    response?.destroy();
  }
}
