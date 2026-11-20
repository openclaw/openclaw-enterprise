/** Installed only in a test's private controller package root. A credential injector with no
 * GitHub rules of its own: every decision comes from the Worker-supplied requests port. */
import { readFileSync } from "node:fs";
import { createServer, request } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer } from "node:stream/consumers";
import { createDriver as releaseDriver } from "./index.ts";
import type {
  DriverRegistration,
  ErrorDetail,
  GitHubRequestView,
  ProtectedRepositoryGitAuthority,
  RepositoryGitInstallationFence,
  RepositoryGitRequests,
} from "@openclaw-enterprise/contracts";

type Config = {
  endpoint: string;
  ca: string;
  certFile: string;
  keyFile: string;
  upstreamOrigin: string;
  profile: "repository_git" | "github_repository" | "github_installation";
};
const keys = ["endpoint", "ca", "certFile", "keyFile", "upstreamOrigin", "profile"];
export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  required: keys,
  properties: {
    ...Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
    profile: { enum: ["repository_git", "github_repository", "github_installation"] },
  },
};

export function validateConfiguration(config: Readonly<Config>): readonly ErrorDetail[] {
  return /^https:\/\/127\.0\.0\.1:[0-9]+$/.test(config.upstreamOrigin)
    ? []
    : [{ path: "/upstreamOrigin", code: "INVALID_VALUE", message: "Use a loopback origin." }];
}

/** What the test observes. The test plays the host: it reports the observed recipient. */
export const injector: {
  url?: string;
  route?: RepositoryGitInstallationFence;
  marker: string;
  decisions: unknown[];
  bound: number;
  requestsSupplied?: boolean;
} = { marker: "workload-execution-marker", decisions: [], bound: 0 };

// The injector owns credential placement, the connection and framing.
const omitted = new Set([
  "authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "expect",
]);

function view(req: IncomingMessage, body: Buffer): GitHubRequestView | undefined {
  const url = req.url ?? "";
  const split = url.indexOf("?");
  const host = req.headers.host?.replace(/:443$/, "");
  const method = req.method as GitHubRequestView["target"]["method"];
  if (!host || !url.startsWith("/")) {
    return;
  }
  const headers: [string, string][] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase();
    if (!omitted.has(name)) {
      headers.push([name, req.rawHeaders[index + 1]!.trim()]);
    }
  }
  return {
    target: {
      host,
      port: 443,
      method,
      path: split < 0 ? url : url.slice(0, split),
      query: split < 0 ? "" : url.slice(split + 1),
    },
    headers,
    body,
  };
}

export function createDriver(options: {
  id: string;
  implementation: string;
  configuration: Config;
}): DriverRegistration {
  const config = options.configuration;
  const base = releaseDriver({
    ...options,
    configuration: { endpoint: config.endpoint, ca: config.ca },
  });
  const { sandbox, credential_proxy: proxy } = base.capabilities;
  if (!sandbox || !proxy) {
    throw new Error("The release fixture supplies both capabilities.");
  }
  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    requests: RepositoryGitRequests,
  ): Promise<void> {
    const route = injector.route;
    // The execution's own credential authenticates it to this injector, never to GitHub.
    if (!route || req.headers.authorization !== "Bearer " + injector.marker) {
      res.writeHead(401).end();
      return;
    }
    const body = await buffer(req);
    const held = view(req, body);
    if (!held) {
      res.writeHead(400).end();
      return;
    }
    const decision = await requests.authorize({
      route,
      profile: config.profile,
      request: held,
      signal: AbortSignal.timeout(5000),
    });
    if (decision.kind !== "allow") {
      injector.decisions.push(decision);
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(JSON.stringify({ reason_code: decision.reasonCode ?? "denied" }));
      return;
    }
    const { credential } = decision;
    injector.decisions.push({
      kind: "allow",
      operation: decision.operation,
      exchangeId: decision.exchangeId,
    });
    if (!(Date.now() < Date.parse(decision.sendBy))) {
      res.writeHead(403).end();
      return;
    }
    // Add exactly the one header to the request OCE classified, then send it once.
    const upstream = request(
      config.upstreamOrigin + req.url,
      {
        method: held.target.method,
        ca: config.ca,
        // The loopback stand-in for GitHub presents a localhost certificate.
        servername: "localhost",
        agent: false,
        headers: {
          ...Object.fromEntries(held.headers),
          host: held.target.host,
          "content-length": String(body.length),
          // This route places the credential as an authorization header.
          authorization:
            credential.scheme === "basic"
              ? "Basic " +
                Buffer.from(credential.username + ":" + credential.token).toString("base64")
              : "Bearer " + credential.token,
        },
      },
      (response) => {
        res.writeHead(response.statusCode!, {
          "content-type": response.headers["content-type"] ?? "application/octet-stream",
        });
        response.pipe(res);
      },
    );
    upstream.once("error", () => res.writeHead(502).end());
    upstream.end(body);
  }
  return {
    ...base,
    capabilities: {
      sandbox: {
        ...sandbox,
        repositoryAccess: {
          async verifyExecution({ revision }) {
            return { executionId: revision.id, fingerprint: "fixture" };
          },
          async retireExpired() {
            return "retire-runtime";
          },
          routeReadiness: () => (injector.route ? "ready" : "pending"),
          materialSettledAt: () => undefined,
          isRouteBlockedError: () => false,
        },
      },
      credential_proxy: {
        ...proxy,
        async bindRepositoryGit(
          _authority: ProtectedRepositoryGitAuthority,
          requests: RepositoryGitRequests,
        ) {
          injector.bound++;
          injector.requestsSupplied = typeof requests?.authorize === "function";
          const tls = { cert: readFileSync(config.certFile), key: readFileSync(config.keyFile) };
          const server = createServer(tls, (req, res) => {
            forward(req, res, requests).catch(() => {
              if (!res.headersSent) {
                res.writeHead(502);
              }
              res.end();
            });
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          injector.url = "https://127.0.0.1:" + (server.address() as AddressInfo).port;
          return {
            close: () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          };
        },
      },
    },
  };
}
