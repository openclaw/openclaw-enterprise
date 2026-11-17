import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  request as unixRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type Agent, request } from "node:https";
import type { Socket } from "node:net";
import type { TestContext } from "node:test";
import { TLSSocket } from "node:tls";
import { certificateAuthority, signedLeaf } from "./certificates.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

/** One `[egress.<name>]` credential route as the Strands Box host writes it into box.toml. */
export interface BoxCredentialRoute {
  readonly name: string;
  readonly destinations: readonly string[];
  /** `env://NAME`: the variable `box run` reads once; `source://NAME`: a request-time source. */
  readonly ref: { readonly env: string } | { readonly source: string };
  /** The workload's placeholder variable: the env:// name, or `secret.env` for a source. */
  readonly variable: string;
  readonly placement: "header" | "basic_auth";
  readonly header?: string;
  readonly prefix?: string;
  readonly inject: "phantom" | "always";
}

/** One `[gateway.credential_source.<name>]` table, as the Box fork reads it. */
export interface BoxCredentialSource {
  readonly name: string;
  readonly socket: string;
  readonly bearerEnv: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

/** Parse the credential source tables of a generated box.toml fragment. */
export function parseBoxSources(toml: string): BoxCredentialSource[] {
  const sources: BoxCredentialSource[] = [];
  let current: Record<string, unknown> | undefined;
  const flush = () => {
    if (current === undefined) {
      return;
    }
    const endpoint = String(current.endpoint);
    const bearer = String(current.bearer);
    assert.match(endpoint, /^unix:\/\/\//);
    assert.match(bearer, /^env:\/\/[A-Z_]+$/);
    sources.push({
      name: String(current.name),
      socket: endpoint.slice("unix://".length),
      bearerEnv: bearer.slice("env://".length),
      timeoutMs: Number(current.timeout_ms ?? 5000),
      maxBodyBytes: Number(current.max_body_bytes ?? 1048576),
    });
    current = undefined;
  };
  for (const line of toml.split("\n")) {
    const table = /^\[([a-z_.-]+)\]$/.exec(line);
    if (table !== null) {
      flush();
      const name = /^gateway\.credential_source\.([a-z0-9_.-]+)$/.exec(table[1]!)?.[1];
      current = name === undefined ? undefined : { name };
      continue;
    }
    const pair = /^([a-z_.]+) = (.*)$/.exec(line);
    if (pair !== null && current !== undefined) {
      current[pair[1]!] = JSON.parse(pair[2]!);
    }
  }
  flush();
  return sources;
}

/** Parse the credential tables of a generated box.toml fragment (strings and string arrays). */
export function parseBoxRoutes(toml: string): BoxCredentialRoute[] {
  const routes: BoxCredentialRoute[] = [];
  let current: Record<string, unknown> | undefined;
  const flush = () => {
    if (current === undefined) {
      return;
    }
    const ref = String(current["secret.ref"]);
    assert.match(ref, /^(?:env:\/\/[A-Z_]+|source:\/\/[a-z0-9_.-]+)$/);
    const source = ref.startsWith("source://");
    if (source) {
      assert.match(String(current["secret.env"]), /^[A-Z_]+$/);
    }
    routes.push({
      name: String(current.name),
      destinations: current.destinations as string[],
      ref: source ? { source: ref.slice("source://".length) } : { env: ref.slice("env://".length) },
      variable: source ? String(current["secret.env"]) : ref.slice("env://".length),
      placement: current["secret.placement"] as BoxCredentialRoute["placement"],
      ...(current["secret.header"] === undefined
        ? {}
        : { header: String(current["secret.header"]) }),
      ...(current["secret.prefix"] === undefined
        ? {}
        : { prefix: String(current["secret.prefix"]) }),
      inject: current["secret.inject"] as BoxCredentialRoute["inject"],
    });
  };
  for (const line of toml.split("\n")) {
    const table = /^\[([a-z_.-]+)\]$/.exec(line);
    if (table !== null) {
      flush();
      const name = /^egress\.([a-z-]+)$/.exec(table[1]!)?.[1];
      current = name === undefined ? undefined : { name };
      continue;
    }
    const pair = /^([a-z.]+) = (.*)$/.exec(line);
    if (pair !== null && current !== undefined) {
      current[pair[1]!] = JSON.parse(pair[2]!);
    }
  }
  flush();
  return routes;
}

/** Hosts and methods the generated Cedar policy permits for intercepted HTTPS on port 443. */
export function permittedRequests(policy: string): Map<string, Set<string>> {
  const permitted = new Map<string, Set<string>>();
  for (const rule of policy.matchAll(
    /context\.input\.host == "([^"]+)" && context\.input\.port == 443 && \(([^)]*)\) && context\.input\.intercepted == true/g,
  )) {
    const methods = [...rule[2]!.matchAll(/context\.input\.method == "([A-Z]+)"/g)].map(
      ([, method]) => method!,
    );
    permitted.set(rule[1]!, new Set(methods));
  }
  return permitted;
}

