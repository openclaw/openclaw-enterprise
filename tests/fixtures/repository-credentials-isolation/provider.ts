import { randomBytes } from "node:crypto";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request } from "node:https";
import type { Socket } from "node:net";
import { startGitHubFixture } from "../repository-credentials/github.mjs";
import { startGitSmartHttpFixture } from "../repository-credentials/git.mjs";

export type ProviderReport = {
  ready: boolean;
  pushedRef: string | null;
  errors: string[];
  issues: unknown[];
  tokens: { static?: boolean; revoked: boolean }[];
  apiTrace: { method: string; target: string; tokenIndex?: number | undefined }[];
  gitTrace: { path: string; gitProtocol?: string | string[] | undefined }[];
};

type Cleanup = () => void | Promise<void>;
type FixtureContext = { after: (callback: Cleanup) => void };
type GitHubFixture = {
  origin: string;
  acceptStatic(token: string): number;
  authorize(authorization: string | undefined, boundary: "git"): boolean;
  issuesOfTokens: ProviderReport["issues"];
  tokenState(): ProviderReport["tokens"];
  trace: ProviderReport["apiTrace"];
  errors: ProviderReport["errors"];
};

// Only this trusted fixture container sees provider material. The production
// service still uses its fixed HTTPS origins and verifies their certificates.
const cleanup: Cleanup[] = [];
const context: FixtureContext = { after: (callback) => cleanup.push(callback) };
const tls = {
  key: await readFile("/inputs/tls.key"),
  cert: await readFile("/inputs/tls.crt"),
  ca: await readFile("/inputs/tls.crt"),
};
const secrets: string[] = [];
// Hold the first credential use once, so the host can probe the Agent container
// while a Git launcher and helper are running against the gateway.
let held = false;
async function holdOnce() {
  if (held) {
    return;
  }
  held = true;
  await writeFile("/state/held", "ready", { mode: 0o600 });
  // The host releases explicitly; this backstop stays under the gateway's 30 s
  // first-header deadline so a slow probe does not fail the held request. The deadline
  // is checked after each read, so a release during the last wait is still seen.
  const deadline = Date.now() + 25000;
  for (;;) {
    try {
      await lstat("/state/release-hold");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture-hold-timeout");
}
// The mounted peers accept loaded TLS material. GitHub only reads the clock's
// wall time, and neither peer needs the paths produced by their default TLS setup.
type GitHubClock = NonNullable<Parameters<typeof startGitHubFixture>[1]>["clock"];
type GitFixtureTls = NonNullable<
  NonNullable<Parameters<typeof startGitSmartHttpFixture>[1]>["tls"]
>;

const githubOptions = { tls, clock: { wallNow: () => Date.now() } as GitHubClock };
const github: GitHubFixture = await startGitHubFixture(context, githubOptions);
secrets.push(tls.key.toString().split("\n")[1]!);
{
  // The token exists only here and in the service's read-only input mount. The host
  // compares Agent surfaces against it and patterns derived from it; none of these
  // values is ever passed into the Agent container.
  const token = `ghp_${randomBytes(18).toString("hex")}`;
  github.acceptStatic(token);
  secrets.push(
    token,
    token.slice(4),
    Buffer.from(token).toString("base64"),
    Buffer.from(`x-access-token:${token}`).toString("base64"),
  );
  await writeFile("/inputs/token", `${token}\n`, { mode: 0o600 });
}
const git = await startGitSmartHttpFixture(context, {
  tls: tls as GitFixtureTls,
  authorize: github.authorize,
});
const githubOrigin = new URL(github.origin);
const gitOrigin = new URL(git.origin);
const relayErrors: string[] = [];
const sockets = new Set<Socket>();
const relay = createServer(tls, (incoming, outgoing) => {
  const host = incoming.headers.host;
  const origin =
    host === "api.github.com" ? githubOrigin : host === "github.com" ? gitOrigin : undefined;
  if (!origin) {
    outgoing.writeHead(421).end();
    return;
  }
  const target = incoming.url ?? "";
  const [pathname = ""] = target.split("?", 1);
  // Both peers parse the path again. Refuse targets that could change meaning there.
  if (
    !/^\/[\x21-\x7e]*$/.test(target) ||
    target.startsWith("//") ||
    /[\\#]/.test(target) ||
    URL.parse(pathname, origin)?.pathname !== pathname
  ) {
    outgoing.writeHead(400).end();
    return;
  }
  // Include actual JWT and encoded Git authorization in the trusted comparison,
  // so the probe covers more than plaintext installation-token serialization.
  const authorization = incoming.headers.authorization;
  if (authorization) {
    for (const value of [authorization, authorization.slice(authorization.indexOf(" ") + 1)]) {
      if (!secrets.includes(value)) {
        secrets.push(value);
      }
    }
  }
  // Nothing is issued for a static token: hold its first authenticated Git request.
  if (authorization && host === "github.com" && !held) {
    let gone = false;
    incoming.once("close", () => (gone = !incoming.complete));
    incoming.pause();
    holdOnce().then(
      () => (gone ? outgoing.destroy() : forward(incoming, outgoing, origin, target)),
      () => {
        relayErrors.push("hold-failed");
        outgoing.destroy();
      },
    );
    return;
  }
  forward(incoming, outgoing, origin, target);
});
function forward(incoming: IncomingMessage, outgoing: ServerResponse, origin: URL, target: string) {
  const upstream = request(
    origin,
    {
      path: target,
      method: incoming.method,
      headers: { ...incoming.headers, host: origin.host },
      ca: tls.ca,
      rejectUnauthorized: true,
      agent: false,
    },
    (response) => {
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
      response.once("error", () => outgoing.destroy());
    },
  );
  upstream.setTimeout(10000, () => upstream.destroy());
  upstream.once("error", () => {
    relayErrors.push("upstream-failed");
    outgoing.destroy();
  });
  incoming.once("aborted", () => upstream.destroy());
  incoming.pipe(upstream);
}
relay.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(443, "0.0.0.0", resolve);
});

let writing = false;
async function snapshot() {
  if (writing) {
    return;
  }
  writing = true;
  try {
    const report: ProviderReport = {
      ready: true,
      issues: github.issuesOfTokens,
      tokens: github.tokenState(),
      apiTrace: github.trace,
      gitTrace: git.trace,
      errors: [...github.errors, ...relayErrors],
      pushedRef: await git.ref("refs/heads/isolation-feature").catch(() => null),
    };
    for (const [name, value] of [
      ["secrets", secrets],
      ["report", report],
    ]) {
      await writeFile(`/state/${name}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`/state/${name}.tmp`, `/state/${name}.json`);
    }
  } finally {
    writing = false;
  }
}
await snapshot();
const timer = setInterval(
  () =>
    void snapshot().catch(() => {
      process.stderr.write("provider-snapshot-failed\n");
      process.exitCode = 1;
    }),
  100,
);
process.once("SIGTERM", async () => {
  clearInterval(timer);
  const guard = setTimeout(() => process.exit(1), 3000);
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise((resolve) => relay.close(resolve));
  for (const callback of cleanup.reverse()) {
    await callback();
  }
  clearTimeout(guard);
  process.exit(0);
});
