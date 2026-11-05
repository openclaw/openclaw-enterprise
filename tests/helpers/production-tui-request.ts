import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";

type RequestConfiguration = {
  baseURL: string;
  ca: string | Buffer;
  serviceKey: () => string | undefined;
  secrets: readonly string[];
};

type ApiResponse = {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
};

export function createProductionTuiRequest(configuration: RequestConfiguration) {
  return (
    method: string,
    path: string,
    body?: unknown,
    { authenticated = true } = {},
  ): Promise<ApiResponse> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        `${configuration.baseURL}${path}`,
        {
          method,
          ca: configuration.ca,
          family: 4,
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
          let output = "";
          try {
            for await (const chunk of response) {
              output += chunk;
            }
          } catch {
            // Parser and transport errors may include response bytes or credentials.
            reject(new Error("API response was interrupted"));
            return;
          }
          if (configuration.secrets.some((value) => output.includes(value))) {
            reject(new Error("API response leaked a protected credential"));
            return;
          }
          let parsed: unknown;
          try {
            parsed = output ? JSON.parse(output) : null;
          } catch {
            reject(new Error("API response was not valid JSON"));
            return;
          }
          resolve({ status: response.statusCode, headers: response.headers, body: parsed });
        },
      );
      req.on("error", () => reject(new Error("API request failed")));
      req.setTimeout(30_000, () => {
        reject(new Error("API request timeout"));
        req.destroy();
      });
      req.end(data);
    });
}
