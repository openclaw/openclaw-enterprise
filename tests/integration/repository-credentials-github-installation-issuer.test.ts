import assert from "node:assert/strict";
import { createServer } from "node:https";
import test from "node:test";
import { preparationIssuerAuthority } from "../../apps/controller/src/drivers/repo/github/credentials/origin.ts";
import type {
  GitHubPreparationAdmission,
  GitHubPreparationStore,
} from "../../apps/controller/src/drivers/repo/github/credentials/prepared-contracts.ts";
import { createGitHubPreparationOwner } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts";
import type { GitHubPreparationDiagnostic } from "../../apps/controller/src/drivers/repo/github/credentials/provider-diagnostics.ts";
import { createOccLogger, emitOccLogEvent } from "../../apps/controller/src/logging.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createPreparedStore } from "../fixtures/repository-credentials/github/prepared-store.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";

function assertCredentialMatches(actual: Uint8Array | undefined, expected: string | undefined) {
  assert.equal(
    actual === undefined
      ? expected === undefined
      : expected !== undefined && Buffer.compare(actual, Buffer.from(expected)) === 0,
    true,
    "credential material mismatch",
  );
}

test("prepared issuer inherits the installation only for its explicit grant; unusable replies stay in custody", async (t) => {
  const tls = await createTlsMaterial(t);
  const clock = createControlledClock();
  const requests: string[] = [];
  let response: Record<string, unknown>;
  let onTcpConnect = () => {};
  const server = createServer(tls, async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/app/installations/91374/access_tokens");
    assert(
      req.headers.authorization === "Bearer synthetic-app-authorization",
      "unexpected issuer authorization",
    );
    assert.equal(req.headers["content-type"], "application/json");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    assert.equal(Number(req.headers["content-length"]), Buffer.byteLength(body));
    requests.push(body);
    res.writeHead(201).end(JSON.stringify(response));
  }).on("connection", () => onTcpConnect());
  const origin = await listen(t, server);
  const issuerAuthority = preparationIssuerAuthority(origin, tls.ca);
  const grant = {
    id: "prepared-grant",
    isolationId: "team",
    appId: "3217",
    installationId: "91374",
  };
  const repository = { id: 5321, full_name: "test-org/repo" };
  const installed = { metadata: "read", contents: "write", issues: "write", deployments: "read" };
  const draft = { metadata: "read", contents: "write", pull_requests: "write" };

  async function issue(
    scope: GitHubPreparationAdmission["grant"],
    reply: Record<string, unknown>,
    body: string | undefined,
    usable: boolean,
    connectionRefused = false,
  ) {
    const token = "synthetic-installation-token-" + requests.length;
    response = { token, expires_at: new Date(clock.wallNow() + 3_600_000).toISOString(), ...reply };
    const admission: GitHubPreparationAdmission = {
      familyId: "family",
      generation: 1,
      ownerEpoch: 1,
      inputVersion: "issuer-key-version",
      issuerAuthority,
      grant: scope,
    };
    // The JavaScript fixture's transaction callbacks are generic; it returns their actual results.
    const store = createPreparedStore(admission).connect() as GitHubPreparationStore;
    let signingKeyCurrent = true;
    const diagnostics: GitHubPreparationDiagnostic[] = [];
    const logged: Record<string, unknown>[] = [];
    const logger = createOccLogger({
      component: "issuer-test",
      destination: {
        write(chunk) {
          logged.push(JSON.parse(String(chunk)));
        },
      },
    });
    if (body === undefined && !connectionRefused) {
      onTcpConnect = () => {
        signingKeyCurrent = false;
      };
    }
    const owner = createGitHubPreparationOwner({
      admission,
      store,
      clock,
      apiOrigin: origin,
      ca: tls.ca,
      minimumValidityMs: 10_000,
      renewBeforeMs: 120_000,
      getKey: async () => ({
        kind: "github-app",
        close() {},
        withJwt: (send) => send("synthetic-app-authorization", () => assert(signingKeyCurrent)),
      }),
      observe(diagnostic) {
        diagnostics.push(diagnostic);
        const { error, ...fields } = diagnostic;
        emitOccLogEvent(logger, {
          event: "worker.error",
          code: "PREPARED_GITHUB_ISSUANCE_DIAGNOSTIC",
          ...fields,
          ...(error ? { errorClass: error } : {}),
        });
        // A broken log sink must not change issuance, its result or cleanup custody.
        throw new Error("sentinel-diagnostic-sink-secret");
      },
    });
    const bounds = { signal: t.signal, deadlineMonoMs: 30_000 };
    const count = requests.length;
    assert.equal(await owner.run("attempt", bounds), usable ? "committed" : "quarantined");
    assert.equal(diagnostics.length, 1);
    const [diagnostic] = diagnostics;
    assert(diagnostic);
    assert.equal(diagnostic.attemptId, "attempt");
    assert.equal(diagnostic.publication, usable ? "committed" : "quarantined");
    assert.equal(diagnostic.requestEndCalled, body !== undefined);
    assert.equal(logged[0]?.attemptId, "attempt");
    assert.equal(logged[0]?.requestEndCalled, body !== undefined);
    assert.equal(logged[0]?.publication, diagnostic.publication);
    assert.equal(logged[0]?.firstFailureStage, diagnostic.firstFailureStage);
    const serialized = JSON.stringify({ diagnostic, logged });
    for (const secret of [
      token,
      "synthetic-app-authorization",
      "sentinel-diagnostic-sink-secret",
      "PRIVATE KEY",
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
    if (body === undefined) {
      // The signing authority changed after TCP connect, before the HTTPS request could start.
      assert.equal(signingKeyCurrent, connectionRefused);
      assert.equal(requests.length, count);
      assert.equal(
        diagnostic.firstFailureStage,
        connectionRefused ? "request-created" : "tls-ready",
      );
      assert.equal(diagnostic.error, connectionRefused ? "connection-refused" : "signer-fenced");
      assert.equal(diagnostic.httpStatus, undefined);
      assert.equal(await owner.run("replacement-attempt", bounds), "blocked");
      assert.equal(requests.length, count);
      onTcpConnect = () => {};
      return;
    }
    assert.deepEqual(requests.slice(count), [body]);
    assert.equal(diagnostic.httpStatus, 201);
    assert.equal(diagnostic.responseComplete, true);
    assert.equal(diagnostic.candidateIdentified, true);
    assert.equal(diagnostic.firstFailureStage, usable ? undefined : "validation");
    await store.readCurrent("family", (row) => {
      assert(row);
      if (usable) {
        assert(row.committed);
        assertCredentialMatches(row.committed.bytes, token);
        assert.deepEqual(row.committed.admission.grant, scope);
      } else {
        assert(row.committed === undefined);
        const [attempt] = row.attempts;
        assert(attempt);
        assert.equal(attempt.state, "quarantined");
        assertCredentialMatches(attempt.candidate, token);
      }
    });
    // A contradictory response can still represent a real issue. Do not mint a replacement.
    assert.equal(await owner.run(usable ? "attempt" : "another-attempt", bounds), "blocked");
    assert.equal(requests.length, count + 1);
  }

  const installation = { ...grant, profile: "github-installation" } as const;
  const all = { permissions: installed, repository_selection: "all" };
  const selected = { ...all, repository_selection: "selected" };
  // GitHub's 201 schema requires only token and expires_at. The empty POST selected inheritance;
  // omitted response metadata must not be mistaken for either an all-repository or a selected list.
  await issue(installation, {}, "{}", true);
  await issue(installation, { permissions: installed }, "{}", true);
  await issue(installation, { repository_selection: "selected" }, "{}", true);
  await issue(installation, all, "{}", true);
  await issue(installation, all, undefined, false);
  await issue(installation, selected, "{}", true);
  await issue(installation, { ...selected, repositories: [repository] }, "{}", true);
  for (const malformed of [
    { repository_selection: null },
    { repository_selection: "unspecified" },
    { permissions: null },
    { repositories: null },
    { permissions: { issues: "unrecognized-level" } },
    { repositories: [repository, repository] },
    { repositories: [repository, { ...repository, id: 5322 }] },
    { expires_at: new Date(clock.wallNow() + 65_000).toISOString() }, // below skew + use floor
    { expires_at: new Date(clock.wallNow() + 7_200_000).toISOString() }, // beyond provider lifetime
  ]) {
    await issue(installation, { ...selected, ...malformed }, "{}", false);
  }

  const narrow = {
    ...grant,
    profile: "git-ref-draft-pr",
    repositoryId: "5321",
    repository: repository.full_name,
  } as const;
  const narrowed = { ...selected, repositories: [repository], permissions: draft };
  const narrowBody =
    '{"repository_ids":[5321],"permissions":{"metadata":"read","contents":"write","pull_requests":"write"}}';
  await issue(narrow, narrowed, narrowBody, true);
  await issue(narrow, {}, narrowBody, false);
  await issue(narrow, { ...narrowed, repository_selection: "all" }, narrowBody, false);
  await issue(narrow, { ...narrowed, permissions: installed }, narrowBody, false);

  // Corrupt persisted input must not turn a repository or permission constraint into an unscoped POST.
  const count = requests.length;
  for (const override of [
    { repositoryId: "5321" },
    { pushRef: "refs/heads/review" },
    { permissions: draft },
  ]) {
    await assert.rejects(
      issue({ ...installation, ...override } as typeof installation, all, "{}", true),
      /invalid-provider-scope/,
    );
  }
  assert.equal(requests.length, count);
  // Refuse a real TCP connection after the fixture listener closes. No HTTP request or
  // replacement may follow, and the diagnostic must distinguish this from a TLS fence.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await issue(installation, all, undefined, false, true);
});

test("background issuer records definite non-issuance only for unambiguous token-free refusals", async (t) => {
  const tls = await createTlsMaterial(t);
  const clock = createControlledClock();
  let status = 401;
  let body = "";
  let requests = 0;
  const origin = await listen(
    t,
    createServer(tls, async (req, res) => {
      for await (const _chunk of req) {
        // Consume the request before returning the selected issuer response.
      }
      requests++;
      res.writeHead(status, { "content-type": "application/json" }).end(body);
    }),
  );
  const admission: GitHubPreparationAdmission = {
    familyId: "refusal-family",
    generation: 1,
    ownerEpoch: 1,
    inputVersion: "issuer-key-version",
    issuerAuthority: preparationIssuerAuthority(origin, tls.ca),
    grant: {
      id: "refusal-grant",
      isolationId: "team",
      appId: "3217",
      installationId: "91374",
      profile: "github-installation",
    },
  };
  const token = "synthetic-cleanup-token";
  const replies = [
    { name: "token-free", body: '{"message":"sentinel-provider-response-secret"}' },
    { name: "null token", body: '{"token":null}' },
    { name: "empty token", body: '{"token":""}' },
    { name: "identified token", body: JSON.stringify({ token }), candidate: token },
    {
      name: "duplicate top-level token",
      body: `{"token":"${token}","token":"${token}"}`,
    },
    {
      name: "escaped duplicate token",
      body: String.raw`{"token":"${token}","to\u006ben":"${token}"}`,
    },
    {
      name: "nested ambiguity with one token",
      body: `{"token":"${token}","permissions":{"contents":"read","contents":"write"}}`,
      candidate: token,
    },
    { name: "token-free ambiguity", body: '{"message":"refused","message":"unknown"}' },
    { name: "malformed", body: '{"message":' },
  ];
  // Exercise each status with an unambiguous refusal, then each ambiguous body at a refusal status.
  const statuses = [
    [200, false],
    [201, false],
    [401, true],
    [403, true],
    [404, true],
    [422, true],
    [500, false],
  ] as const;
  const cases = [
    ...statuses.map(([status, notIssued]) => ({ status, reply: replies[0]!, notIssued })),
    ...replies.slice(1).map((reply) => ({ status: 401, reply, notIssued: false })),
  ];
  for (const scenario of cases) {
    await t.test(`${scenario.status}: ${scenario.reply.name}`, async () => {
      const { reply } = scenario;
      status = scenario.status;
      body = reply.body;
      const store = createPreparedStore(admission).connect() as GitHubPreparationStore;
      const diagnostics: GitHubPreparationDiagnostic[] = [];
      const owner = createGitHubPreparationOwner({
        admission,
        store,
        clock,
        apiOrigin: origin,
        ca: tls.ca,
        minimumValidityMs: 10_000,
        renewBeforeMs: 120_000,
        getKey: async () => ({
          kind: "github-app",
          close() {},
          withJwt: (send) => send("synthetic-app-authorization", () => {}),
        }),
        observe: (diagnostic) => diagnostics.push(diagnostic),
      });
      const before = requests;
      const bounds = { signal: t.signal, deadlineMonoMs: 30_000 };
      assert.equal(await owner.run("original-attempt", bounds), "quarantined");
      assert.equal(requests, before + 1);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.firstFailureStage, "validation");
      assert.equal(diagnostics[0]?.httpStatus, status);
      assert.equal(diagnostics[0]?.responseComplete, true);
      assert.equal(diagnostics[0]?.candidateIdentified, reply.candidate !== undefined);
      for (const secret of [
        token,
        "synthetic-app-authorization",
        "sentinel-provider-response-secret",
      ]) {
        assert.equal(JSON.stringify(diagnostics).includes(secret), false);
      }
      await store.readCurrent(admission.familyId, (row) => {
        assert(row);
        assert(row.committed === undefined);
        assert.equal(row.attempts.length, 1);
        const [attempt] = row.attempts;
        assert(attempt);
        assert.equal(attempt.id, "original-attempt");
        assert.deepEqual(attempt.admission, admission);
        assert.equal(attempt.state, "quarantined");
        assertCredentialMatches(attempt.candidate, reply.candidate);
        assert.equal(attempt.notIssued === true, scenario.notIssued);
      });
      assert.equal(await owner.run("replacement-attempt", bounds), "blocked");
      assert.equal(requests, before + 1);
    });
  }
});
