import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:https";
import { readFile, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { loadRepositoryClientModule } from "../fixtures/repository-credentials/clients.ts";
import { exerciseLiveWorkflow } from "../fixtures/repository-credentials/live-workflow.ts";
import { selfSigned } from "../helpers/certificates.ts";
import {
  cleanEnvironment,
  listen,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.ts";

test("a BOM-prefixed public CA published for a client session verifies Git HTTPS", async (t) => {
  const parent = await realpath(await temporaryDirectory(t, "repository-credentials-live-ca-"));
  await chmod(parent, 0o700);
  const { key, cert, certPath } = await selfSigned(parent, {
    commonName: "localhost",
    subjectAltName: "IP:127.0.0.1",
  });
  const pem = await readFile(certPath);
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), pem]);
  let requests = 0;
  const server = createServer({ key, cert }, (_request, response) => {
    requests++;
    response.writeHead(200);
    response.end();
  });
  const origin = await listen(t, server);
  const [{ writeClientConfiguration, readClientConfiguration }, { singleSessionGitConfiguration }] =
    await Promise.all([
      loadRepositoryClientModule<
        typeof import("../../apps/controller/src/drivers/repo/github/access/client/config.ts")
      >("config", ["writeClientConfiguration", "readClientConfiguration"]),
      loadRepositoryClientModule<
        typeof import("../../apps/controller/src/drivers/repo/github/access/client/native-git.ts")
      >("native-git", ["singleSessionGitConfiguration"]),
    ]);
  const session = join(parent, "session");
  await writeClientConfiguration(
    {
      session: {
        sessionId: "session-live-ca",
        state: "OPEN",
        deadlineWallMs: Date.now() + 86_400_000,
        binding: {
          providerInstanceId: "fixture-provider",
          repositoryId: "fixture-repository",
          grantId: "fixture-grant",
        },
        activeUses: 0,
        cleanup: {
          active: 0,
          pending: 0,
          revoked: 0,
          expired: 0,
          uncertain: 0,
          auxiliaryPending: false,
        },
      },
      bearer: "controlled_gateway_bearer_0000000000000000000000",
      client: {
        gatewayOrigin: origin,
        gitRemote: `${origin}/example/project.git`,
        gitUsername: "gateway-session",
        canonicalApiHost: "github.com",
        apiHost: new URL(origin).hostname,
        repository: "example/project",
      },
    },
    session,
    withBom,
  );
  const published = await readFile(join(session, "ca.pem"));
  assert.equal(published.subarray(0, 3).toString("hex"), "2d2d2d");
  const configuration = await readClientConfiguration(session);
  assert.equal(configuration.hasPublicCa, true);
  const settings = singleSessionGitConfiguration(configuration, session);
  assert.ok(
    settings.some((entry) => entry.startsWith("http.") && entry.endsWith(".sslVerify=true")),
  );
  const result = await run(
    "/usr/bin/git",
    [
      ...settings.flatMap((entry) => ["-c", entry]),
      "-c",
      "http.sslVerify=true",
      "ls-remote",
      `${origin}/example/project.git`,
    ],
    { env: cleanEnvironment({ HOME: parent }), allowFailure: true },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.ok(requests > 0, result.stderr);
});

test(
  "authorized live development-token smoke runs through the native sender with bounded cleanup",
  { timeout: 180000 },
  async (t) => {
    if (process.env.REPOSITORY_CREDENTIALS_LIVE !== "1") {
      t.skip(
        "live provider evidence unavailable: set REPOSITORY_CREDENTIALS_LIVE=1 with an authorized disposable repository and explicit development-token sender",
      );
      return;
    }
    assert.equal(
      process.env.REPOSITORY_CREDENTIALS_LIVE_AUTHORIZED,
      "1",
      "explicit disposable-repository write authorization is required",
    );
    const socket = process.env.REPOSITORY_CREDENTIALS_LIVE_CONTROL_SOCKET;
    const caFile = process.env.REPOSITORY_CREDENTIALS_LIVE_CA;
    assert.ok(
      socket && caFile,
      "live smoke requires the private control socket and public gateway CA",
    );
    await exerciseLiveWorkflow(t, {
      socket,
      readPublicCa: () => readFile(caFile),
    });
  },
);
