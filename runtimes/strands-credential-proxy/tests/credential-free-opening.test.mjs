// Real signed supplier + exact Rust sender selection/permit check. The supplier fixture supplies
// the installed observation, TLS test origin and in-memory (not PostgreSQL) receipt repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { staticEgressFixture } from "../../../tests/helpers/static-egress.mjs";
import { captureMetadata } from "../../../tests/helpers/github-metadata-exchange.mjs";

test("Rust requires both explicit credential-free selections, zero Secret or issuer reads and matching receipt on the signed supplier stream", async (t) => {
  const root = new URL("../../../", import.meta.url);
  const proto = "apps/controller/src/drivers/egress-proxy/proto/supervisor_middleware.proto";
  const require = createRequire(new URL("apps/controller/package.json", root));
  const definitions = require("@grpc/proto-loader").loadSync(fileURLToPath(new URL(proto, root)), {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: false,
    oneofs: true,
  });
  const codec = (message) => definitions["openshell.middleware.v1." + message];

  const dir = mkdtempSync(join(tmpdir(), "strands-no-material-wire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Compile first. The Rust permit check must run *inside*, not beyond, the real first-write limit.
  const manifests = execFileSync(
    "cargo",
    ["test", "--profile", "distribution", "--locked", "--no-run", "--message-format", "json"],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      maxBuffer: 8_000_000,
    },
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const { executable } = manifests.find(
    (m) => m.profile?.test && m.executable && m.target.name === "strands-credential-proxy",
  );
  const rust = () =>
    execFileSync(
      executable,
      ["--ignored", "--exact", "selection::tests::portable_no_material_peer"],
      {
        env: { ...process.env, STRANDS_NO_MATERIAL_WIRE_DIR: dir },
      },
    );
  const repository = { id: 7311, full_name: "fixture/credential-free" };
  // The shared fixture provisions a separate static-inference source *before* admitting this source.
  // Snapshot reads immediately before our source exists, then assert zero across the entire tested lifecycle.
  let readsBeforeThisSource;
  let issuerReads = 0;
  const f = await staticEgressFixture(t, {
    preparedGitHub: new Proxy(
      {},
      {
        get() {
          issuerReads++;
          throw Error("issuer/credential access on no-material route");
        },
      },
    ),
    async admitSource({ app, agent, namespace, path, origin, countSecretReads }) {
      readsBeforeThisSource = countSecretReads();
      const admitted = await app.request("POST", path, {
        body: {
          name: "strands-identity-read",
          type: "credential-free-repository-metadata",
          config: {
            origin,
            repository_id: String(repository.id),
            repository: repository.full_name,
            agent_id: agent.id,
            authority: "execution",
          },
        },
      });
      assert.equal(admitted.status, 201);
      const source = admitted.data;
      assert.equal(source.egress.adoption, "credential_free");
      assert.deepEqual(source.secrets, {});
      const bound = await app.request(
        "PATCH",
        "/namespaces/" + namespace.id + "/agents/" + agent.id,
        {
          body: {
            configurationId: agent.configurationId,
            harnessAuth: { method: "runtime" },
            credentialSources: [{ sourceId: source.id }],
          },
        },
      );
      assert.equal(bound.status, 200);
      return { agent: bound.data, source };
    },
  });
  const opening = captureMetadata(f);
  const resolved = await f.resolve(opening);
  assert.ok(
    resolved.ready_without_material && !resolved.ready,
    "signed first gate positively selects no material",
  );
  const save = (path, type, value) => writeFileSync(join(dir, path), codec(type).serialize(value));
  save("opening", "HttpCredentialResolveRequest", opening);
  save("resolved", "HttpCredentialResolveResponse", resolved);
  rust();
  const authorize = codec("HttpCredentialAuthorizeSendRequest").deserialize(
    readFileSync(join(dir, "authorize")),
  );
  const allowed = (await f.authorize(authorize)).allowed;
  save("permit", "HttpCredentialSendPermit", allowed);
  rust(); // Exact Rust checked send-start, empty digest, operation, custody; refused each altered echo.
  const digest = (b) => createHash("sha256").update(b).digest("hex");
  const empty = digest(Buffer.alloc(0));
  assert.equal(authorize.selection, "no_material_required");
  assert.equal(allowed.no_material_required, true);
  assert.equal(allowed.credential_headers_sha256.toString("hex"), empty);
  const id = opening.request.context.request_id;
  const receipt = () =>
    f.controller.transact((u) =>
      u.egressSendReceipts.find({
        sender: f.installation.sender,
        instanceId: f.installation.enforcement.instanceId,
        useId: id,
        attemptId: id,
      }),
    );
  const possible = await receipt();
  assert.equal(possible.material.kind, "no_material_required");
  assert.equal(possible.authorization.injectionDigest, empty);
  assert.equal(possible.authorization.association.custodyId, digest(opening.response_custody));
  assert.deepEqual(possible.outcome, { kind: "uncertain", dispatch: "possible" });

  // The fixture drives this actual TLS origin after the checked permit. Installed qualification, not
  // this peer test, must prove the exact deployed Rust binary owns the provider socket and enforced path.
  f.setResponse({ status: 200, body: { ...repository, private: "never release" } });
  const raw = await f.send(opening, { credential_headers: [] });
  const safe = await f.protect(opening, raw);
  assert.deepEqual(JSON.parse(safe.body), repository);
  assert.deepEqual((await receipt()).observation, {
    kind: "response",
    dispatch: "confirmed",
    status: 200,
  });
  const [request] = f.providerRequests;
  assert.deepEqual(
    Object.keys(request.headers).sort(),
    ["connection", "host"],
    "no credential, not even an empty one",
  );
  for (const changed of [
    { no_material_required: false },
    { no_material_required: undefined },
    { credential_headers_sha256: Buffer.alloc(32) },
  ]) {
    const capture = captureMetadata(f);
    const selection = (await f.resolve(capture)).ready_without_material;
    const correct = f.permitRequest(capture, selection, { noMaterial: true });
    assert.ok(
      (await f.authorize({ ...correct, ...changed })).refused,
      "malformed or downgraded selection fails the real second gate",
    );
  }
  assert.equal(f.providerRequests.length, 1);
  assert.equal(
    f.secretReads - readsBeforeThisSource,
    0,
    "zero provider Secret reads since credential-free source admission",
  );
  assert.equal(issuerReads, 0, "no issuer or prepared credential access at any stage");
});
