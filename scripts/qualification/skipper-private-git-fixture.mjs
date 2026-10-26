/**
 * Own the synthetic private Git provider across fresh occ dev up, installed test and dev down.
 * Usage: node scripts/qualification/skipper-private-git-fixture.mjs -- <owned-install-script>
 * Set OCC_DEVELOPMENT_PREPARED_GIT_HOST_IP to the private address reachable by the owned k3d.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIPv4 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSkipperPrivateGitOrigin } from "../../tests/fixtures/skipper-private-git-origin.mjs";

const teamReview = process.argv[2] === "--team-review";
const [separator, command, ...args] = process.argv.slice(teamReview ? 3 : 2);
assert.equal(separator, "--");
assert.ok(command);
const host = process.env.OCC_DEVELOPMENT_PREPARED_GIT_HOST_IP;
assert.ok(isIPv4(host) && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host));
const id = randomBytes(8).toString("hex");
const repository = "fixture/skipper-" + id;
const approvalRef = "refs/heads/review/skipper-" + (teamReview ? "acceptance-" : "") + id;
const dir = await mkdtemp(join(tmpdir(), "oce-skipper-"));
const socketPath = join(dir, "witness.sock");
const origin = await startSkipperPrivateGitOrigin({ host, repository, approvalRef, teamReview });
const repositoryRef = origin.repositoryRef;
const publicInput = {
  id,
  repository,
  repositoryRef,
  approvalRef,
  teamReview,
  initialSha: origin.initialSha,
};
const witness = createServer(async ({ url, method }, res) => {
  const out = (v) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
  try {
    if (method === "GET" && url === "/input") {
      out(publicInput);
    } else if (method === "GET" && url === "/evidence") {
      out(origin.snapshot());
    } else if (method === "POST" && url === "/hold-next-discovery") {
      origin.holdNextDiscovery();
      out(true);
    } else if (method === "GET" && url === "/discovery-held") {
      out(origin.discoveryHeld());
    } else if (method === "POST" && url === "/release-discovery") {
      origin.releaseDiscovery();
      out(true);
    } else if (method === "POST" && url === "/release-if-held") {
      if (origin.discoveryHeld()) {
        origin.releaseDiscovery();
      }
      out(true);
    } else if (method === "GET" && url === "/refs") {
      out(await origin.readRefs());
    } else if (method === "GET" && url === "/fetch") {
      out(await origin.witnessCommit());
    } else if (teamReview && method === "GET" && url === "/pull") {
      out(await origin.observePullRequest());
    } else if (method === "DELETE" && /^\/review\/[0-9a-f]{40}$/.test(url)) {
      await origin.deleteApprovalRef(url.slice(-40));
      out(await origin.readRefs());
    } else {
      res.writeHead(404).end();
    }
  } catch {
    res.writeHead(409).end("witness operation failed");
  }
});
try {
  const registry = {
    version: 1,
    backendId: "skipper-fixture",
    providerInstanceId: "fixture",
    appId: origin.appId,
    githubInstallationId: origin.installationId,
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef,
        repository,
        repositoryId: origin.repositoryId,
        namespaces: [
          {
            namespaceId: "${OCC_INITIAL_NAMESPACE_ID}",
            profiles: ["git-write"],
            pushRefAllowlist: [approvalRef],
            ...(teamReview
              ? { transport: "git-and-draft-pr", pullRequestBase: "main" }
              : { transport: "git-only" }),
          },
        ],
      },
    ],
  };
  for (const [name, value] of Object.entries({
    "registry.json": JSON.stringify(registry),
    "upstream-cidrs.json": JSON.stringify([host + "/32"]),
    "private-key.pem": origin.privateKey.export({ type: "pkcs8", format: "pem" }),
    "issuer-ca.crt": origin.tls.ca,
  })) {
    await writeFile(join(dir, name), value, { mode: 0o600, flag: "wx" });
  }
  witness.listen(socketPath);
  await once(witness, "listening");
  await chmod(socketPath, 0o600);
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      OCC_DEVELOPMENT_REPOSITORY_INPUT_DIRECTORY: dir,
      OCC_DEVELOPMENT_PREPARED_GIT_PROVIDER_ORIGIN: origin.origin,
      OCC_TEST_SKIPPER_PRIVATE_GIT_WITNESS: socketPath,
      OCC_TEST_SKIPPER_TEAM_REVIEW: teamReview ? "1" : "0",
    },
  });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  witness.close();
  await origin.close();
  await rm(dir, { recursive: true, force: true });
}
