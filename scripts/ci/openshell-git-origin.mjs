/**
 * Runs in a container on the OpenShell Git fixture network for
 * scripts/ci/openshell-git-installed.mjs: the synthetic private Git origin answers as
 * github.com and api.github.com on port 443, and a witness on port 8080 lets the host read
 * refs, the draft and request counts. Synthetic App key and repository only.
 *
 * Usage: node openshell-git-origin.mjs <pki-directory> <output-directory>
 */
import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startSkipperPrivateGitOrigin } from "../../tests/fixtures/skipper-private-git-origin.mjs";

const [pki, out] = process.argv.slice(2);
const repository = process.env.OCE_FIXTURE_REPOSITORY;
const approvalRef = process.env.OCE_FIXTURE_APPROVAL_REF;
if (!pki || !out || !repository || !approvalRef) {
  throw new Error("usage: openshell-git-origin.mjs <pki> <out> (with the fixture repository env)");
}
const origin = await startSkipperPrivateGitOrigin({
  host: "0.0.0.0",
  port: 443,
  advertisedHost: "api.github.com",
  tls: {
    key: await readFile(join(pki, "github-key.pem")),
    cert: await readFile(join(pki, "github.pem")),
    ca: await readFile(join(pki, "ca.pem")),
  },
  repository,
  approvalRef,
  teamReview: true,
});
await writeFile(
  join(out, "private-key.pem"),
  origin.privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600, flag: "wx" },
);
const witness = createServer(async ({ url, method }, response) => {
  const reply = (value) =>
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  try {
    if (method === "GET" && url === "/refs") {
      reply(await origin.readRefs());
    } else if (method === "GET" && url === "/evidence") {
      reply(origin.snapshot());
    } else if (method === "GET" && url === "/pull") {
      reply(await origin.observePullRequest());
    } else if (method === "GET" && url === "/fetch") {
      reply(await origin.witnessCommit());
    } else {
      response.writeHead(404).end();
    }
  } catch {
    response.writeHead(409).end("witness operation failed");
  }
});
witness.listen(8080, "0.0.0.0");
// The host polls for this file: write it last, atomically.
const inputs = {
  repository,
  approvalRef,
  repositoryRef: origin.repositoryRef,
  repositoryId: origin.repositoryId,
  appId: origin.appId,
  installationId: origin.installationId,
  initialSha: origin.initialSha,
};
await writeFile(join(out, "origin.json.next"), JSON.stringify(inputs), { mode: 0o600 });
await rename(join(out, "origin.json.next"), join(out, "origin.json"));
const stop = async () => {
  witness.close();
  await origin.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
