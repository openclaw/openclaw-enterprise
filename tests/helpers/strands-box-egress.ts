import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  readonly ref: string;
  readonly placement: "header" | "basic_auth";
  readonly header?: string;
  readonly prefix?: string;
  readonly inject: "phantom" | "always";
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
    assert.match(ref, /^env:\/\/[A-Z_]+$/);
    routes.push({
      name: String(current.name),
      destinations: current.destinations as string[],
      ref: ref.slice("env://".length),
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
    const table = /^\[egress\.([a-z-]+)\]$/.exec(line);
    if (table !== null) {
      flush();
      current = { name: table[1] };
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
}

/**
 * A test stand-in for stock Box v0.2.2 egress on GitHub's hosts: an HTTPS proxy that intercepts
 * TLS with its own CA, enforces the permitted host and method, swaps each route's placeholder for
 * the env:// secret read once from `boxEnvironment` (or attaches it to every request for
 * `inject = "always"`), forces identity encoding, scrubs the secret from responses and forwards
 * over `upstream`. The workload receives only placeholders, `HTTPS_PROXY` and Box's CA files.
 * It reproduces only the behaviour these tests rely on; the installed run checks real Box.
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
  // Box reads each env:// value once at start and gives the workload a placeholder for it.
  const secrets = new Map<string, string>();
  const placeholders = new Map<string, string>();
  for (const route of routes) {
    const secret = input.boxEnvironment[route.ref];
    assert.ok(secret, `box run has ${route.ref}`);
    secrets.set(route.name, secret);
    placeholders.set(route.name, `strands_box_${randomBytes(32).toString("hex")}`);
  }
  const requests: EmulatedRequest[] = [];
  const hosts = new WeakMap<Socket, string>();

  const refuse = (res: ServerResponse, record: Omit<EmulatedRequest, "outcome">) => {
    requests.push({ ...record, outcome: "refused" });
    res.writeHead(403, { "x-strands-box-egress": "refused", "content-length": "0" }).end();
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
      if (route !== undefined) {
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
      ...Object.fromEntries(routes.map((route) => [route.ref, placeholders.get(route.name)!])),
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      SSL_CERT_FILE: authority.caPath,
      GIT_SSL_CAINFO: authority.caPath,
    } as Record<string, string>,
    secrets: [...secrets.values()],
  };
}
