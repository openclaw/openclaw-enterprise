import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { validateInstallationTokenResponse } from "../../apps/controller/src/drivers/repo/github/credentials/installation-token-response.ts";
import { githubMetadataProvider } from "../../apps/controller/src/drivers/egress-proxy/github-metadata.ts";
import { captureMetadata, dispatchMetadata } from "../helpers/github-metadata-exchange.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import {
  CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES,
  credentialSourceFieldRequired,
} from "../helpers/refusal-text.mjs";
import { createPreparedStore } from "../fixtures/repository-credentials/github/prepared-store.mjs";
import {
  startGitHubFixture,
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  fixtureAppId,
} from "../fixtures/repository-credentials/github.mjs";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { createGitHubPreparationOwner } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts";
import { preparationIssuerAuthority } from "../../apps/controller/src/drivers/repo/github/credentials/origin.ts";
import { createGitHubWarmReader } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-reader.ts";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/credentials/material.ts";

// Real source/Agent/binding/deployment APIs, IAM, protected forwarder, preparation owner,
// scoped GitHub issuance, HTTPS GET and actual last trailer. The test plays the enrolled supervisor and the store is in-memory;
// installed custody and PostgreSQL recovery have their own qualifications.
test("consented protected repository read uses only exact, already prepared metadata grant", async (t) => {
  let forbiddenTrailer = false;
  let spelling;
  const clock = createSystemClock();
  const gh = await startGitHubFixture(t, {
    clock,
    beforeMetadataResponse({ response }) {
      if (forbiddenTrailer) {
        response.addTrailers({ "x-forbidden-last": "last" });
      }
    },
    metadataResponse: (body) => (spelling === undefined ? body : { ...body, full_name: spelling }),
  });
  const key = createGitHubKeyOwner({ appId: fixtureAppId, clock, privateKey: gh.privateKey });
  t.after(() => key.close());
  let reads = 0;
  let sendChecks = 0;
  let store;
  let admission;
  let reader;
  let owner;
  const config = {
    app_id: fixtureAppId,
    installation_id: fixtureInstallationId,
    repository_id: fixtureRepositoryId,
    repository: fixtureRepository,
  };
  const f = await staticEgressFixture(t, {
    protectedSourceOnly: true,
    preparedGitHub: {
      apiOrigin: gh.origin,
      async configure(source, secret) {
        assert.equal(secret.name, "provider-key");
        const { grant } = source;
        const { id, generation } = source.key.source;
        admission = {
          familyId: id,
          issuerAuthority: preparationIssuerAuthority(gh.origin, gh.tls.ca),
          generation,
          ownerEpoch: 1,
          inputVersion: "fixture-key-1",
          grant: { ...grant, id },
        };
        store = createPreparedStore(admission).connect();
        reader = createGitHubWarmReader(store, clock.wallNow);
        owner = createGitHubPreparationOwner({
          admission,
          store,
          clock,
          getKey: async () => key,
          apiOrigin: gh.origin,
          ca: gh.tls.ca,
          renewBeforeMs: 120000,
          minimumValidityMs: 10000,
        });
      },
      async readWarm(source, { signal, deadlineAt }) {
        signal.throwIfAborted();
        assert.ok(Date.parse(deadlineAt) > clock.wallNow());
        reads++;
        assert.equal(source.origin, gh.origin);
        const result = await reader.readWarm(admission);
        if (result.kind !== "warm") {
          return undefined;
        }
        const { materialVersion, providerExpiresAt, usableUntil, bytes, attemptId } =
          result.material;
        try {
          return {
            value: Buffer.from(bytes).toString(),
            materialVersion,
            providerExpiresAt: new Date(providerExpiresAt).toISOString(),
            usableUntil: new Date(usableUntil).toISOString(),
            materialId: admission.familyId,
            family: source.key.source,
            preparationAttemptId: attemptId,
            ownerEpoch: 1,
            inputVersion: admission.inputVersion,
          };
        } finally {
          bytes.fill(0);
        }
      },
      async current(_source, evidence) {
        sendChecks++;
        return store.readCurrent(
          admission.familyId,
          (row) =>
            row?.enabled === true &&
            row.committed.materialVersion === evidence.materialVersion &&
            row.committed.attemptId === evidence.preparationAttemptId,
        );
      },
    },
    async admitSource({ app, agent, namespace, secret, path }) {
      const input = {
        name: "protected-repository-read",
        type: "github-app-metadata",
        config: { ...config, agent_id: agent.id },
        secrets: { private_key: secret.ref },
      };
      const missingConsent = await app.request("POST", path, { body: input });
      // No lifecycle was configured; the catalog requires consent, and the refusal names it.
      assert.equal(missingConsent.status, 400);
      assert.equal(
        missingConsent.body.error.message,
        credentialSourceFieldRequired("github-app-metadata", "config.authority"),
      );
      assert.equal(owner, undefined);
      input.config.authority = "execution";
      // An issuer Secret reference to another Namespace is the request's own error, refused as
      // the Credential Gateway path refuses it (finding 2536), before any issuer work.
      const crossed = await app.request("POST", path, {
        body: {
          ...input,
          secrets: { private_key: { ...secret.ref, namespaceId: `ns_${randomUUID()}` } },
        },
      });
      assert.equal(crossed.status, 400, JSON.stringify(crossed.body));
      assert.equal(crossed.body.error.code, "INVALID_REQUEST");
      assert.equal(crossed.body.error.message, CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);
      assert.equal(owner, undefined);
      const created = await app.request("POST", path, { body: input });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const source = created.data;
      const bound = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        body: {
          configurationId: agent.configurationId,
          harnessAuth: { method: "runtime" },
          credentialSources: [{ sourceId: source.id }],
        },
      });
      assert.equal(bound.status, 200, JSON.stringify(bound.body));
      return { agent: bound.data, source };
    },
  });

  const { installation } = f;
  const [route] = installation.plan.routes;
  assert.equal(route.binding.grant.profile, "metadata-read");
  assert.equal(f.attachment.configuration.network_policies["oce-egress-0"].binaries, undefined);
  const signal = new AbortController().signal;
  const resolve = (changed) => f.resolve(captureMetadata(f, changed));
  assert.equal(
    (await resolve()).refused.code,
    f.refusalCode("NOT_READY"),
    "cold material must return not ready",
  );
  assert.equal(reads, 1);
  assert.equal(gh.issuesOfTokens.length, 0, "cold capture must not issue or schedule");
  for (const changed of [
    { body: Buffer.from("x") },
    { target: { method: "POST" } },
    { headers: [{ name: "transfer-encoding", value: "chunked" }] },
    { target: { path: "/repos/other/repo" } },
    ...[
      "/fixture/repository.git/info/refs?service=git-upload-pack",
      "/fixture/repository.git/git-upload-pack",
      "/fixture/repository.git/git-receive-pack",
    ].map((path) => ({ target: { path } })),
  ]) {
    assert.equal((await resolve(changed)).refused.code, f.refusalCode("DENIED"));
  }
  assert.equal(reads, 1, "wrong body, target or method touched prepared material");
  assert.equal(
    await owner.run("managed-prepare-1", { signal, deadlineMonoMs: clock.monotonicNow() + 20000 }),
    "committed",
  );
  assert.equal(gh.issuesOfTokens.length, 1);

  // A replacement grant callback must not participate in an already resolved exchange,
  // even when it would return the same authorized grant.
  const providers = f.egress.sourceControl.providers;
  const providerIndex = providers.findIndex(
    (provider) => provider.ref.id === githubMetadataProvider.ref.id,
  );
  const registered = providers[providerIndex];
  const selected = { ...registered };
  providers[providerIndex] = selected;
  try {
    const captured = captureMetadata(f);
    const { ready } = await f.resolve(captured);
    assert.ok(ready);
    let replacementCalls = 0;
    selected.normalizeGrant = function (...args) {
      replacementCalls += 1;
      return Reflect.apply(registered.normalizeGrant, this, args);
    };
    const result = await f.authorize(f.permitRequest(captured, ready));
    assert.ok(result.refused);
    assert.equal(result.allowed, undefined);
    assert.equal(replacementCalls, 0);
  } finally {
    providers[providerIndex] = registered;
  }

  // The registry lowercases the repository; GitHub answers with its own spelling, and the
  // response releases the admitted name (finding 2239). Another name is never released.
  for (const [block, spelled, released = true] of [
    [false],
    [false, "Fixture/Repository"],
    [false, "FIXTURE/REPOSITORY"],
    [false, "fixture/repository-other", false],
    [false, "fixture/repository.git", false],
    // Only ASCII letter case may differ: no lookalike letters, no non-string names.
    [false, "fixture/repo\u017Fitory", false],
    [false, null, false],
    [true],
  ]) {
    forbiddenTrailer = block;
    spelling = spelled;
    const captured = captureMetadata(f);
    const { ready } = await f.resolve(captured);
    assert.ok(ready);
    const safe = await dispatchMetadata(f, gh, captured, ready, block);
    if (!block && released) {
      assert.equal(
        safe.body.toString(),
        JSON.stringify({ id: Number(fixtureRepositoryId), full_name: fixtureRepository }),
        String(spelled),
      );
    } else if (!block) {
      assert.deepEqual(safe, { blocked: true }, String(spelled));
    }
  }
  spelling = undefined;
  const captured = captureMetadata(f);
  const { ready } = await f.resolve(captured);
  await store.transact(admission.familyId, (row) => {
    row.enabled = false;
  });
  assert.equal(
    (await f.authorize(f.permitRequest(captured, ready))).refused.code,
    f.refusalCode("DENIED"),
  );
  assert.equal(sendChecks, 9);
  assert.equal(gh.issuesOfTokens.length, 1, "no request may renew or issue");
});

