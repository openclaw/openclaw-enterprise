import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { selectedReadGitJourney } from "./postgres-repository-set-journey.ts";
import { fixtureRepository } from "../fixtures/repository-credentials/github.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { harnessTlsFixture } from "./harness-tls.mjs";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { openShellGitGrantPrelude } from "../../apps/controller/src/drivers/sandbox/openshell-git-client.ts";

const wireCase =
  "l7::relay::token_grant_ownership_tests::provider_client_assertion_wire::placeholder_fetch::joined::provider_client_assertion_occ_git_wire";

async function writeJson(path: string, value: unknown) {
  await writeFile(path + ".tmp", JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(path + ".tmp", path);
}

async function waitForReceipt(
  path: string,
  stopped: () => Promise<unknown> | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  while (true) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const completed = stopped();
    if (completed) {
      await completed;
      return JSON.parse(await readFile(path, "utf8"));
    }
    await delay(25, undefined, { signal });
  }
}

export async function runOpenShellPlaceholderWire(t: TestContext, testUrl: string, binary: string) {
  assert.ok(isAbsolute(binary), "An absolute compiled OpenShell test binary path is required.");
  assert.ok(process.env.OCC_TEST_DATABASE_URL, "An owned PostgreSQL file fixture is required.");
  const directory = await temporaryDirectory(t, "oce-openshell-join-");
  await selectedReadGitJourney(
    t,
    testUrl,
    async ({
      runtime,
      peer,
      pool,
      sandboxId,
      workspace,
      revision,
      launch,
      middleware,
      grant,
      finishIssuance,
      removeBinding,
    }) => {
      const bindingId = revision.egressPlan!.execution.executionId;
      const route = await runtime.lookup(
        {
          sandboxId,
          bindingId,
          requestId: randomUUID(),
          workspace,
        },
        t.signal,
      );
      assert.ok(route?.installed.route);
      const { providerId } = route.installed.route.observed as {
        providerId: string;
      };
      assert.ok(providerId);
      assert.equal(launch.grantRepositoryUrl, `https://github.com/${fixtureRepository}.git`);
      const gitEnvironment = Object.fromEntries(
        launch.environment.map(({ name, value }) => [name, value]),
      );
      assert.equal(gitEnvironment.GITHUB_TOKEN, undefined);
      const gitClientPrelude = openShellGitGrantPrelude(launch.grantRepositoryUrl);

      const signingKey = join(directory, "assertion-signing.pem");
      const publicKey = join(directory, "assertion-public.pem");
      const tokenCa = join(directory, "token-ca.pem");
      await Promise.all([
        writeFile(signingKey, grant.keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
          mode: 0o600,
        }),
        writeFile(publicKey, grant.keys.publicKey.export({ type: "spki", format: "pem" }), {
          mode: 0o600,
        }),
        writeFile(tokenCa, grant.ca, { mode: 0o600 }),
      ]);
      // Use the repository's real Git fixture with a normal signed TLS leaf for
      // rustls. The actual OCE provider fixture accepts only its own live token.
      const originTls = await harnessTlsFixture(t);
      const gitOrigin = await startGitSmartHttpFixture(t, {
        repository: fixtureRepository,
        tls: {
          key: Buffer.from(originTls.key),
          cert: Buffer.from(originTls.cert),
          ca: Buffer.from(originTls.caBundle),
          keyFile: originTls.keyPath,
          certFile: originTls.certPath,
        },
        authorize(authorization, boundary) {
          if (!authorization?.startsWith("Basic ")) {
            return false;
          }
          const pair = Buffer.from(authorization.slice(6), "base64").toString();
          return pair.startsWith("x-access-token:") && peer.gh.authorize(authorization, boundary);
        },
      });
      const origin = new URL(gitOrigin.origin);
      assert.equal(origin.hostname, "127.0.0.1");
      const oid = await gitOrigin.addCommit();
      assert.equal(await gitOrigin.ref("main"), oid);
      const firstFetchReceipt = join(directory, "first.json");
      const withdrawalReady = join(directory, "withdrawal.json");
      const withdrawnFetchReceipt = join(directory, "withdrawn.json");
      const config = join(directory, "join.json");
      await writeJson(config, {
        token_endpoint: grant.endpoint,
        token_ca: tokenCa,
        issuer: grant.issuer.replace(/^openshell-gateway:/u, ""),
        key_id: "git-grant",
        signing_key: signingKey,
        public_key: publicKey,
        sandbox_id: sandboxId,
        provider_id: providerId,
        credential_key: "installation_token",
        audience: bindingId,
        workspace,
        middleware_name: peer.registrationName,
        middleware_endpoint: middleware.endpoint,
        middleware_bearer: middleware.bearer,
        origin_host: origin.hostname,
        origin_port: Number(origin.port),
        origin_ca: originTls.rootCertificatePath,
        origin_server_name: "localhost",
        git_url: launch.grantRepositoryUrl,
        git_environment: gitEnvironment,
        git_client_prelude: gitClientPrelude,
        node_binary: process.execPath,
        expected_oid: oid,
        first_fetch_receipt: firstFetchReceipt,
        withdrawal_ready: withdrawalReady,
        withdrawn_fetch_receipt: withdrawnFetchReceipt,
      });

      const receiptCounts = async () => {
        const { rows } = await pool.query<{ operation: string }>(
          `SELECT operation FROM occ.prepared_repository_git_uses u
         JOIN occ.repository_session_attempts s USING (admission_id)
         WHERE s.revision_id=$1 ORDER BY authorization_reply_by`,
          [revision.id],
        );
        return rows.map(({ operation }) => operation);
      };
      const consumedApprovals = async () => {
        const { rows } = await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM occ.request_credential_approvals
         WHERE revision_id=$1 AND recipient_id=$2 AND consumed`,
          [revision.id, sandboxId],
        );
        return rows[0]!.count;
      };
      assert.deepEqual(await receiptCounts(), []);
      assert.equal(await consumedApprovals(), 0);
      assert.equal(peer.gh.issuesOfTokens.length, 0);
      assert.equal(gitOrigin.traffic().requests, 0);
      finishIssuance();

      const controller = new AbortController();
      const signal = AbortSignal.any([t.signal, controller.signal, AbortSignal.timeout(30_000)]);
      let stopped = false;
      const options = {
        cwd: dirname(binary),
        env: cleanEnvironment({ OPENSHELL_PLACEHOLDER_WIRE_JOIN: config }),
        signal,
      };
      const exited = run(
        binary,
        ["--ignored", "--exact", wireCase, "--nocapture"],
        options,
      ).finally(() => {
        stopped = true;
      });
      void exited.catch(() => {});
      const completed = () => (stopped ? exited : undefined);
      try {
        const fetched = await waitForReceipt(firstFetchReceipt, completed, signal);
        assert.deepEqual(fetched, { oid, git_commands: 1 });
        const served = gitOrigin.trace.map(({ method, path }) => ({
          method,
          path,
        }));
        assert.deepEqual(served[0], {
          method: "GET",
          path: `/${fixtureRepository}.git/info/refs`,
        });
        assert.ok(served.length > 1);
        assert.ok(
          served
            .slice(1)
            .every(
              ({ method, path }) =>
                method === "POST" && path === `/${fixtureRepository}.git/git-upload-pack`,
            ),
        );
        assert.equal(
          gitOrigin.traffic().requests,
          served.length,
          "no upstream credential challenge or unauthorized retry",
        );
        const redemptions = await receiptCounts();
        assert.equal(redemptions.length, served.length);
        assert.equal(redemptions[0], "advertise-upload-pack");
        assert.ok(redemptions.slice(1).every((operation) => operation === "upload-pack"));
        assert.equal(await consumedApprovals(), redemptions.length);
        assert.equal(peer.gh.issuesOfTokens.length, 1);
        assert.deepEqual(peer.gh.issuesOfTokens[0].repositoryIds, [73]);
        assert.deepEqual(peer.gh.issuesOfTokens[0].permissions, {
          metadata: "read",
          contents: "read",
        });
        t.diagnostic(
          JSON.stringify({
            git_commands: 1,
            oid,
            issuer_mints: 1,
            redemptions,
            served,
          }),
        );

        const withdrawn = await gitOrigin.addCommit();
        assert.notEqual(withdrawn, oid);
        assert.equal(await gitOrigin.ref("main"), withdrawn);
        const deadline = revision.repositoryCredentials!.deadlineWallMs;
        assert.ok(deadline > Date.now(), "withdraw the binding before its natural expiry");
        await removeBinding();
        await writeJson(withdrawalReady, { withdrawn_oid: withdrawn });
        const refusal = await waitForReceipt(withdrawnFetchReceipt, completed, signal);
        const expectedRefusal = {
          oid: withdrawn,
          exit_code: 128,
          present: false,
          git_commands: 1,
        };
        assert.deepEqual(refusal, expectedRefusal);
        assert.ok(deadline > Date.now(), "the refusal occurred before natural expiry");
        assert.equal((await exited).code, 0);
        assert.deepEqual(await receiptCounts(), redemptions);
        assert.equal(await consumedApprovals(), redemptions.length);
        assert.equal(peer.gh.issuesOfTokens.length, 1);
        assert.equal(gitOrigin.traffic().requests, served.length);
        t.diagnostic(
          JSON.stringify({
            ...expectedRefusal,
            redemptions: 0,
            issuer_mints: 0,
            origin_requests: 0,
          }),
        );
      } finally {
        controller.abort();
        await exited.catch(() => {});
      }
    },
  );
}
