import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:https";
import test from "node:test";
import type {
  AttemptContext,
  CredentialRef,
  DriverCustody,
  RepositoryBackend,
  RepositoryBackendFactory,
} from "../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts";
import type { GitHubStaticTokenOwner } from "../../apps/controller/src/drivers/repo/github/credentials/types.ts";
import { githubTokenConfigurationData } from "../fixtures/repository-credentials/builders.mjs";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { appModule } from "../fixtures/repository-credentials/runtime.mjs";
import {
  createLoopbackServiceConfiguration,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { startServiceListeners } from "../fixtures/repository-credentials/service-resources.mjs";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("an approved exchange keeps its original lease through replacement and withdrawal fences the first write", async (t) => {
  const resources = createTestResourceScope(t);
  const clock = createControlledClock();
  const config = await createLoopbackServiceConfiguration(resources, { credentialMarginMs: 100 });
  const tls = await createTlsMaterial(resources);
  const tokens = [`github_pat_${"a".repeat(36)}`, `github_pat_${"b".repeat(36)}`];
  const expected = tokens.map((token) => digest(`Bearer ${token}`));
  const observed: string[] = [];
  const replacementEntered = Promise.withResolvers<void>();
  const releaseReplacement = Promise.withResolvers<void>();
  resources.after(() => releaseReplacement.resolve());
  const origin = await listen(
    resources,
    createServer(tls, async (request, response) => {
      const authorization = digest(request.headers.authorization ?? "");
      observed.push(authorization);
      if (authorization === expected[1]) {
        replacementEntered.resolve();
        await releaseReplacement.promise;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 73, full_name: "fixture/repository" }));
    }),
  );
  const [{ createGitHubDriverFactory }, { createGitHubStaticTokenOwner }] = await Promise.all([
    appModule("drivers/repo/github/credentials/factory"),
    appModule("drivers/repo/github/credentials/static-token"),
  ]);
  const owners: GitHubStaticTokenOwner[] = tokens.map((token) =>
    createGitHubStaticTokenOwner({ token: Buffer.from(token) }),
  );
  resources.after(() => owners.forEach((owner) => owner.close()));
  let selected = owners[0]!;
  const authority: GitHubStaticTokenOwner = {
    kind: "github-token",
    tokenClass: selected.tokenClass,
    withToken: (consume) => selected.withToken(consume),
    close: () => owners.forEach((owner) => owner.close()),
  };
  const realFactory: RepositoryBackendFactory = createGitHubDriverFactory({
    configuration: githubTokenConfigurationData({ leaseSeconds: 900 }),
    authority,
    gatewayOrigin: config.gateway.publicOrigin,
    limits: config.limits,
    clock,
    trustedEndpoints: { apiOrigin: origin, gitOrigin: origin, ca: tls.ca },
  });
  const refs: CredentialRef[] = [];
  const copies: Uint8Array[] = [];
  let custody: DriverCustody | undefined;
  let withdrawn = false;
  let withdrawOnAuthentication = false;
  const factory: RepositoryBackendFactory = {
    ...realFactory,
    create(input) {
      custody = input.custody;
      const backend = realFactory.create(input);
      return {
        ...backend,
        async acquire(...args) {
          const outcome = await backend.acquire(...args);
          if (outcome.kind === "acquired") {
            refs.push(outcome.credential);
          }
          return outcome;
        },
        prepareAuthentication: ((ref, plan) => {
          const authenticate = backend.prepareAuthentication(ref, plan);
          return (bytes, send) => {
            copies.push(bytes);
            if (withdrawOnAuthentication) {
              withdrawn = true;
            }
            return authenticate(bytes, send);
          };
        }) satisfies RepositoryBackend["prepareAuthentication"],
      };
    },
  };
  const { service, listeners } = await startServiceListeners(resources, {
    config,
    factory,
    clock,
    tls,
    upstreamOrigins: [origin],
    providerQueue: undefined,
    log: undefined,
  });
  const originalPaused = Promise.withResolvers<void>();
  const resumeOriginal = Promise.withResolvers<void>();
  resources.after(() => resumeOriginal.resolve());
  let pauseNextStanding = false;
  const opened = service.open({ durationSeconds: 3600, profile: "git-read" }, async () => {
    if (withdrawn) {
      throw new Error("standing-withdrawn");
    }
    if (pauseNextStanding) {
      pauseNextStanding = false;
      originalPaused.resolve();
      await resumeOriginal.promise;
    }
  });
  const fixture = { config, opened, listeners, tls };
  const request = () => gatewayRequest(fixture, "/repos/fixture/repository");
  assert.equal((await request()).status, 200);
  await clock.advance(599_850);
  pauseNextStanding = true;
  const original = request();
  await originalPaused.promise;
  selected = owners[1]!;
  await clock.advance(100);
  const replacement = request();
  await replacementEntered.promise;
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0], refs[1]);
  assert.equal(service.status(opened.session.sessionId).activeUses, 2);

  // A detached caller holding either live ref has no authentication reader, and
  // a fabricated retirement attempt cannot turn the ref into access bytes.
  assert.equal(Reflect.get(custody!, "withAccess"), undefined);
  for (const ref of refs) {
    await assert.rejects(
      custody!.withRetirement({ action: "retire" } as AttemptContext, ref, async () => {
        assert.fail("detached credential access");
      }),
      /FOREIGN_ATTEMPT/,
    );
  }
  releaseReplacement.resolve();
  assert.equal((await replacement).status, 200);
  resumeOriginal.resolve();
  assert.equal((await original).status, 200);
  assert.deepEqual(observed, [expected[0], expected[1], expected[0]]);
  assert.ok(copies.every((copy) => copy.every((byte) => byte === 0)));

  withdrawOnAuthentication = true;
  assert.equal((await request()).status, 503);
  assert.equal(observed.length, 3, "withdrawal must send zero origin requests");
  assert.ok(copies.every((copy) => copy.every((byte) => byte === 0)));
});