// Conformance only: synthetic strings exercise the shared wire envelope, not provider authentication.
test("prepared GitHub metadata preserves the acquisition wire credential envelope", () => {
  const observedWallMs = Date.parse("2026-10-15T12:00:00Z");
  const policy = {
    repositoryId: fixtureRepositoryId,
    repository: fixtureRepository,
    permissions: { metadata: "read" },
    minimumValidityMs: 10000,
  };
  const cases = [
    ...[1, 7, 8, 8192, 8193, 16384].map((length) => ({
      label: `length ${length}`,
      value: "x".repeat(length),
      accepted: true,
    })),
    ...[
      ["empty", ""],
      ["over limit", "x".repeat(16385)],
      ["embedded space", "xxxx xxxx"],
      ["trailing space", "xxxxxxxx "],
      ["embedded newline", "xxxx\nxxxx"],
      ["trailing newline", "xxxxxxxx\n"],
      ["control", "xxxx\u0000xxxx"],
      ["non-ASCII", "xxxxéxxxx"],
      ["non-string", 123],
    ].map(([label, value]) => ({ label, value, accepted: false })),
  ];
  for (const { label, value, accepted } of cases) {
    const decision = validateInstallationTokenResponse(
      201,
      {
        token: value,
        expires_at: "2026-10-15T13:00:00Z",
        permissions: policy.permissions,
        repositories: [{ id: Number(fixtureRepositoryId), full_name: fixtureRepository }],
      },
      "synthetic-custody-reference",
      observedWallMs,
      policy,
    );
    assert.equal(decision.kind, accepted ? "validated" : "uncertain", label);
    if (accepted) {
      const headers = githubMetadataProvider.inject(value);
      // Compare booleans so a failure cannot dump a large credential header.
      assert.equal(
        headers.length === 1 &&
          headers[0][0] === "authorization" &&
          headers[0][1] === "Bearer " + value,
        true,
        label,
      );
    } else {
      assert.throws(
        () => githubMetadataProvider.inject(value),
        /Invalid prepared GitHub installation credential/,
        label,
      );
    }
  }
});
