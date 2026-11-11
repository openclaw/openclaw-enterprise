import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export class EnterpriseRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Enterprise request refused (${status}, ${code}).`);
    this.status = status;
    this.code = code;
    this.name = "EnterpriseRequestError";
  }
}

/** No redirects, credential-bearing URLs, insecure TLS option, or upstream error bodies. */
export class EnterpriseClient {
  private readonly endpoint: URL;

  private readonly serviceKey: string;
  private readonly ca: string | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly address: string | undefined;
  constructor(
    endpoint: string,
    serviceKey: string,
    ca?: string,
    signal?: AbortSignal,
    address?: string,
  ) {
    this.serviceKey = serviceKey;
    this.ca = ca;
    this.signal = signal;
    this.address = address;
    if (address !== undefined && isIP(address) === 0) {
      throw new Error("Connection address must be an IPv4 or IPv6 address.");
    }

    this.endpoint = new URL(endpoint);
    if (
      this.endpoint.protocol !== "https:" ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      this.endpoint.pathname !== "/"
    ) {
      throw new Error("Connection endpoint must be an HTTPS origin without credentials.");
    }
  }

  async call<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Enterprise request path must be relative to its Connection.");
    }
    const target = new URL(path, this.endpoint);
    if (target.origin !== this.endpoint.origin) {
      throw new Error("Enterprise request cannot leave its Connection origin.");
    }
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const pending = request(
        target,
        {
          method,
          ...(this.address === undefined
            ? {}
            : {
                hostname: this.address,
                servername: this.endpoint.hostname,
                checkServerIdentity: (_hostname, certificate) =>
                  checkServerIdentity(this.endpoint.hostname, certificate),
              }),
          ...(this.signal === undefined ? {} : { signal: this.signal }),
          ...(this.ca === undefined ? {} : { ca: this.ca }),
          headers: {
            host: this.endpoint.host,
            "x-api-key": this.serviceKey,
            ...(bytes === undefined
              ? {}
              : { "content-type": "application/json", "content-length": bytes.length }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 2 * 1024 * 1024) {
              pending.destroy();
              reject(new EnterpriseRequestError(502, "RESPONSE_TOO_LARGE"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", () =>
            reject(new EnterpriseRequestError(503, "TRANSPORT_UNAVAILABLE")),
          );
          response.on("end", () => {
            let decoded: { data?: T; error?: { code?: unknown } };
            try {
              decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(new EnterpriseRequestError(502, "INVALID_RESPONSE"));
              return;
            }
            const status = response.statusCode ?? 502;
            if (status < 200 || status >= 300) {
              const code =
                typeof decoded.error?.code === "string" &&
                /^[A-Z0-9_]{1,64}$/.test(decoded.error.code)
                  ? decoded.error.code
                  : "REQUEST_REFUSED";
              reject(new EnterpriseRequestError(status, code));
              return;
            }
            if (decoded.data === undefined) {
              reject(new EnterpriseRequestError(502, "INVALID_RESPONSE"));
              return;
            }
            resolve(decoded.data);
          });
        },
      );
      const deadline = setTimeout(() => pending.destroy(), 10_000);
      pending.on("close", () => clearTimeout(deadline));
      pending.on("error", () => reject(new EnterpriseRequestError(503, "TRANSPORT_UNAVAILABLE")));
      pending.end(bytes);
    });
  }
}
