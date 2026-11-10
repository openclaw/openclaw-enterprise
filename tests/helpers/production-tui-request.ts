import { RequestId } from "../../packages/contracts/src/index.ts";
import { Check } from "typebox/value";
import https from "node:https";

type RequestConfiguration = {
  baseURL: string;
  ca: string | Buffer;
  serviceKey: () => string | undefined;
  secrets: readonly string[];
};

type ApiResponse = {
  status: number | undefined;
  requestId?: string;
  body: unknown;
};

export class ProductionTuiRequestError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined) {
    super(message);
    this.status = status;
  }
}

export function createProductionTuiRequest(configuration: RequestConfiguration) {
  return (
    method: string,
    path: string,
    body?: unknown,
    { authenticated = true, signal }: { authenticated?: boolean; signal?: AbortSignal } = {},
  ): Promise<ApiResponse> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      let status: number | undefined;
      const req = https.request(
        `${configuration.baseURL}${path}`,
        {
          method,
          ca: configuration.ca,
          family: 4,
          signal,
          headers: {
            ...(authenticated ? { "x-api-key": configuration.serviceKey() } : {}),
            ...(data
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(data),
                }
              : {}),
          },
        },
        async (response) => {
          status = response.statusCode;
          let output = "";
          try {
            for await (const chunk of response) {
              output += chunk;
            }
          } catch {
            // Parser and transport errors may include response bytes or credentials.
            reject(new ProductionTuiRequestError("API response was interrupted", status));
            return;
          }
          if (configuration.secrets.some((value) => output.includes(value))) {
            reject(
              new ProductionTuiRequestError("API response leaked a protected credential", status),
            );
            return;
          }
          let parsed: unknown;
          try {
            parsed = output ? JSON.parse(output) : null;
          } catch {
            reject(new ProductionTuiRequestError("API response was not valid JSON", status));
            return;
          }
          const header = response.headers["x-request-id"];
          const envelope = parsed as { meta?: { requestId?: unknown } } | null;
          const result: ApiResponse = { status, body: parsed };
          if (
            header === envelope?.meta?.requestId &&
            Check(RequestId, header) &&
            !configuration.secrets.some((value) => header.includes(value))
          ) {
            result.requestId = header;
          }
          resolve(result);
        },
      );
      req.on("error", () => reject(new ProductionTuiRequestError("API request failed", status)));
      req.setTimeout(30_000, () => {
        reject(new ProductionTuiRequestError("API request timeout", status));
        req.destroy();
      });
      req.end(data);
    });
}