export interface EmulatedRequest {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly outcome: "injected" | "refused";
  /** For a source route: the source's refusal code, or "unavailable" for any other failure. */
  readonly sourceRefusal?: string;
  /** For a source route: the request ID Box sent the source. */
  readonly requestId?: string;
}

/** One Box ask to a request-time source, as the Box fork sends it, with its outcome. */
interface SourceReply {
  readonly credential?: string;
  readonly refusal?: string;
}

async function askSource(
  source: BoxCredentialSource,
  bearer: string,
  document: Record<string, unknown>,
): Promise<SourceReply | undefined> {
  const payload = Buffer.from(JSON.stringify(document));
  try {
    const reply = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const pending = unixRequest(
        {
          socketPath: source.socket,
          method: "POST",
          path: "/",
          agent: false,
          signal: AbortSignal.timeout(source.timeoutMs),
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            "content-length": payload.length,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          response.once("error", reject);
        },
      );
      pending.once("error", reject);
      pending.end(payload);
    });
    if (reply.status !== 200 || reply.body.length > 64 * 1024) {
      return undefined;
    }
    const value = JSON.parse(reply.body.toString()) as Record<string, unknown>;
    if (value.version !== 1 || value.request_id !== document.request_id) {
      return undefined;
    }
    const hasCredential = typeof value.credential === "string";
    const hasRefusal = typeof value.refusal === "string";
    if (hasCredential === hasRefusal) {
      return undefined;
    }
    if (hasRefusal) {
      return {
        refusal: /^[A-Za-z0-9._-]{1,64}$/.test(value.refusal as string)
          ? (value.refusal as string)
          : "invalid",
      };
    }
    const credential = value.credential as string;
    if (
      typeof value.send_by_unix_ms !== "number" ||
      !(value.send_by_unix_ms > Date.now()) ||
      credential.length === 0 ||
      /[^\x21-\x7e]/.test(credential)
    ) {
      return undefined;
    }
    return { credential };
  } catch {
    return undefined;
  }
}

/** Headers Box never sends a source: framing, hop-by-hop, the proxy's own. */
const NOT_SENT = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
]);

/**
 * A test stand-in for Box egress on GitHub's hosts: an HTTPS proxy that intercepts TLS with its
 * own CA, enforces the permitted host and method, and for each credential route either swaps the
 * placeholder for the env:// secret read once from `boxEnvironment` (stock Box v0.2.2), or, for a
 * `source://` route (the Box fork's request-time source), asks the source over its Unix socket
 * with the bearer from `boxEnvironment` for every request and attaches the released value at the
 * route's placement, refusing with 403 `x-strands-box-egress: refused` on any refusal or failure
 * before anything reaches the upstream. It forces identity encoding, scrubs the value from
 * responses and forwards over `upstream`. The workload receives only placeholders, `HTTPS_PROXY`
 * and Box's CA files. It reproduces only the behaviour these tests rely on (the fork's
 * docs/user/egress.md#request-time-sources); the native lane checks real Box.
 */
