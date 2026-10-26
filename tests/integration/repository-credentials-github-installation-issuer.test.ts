import assert from "node:assert/strict";
import { createServer } from "node:https";
import test from "node:test";
import { preparationIssuerAuthority } from "../../apps/controller/src/drivers/repo/github/credentials/grants.ts";
import type {
  GitHubPreparationAdmission,
  GitHubPreparationStore,
} from "../../apps/controller/src/drivers/repo/github/credentials/prepared-contracts.ts";
import { createGitHubPreparationOwner } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-owner.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createPreparedStore } from "../fixtures/repository-credentials/github/prepared-store.mjs";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";

test("prepared issuer inherits the installation only for its explicit grant; unusable replies stay in custody", async (t) => {
  const tls = await createTlsMaterial(t);
  const clock = createControlledClock();
  const requests: string[] = [];
  let response: Record<string, unknown>;
  let onTcpConnect = () => {};
  const origin = await listen(
    t,
    createServer(tls, async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/app/installations/91374/access_tokens");
      assert.equal(req.headers.authorization, "Bearer synthetic-app-authorization");
      assert.equal(req.headers["content-type"], "application/json");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      assert.equal(Number(req.headers["content-length"]), Buffer.byteLength(body));
      requests.push(body);
      res.writeHead(201).end(JSON.stringify(response));
    }).on("connection", () => onTcpConnect()),
  );
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
    const store = createPreparedStore(admission).connect() as unknown as GitHubPreparationStore;
    let signingKeyCurrent = true;
    if (body === undefined) {
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
    });
    const bounds = { signal: t.signal, deadlineMonoMs: 30_000 };
    const count = requests.length;
    assert.equal(await owner.run("attempt", bounds), usable ? "committed" : "quarantined");
    if (body === undefined) {
      // The signing authority changed after TCP connect, before the HTTPS request could start.
      assert.equal(signingKeyCurrent, false);
      assert.equal(requests.length, count);
      onTcpConnect = () => {};
      return;
    }
    assert.deepEqual(requests.slice(count), [body]);
    await store.readCurrent("family", (row) => {
      assert(row);
      if (usable) {
        assert.equal(Buffer.from(row.committed!.bytes).toString(), token);
        assert.deepEqual(row.committed!.admission.grant, scope);
      } else {
        assert.equal(row.committed, undefined);
        const [attempt] = row.attempts;
        assert.equal(attempt!.state, "quarantined");
        assert.equal(Buffer.from(attempt!.candidate!).toString(), token);
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
});
