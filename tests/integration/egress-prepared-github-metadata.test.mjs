import test from "node:test";
import assert from "node:assert/strict";
import { validateInstallationTokenResponse } from "../../apps/controller/src/drivers/repo/github/credentials/driver/acquisition-response.ts";
import { githubMetadataProvider } from "../../apps/controller/src/drivers/egress-proxy/github-metadata.ts";
import { captureMetadata, dispatchMetadata } from "../helpers/github-metadata-exchange.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { preparedMetadataFixture } from "../helpers/prepared-metadata-fixture.mjs";
import {
  startGitHubFixture,
  fixtureRepository,
  fixtureRepositoryId,
} from "../fixtures/repository-credentials/github.mjs";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";

// Real source/Agent/binding/deployment APIs, IAM, protected forwarder, preparation owner,
// scoped GitHub issuance, HTTPS GET and actual last trailer. The test plays the enrolled supervisor and the store is in-memory;
// installed custody and PostgreSQL recovery have their own qualifications.
test("consented protected repository read uses only exact, already prepared metadata grant", async (t) => {
  let forbiddenTrailer = false;
  const clock = createSystemClock();
  const gh = await startGitHubFixture(t, {
    clock,
    beforeMetadataResponse({ response }) {
      if (forbiddenTrailer) {
        response.addTrailers({ "x-forbidden-last": "last" });
      }
    },
  });
  const fixture = preparedMetadataFixture(t, { gh, clock });
  const f = await staticEgressFixture(t, {
    preparedGitHub: fixture.preparedGitHub,
    async admitSource({ app, agent, namespace, secret, path }) {
      const input = {
        name: "protected-repository-read",
        type: "github-app-metadata",
        config: { ...fixture.config, agent_id: agent.id },
        secrets: { private_key: secret.ref },
      };
      const missingConsent = await app.request("POST", path, { body: input });
      // OCC intentionally hides out-of-scope catalog fields. No lifecycle was configured; the only added field is consent.
      assert.equal(missingConsent.status, 404);
      assert.equal(fixture.configured, false);
      input.config.authority = "execution";
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
  const resolve = (changed) => f.resolve(captureMetadata(f, changed));
  assert.equal(
    (await resolve()).refused.code,
    f.refusalCode("NOT_READY"),
    "cold material must return not ready",
  );
  assert.equal(fixture.reads, 1);
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
  assert.equal(fixture.reads, 1, "wrong body, target or method touched prepared material");
  assert.equal(await fixture.prepare(), "committed");
  assert.equal(gh.issuesOfTokens.length, 1);

  for (const block of [false, true]) {
    forbiddenTrailer = block;
    const captured = captureMetadata(f);
    const { ready } = await f.resolve(captured);
    assert.ok(ready);
    const safe = await dispatchMetadata(f, gh, captured, ready, block);
    if (!block) {
      assert.equal(
        safe.body.toString(),
        JSON.stringify({ id: Number(fixtureRepositoryId), full_name: fixtureRepository }),
      );
    }
  }
  const captured = captureMetadata(f);
  const { ready } = await f.resolve(captured);
  await fixture.disable();
  assert.equal(
    (await f.authorize(f.permitRequest(captured, ready))).refused.code,
    f.refusalCode("DENIED"),
  );
  assert.equal(fixture.sendChecks, 3);
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