export async function boxGitHubEgress(
  t: TestContext,
  input: {
    readonly config: string;
    readonly policy: string;
    readonly boxEnvironment: Readonly<Record<string, string>>;
    readonly upstream: Agent;
  },
) {
  const directory = await temporaryDirectory(t, "box-egress-");
  const authority = await certificateAuthority(directory, {
    caName: "Box interception CA",
    caKeyPem: undefined,
  });
  const routes = parseBoxRoutes(input.config);
  const sources = new Map(parseBoxSources(input.config).map((source) => [source.name, source]));
  const permitted = permittedRequests(input.policy);
  const leaves = new Map<string, { key: string; cert: string }>();
  for (const host of permitted.keys()) {
    leaves.set(
      host,
      await signedLeaf(directory, authority, {
        name: host.replaceAll(".", "-"),
        commonName: host,
        subjectAltName: `DNS:${host}`,
        keyPem: undefined,
      }),
    );
  }
  // Box reads each env:// value (and each source bearer) once at start and gives the workload a
  // placeholder for every route.
  const secrets = new Map<string, string>();
  const bearers = new Map<string, string>();
  const placeholders = new Map<string, string>();
  for (const route of routes) {
    if ("env" in route.ref) {
      const secret = input.boxEnvironment[route.ref.env];
      assert.ok(secret, `box run has ${route.ref.env}`);
      secrets.set(route.name, secret);
    } else {
      const source = sources.get(route.ref.source);
      assert.ok(source, `box.toml declares source ${route.ref.source}`);
      const bearer = input.boxEnvironment[source.bearerEnv];
      assert.ok(bearer, `box run has ${source.bearerEnv}`);
      bearers.set(source.name, bearer);
    }
    placeholders.set(route.name, `strands_box_${randomBytes(32).toString("hex")}`);
  }
  // Values released by a source for the request in flight; scrubbed from that response.
  const released = new Map<string, string>();
  const requests: EmulatedRequest[] = [];
  const hosts = new WeakMap<Socket, string>();

  const refuse = (res: ServerResponse, record: Omit<EmulatedRequest, "outcome">, body = "") => {
    requests.push({ ...record, outcome: "refused" });
    res
      .writeHead(403, {
        "x-strands-box-egress": "refused",
        "content-length": String(Buffer.byteLength(body)),
      })
      .end(body);
  };

  const intercept = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const host = hosts.get(req.socket)!;
      const record = { host, method: req.method ?? "", path: req.url ?? "" };
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      if (req.headers.host !== host || !permitted.get(host)?.has(record.method)) {
        refuse(res, record);
        return;
      }
      const route = routes.find(({ destinations }) => destinations.includes(host));
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && name !== "proxy-connection") {
          headers[name] = value;
        }
      }
      headers["accept-encoding"] = "identity";
      let scrub: string | undefined;
      if (route !== undefined && "source" in route.ref) {
        const source = sources.get(route.ref.source)!;
        const placeholder = placeholders.get(route.name)!;
        const name = (route.header ?? "authorization").toLowerCase();
        // 1. The placeholder check (`phantom` needs it; `always` does not). Its header is removed.
        if (route.inject === "phantom") {
          if (headers[name] !== `${route.prefix ?? ""}${placeholder}`) {
            refuse(res, record);
            return;
          }
          delete headers[name];
        } else if (route.placement === "basic_auth") {
          delete headers.authorization;
        }
        // 2. Policy decided http:request above. 3. Ask the source, with a body under its cap.
        if (body.length > source.maxBodyBytes) {
          refuse(res, record, "credential source unavailable");
          return;
        }
        const requestId = randomBytes(16).toString("hex");
        const [path, query = ""] = record.path.split(/\?(.*)/s, 2);
        const document = {
          version: 1,
          request_id: requestId,
          target: { scheme: "https", host, port: 443, method: record.method, path, query },
          headers: req.rawHeaders
            .flatMap((value, index, all) =>
              index % 2 === 0 ? [[value.toLowerCase(), all[index + 1]!] as [string, string]] : [],
            )
            .filter(
              ([header]) =>
                !NOT_SENT.has(header) &&
                !(route.inject === "phantom" && header === name) &&
                !(route.placement === "basic_auth" && header === "authorization"),
            )
            .map(([header, value]) =>
              header === "accept-encoding"
                ? ([header, "identity"] as [string, string])
                : [header, value],
            ),
          body: body.toString("base64"),
        };
        const answer = await askSource(source, bearers.get(source.name)!, document);
        if (answer?.credential === undefined) {
          const sourceRefusal = answer?.refusal ?? "unavailable";
          refuse(
            res,
            { ...record, sourceRefusal, requestId },
            answer?.refusal === undefined
              ? "credential source unavailable"
              : `credential refused by its source: ${answer.refusal}`,
          );
          return;
        }
        // 5. The operator's placement; the response scrub covers the value.
        if (route.placement === "basic_auth") {
          headers.authorization = `Basic ${Buffer.from(answer.credential).toString("base64")}`;
        } else {
          headers[name] = `${route.prefix ?? ""}${answer.credential}`;
        }
        scrub = answer.credential;
        released.set(requestId, answer.credential);
        (record as { requestId?: string }).requestId = requestId;
      } else if (route !== undefined) {
        const secret = secrets.get(route.name)!;
        const placeholder = placeholders.get(route.name)!;
        const name = (route.header ?? "authorization").toLowerCase();
        if (route.placement === "basic_auth") {
          // inject = "always": attach to every request, replacing whatever the client sent.
          assert.equal(route.inject, "always");
          headers.authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
        } else if (headers[name] === `${route.prefix ?? ""}${placeholder}`) {
          headers[name] = `${route.prefix ?? ""}${secret}`;
        } else {
          // A phantom route refuses a request to its destination that lacks the placeholder.
          refuse(res, record);
          return;
        }
      }
      const upstream = request({
        host,
        port: 443,
        method: record.method,
        path: record.path,
        headers,
        agent: input.upstream,
      });
      upstream.once("error", () => res.destroy());
      upstream.end(body);
      const [reply] = (await once(upstream, "response")) as [IncomingMessage];
      const replyChunks: Buffer[] = [];
      for await (const chunk of reply) {
        replyChunks.push(chunk as Buffer);
      }
      let replyBody = Buffer.concat(replyChunks);
      for (const [routeName, secret] of secrets) {
        replyBody = Buffer.from(
          replyBody.toString("latin1").replaceAll(secret, placeholders.get(routeName)!),
          "latin1",
        );
      }
      if (scrub !== undefined) {
        replyBody = Buffer.from(
          replyBody.toString("latin1").replaceAll(scrub, "[REDACTED]"),
          "latin1",
        );
      }
      const replyHeaders = { ...reply.headers };
      delete replyHeaders["transfer-encoding"];
      replyHeaders["content-length"] = String(replyBody.length);
      requests.push({ ...record, outcome: "injected" });
      res.writeHead(reply.statusCode ?? 502, replyHeaders).end(replyBody);
    })().catch(() => res.destroy());
  });

  const proxy = createServer((_req, res) => {
    res.writeHead(403, { "content-length": "0" }).end();
  });
  proxy.on("connect", (req: IncomingMessage, socket: Socket) => {
    const [host, port] = (req.url ?? "").split(":");
    const leaf = host === undefined ? undefined : leaves.get(host);
    if (leaf === undefined || port !== "443") {
      requests.push({ host: host ?? "", method: "CONNECT", path: "", outcome: "refused" });
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new TLSSocket(socket, { isServer: true, key: leaf.key, cert: leaf.cert });
    hosts.set(tls, host!);
    intercept.emit("connection", tls);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections();
        intercept.closeAllConnections();
        proxy.close(() => resolve());
      }),
  );
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  return {
    requests,
    /** The environment Box gives the workload: placeholders, its proxy and its CA files. */
    workloadEnvironment: {
      ...Object.fromEntries(routes.map((route) => [route.variable, placeholders.get(route.name)!])),
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      SSL_CERT_FILE: authority.caPath,
      GIT_SSL_CAINFO: authority.caPath,
    } as Record<string, string>,
    secrets: [...secrets.values()],
    /** Every value a source released, by Box's request ID (only the upstream may see them). */
    released,
  };
}
