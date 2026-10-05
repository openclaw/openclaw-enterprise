import { randomBytes } from "node:crypto";
import { createServer, request } from "node:https";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { startGitHubFixture } from "../repository-credentials/github.mjs";
import { startGitSmartHttpFixture } from "../repository-credentials/git.mjs";

// Only this trusted fixture container sees provider material. The production
// service still uses its fixed HTTPS origins and verifies their certificates.
const cleanup = [];
const context = { after: (callback) => cleanup.push(callback) };
const tls = {
  key: await readFile("/inputs/tls.key"),
  cert: await readFile("/inputs/tls.crt"),
  ca: await readFile("/inputs/tls.crt"),
};
const secrets = [];
// "github-app" issues installation tokens; "github-token" is the development
// authority, which holds one static token that GitHub never issued to it.
const authority = process.env.ISOLATION_AUTHORITY ?? "github-app";
if (authority !== "github-app" && authority !== "github-token") {
  throw new Error("unknown isolation authority");
}
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
  // first-header deadline so a slow probe does not fail the held request.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      await lstat("/state/release-hold");
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture-hold-timeout");
}
const github = await startGitHubFixture(context, {
  tls,
  clock: { wallNow: () => Date.now() },
  beforeIssueResponse: holdOnce,
  tokenResponse(packet) {
    secrets.push(packet.token);
    return packet;
  },
});
const pem = github.privateKey.export({ type: "pkcs8", format: "pem" });
secrets.push(pem, pem.split("\n")[1], tls.key.toString().split("\n")[1]);
if (authority === "github-token") {
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
} else {
  await writeFile("/inputs/app.pem", pem, { mode: 0o600 });
}
const git = await startGitSmartHttpFixture(context, { tls, authorize: github.authorize });
const relayErrors = [];
const sockets = new Set();
const relay = createServer(tls, (incoming, outgoing) => {
  const host = incoming.headers.host;
  const origin =
    host === "api.github.com" ? github.origin : host === "github.com" ? git.origin : undefined;
  if (!origin) {
    outgoing.writeHead(421).end();
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
  if (authority === "github-token" && authorization && host === "github.com" && !held) {
    let gone = false;
    incoming.once("close", () => (gone = !incoming.complete));
    incoming.pause();
    holdOnce().then(
      () => (gone ? outgoing.destroy() : forward(incoming, outgoing, origin)),
      () => {
        relayErrors.push("hold-failed");
        outgoing.destroy();
      },
    );
    return;
  }
  forward(incoming, outgoing, origin);
});
function forward(incoming, outgoing, origin) {
  const upstream = request(
    new URL(incoming.url, origin),
    {
      method: incoming.method,
      headers: incoming.headers,
      ca: tls.ca,
      rejectUnauthorized: true,
      agent: false,
    },
    (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
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
await new Promise((resolve, reject) => {
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
    const report = {
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
