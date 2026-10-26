import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  bindRuntimeSource,
  commitLossScenario,
  noMaterialSelection,
} from "../helpers/postgres-protected-scenarios.mjs";
import { receipts as installedReceipts } from "../helpers/egress-custody-observations.mjs";
import { captureMetadata } from "../helpers/github-metadata-exchange.mjs";
import { credentialSourceFieldRequired } from "../helpers/refusal-text.mjs";

// Acts as the enrolled supervisor on genuine TLS gRPC; exercises real API, IAM, HTTP origin and
// PostgreSQL dispatch + recovery. Supplier custody and network enforcement need the installed suite.
test(
  "explicit protected credential-free metadata: both gates, false selections, lost COMMIT and last withdrawal",
  { ...requiresPostgres, timeout: 120_000 },
  async (t) => {
    let issuerAccess = 0;
    let readsBeforeAdmission;
    const repository = { id: 7311, full_name: "fixture/credential-free" };
    const { f, pool, proxy, receipt, assertLostDispatch } = await commitLossScenario(t, {
      // Gateway and Proxy IDs are in distinct capability namespaces and may legally coincide.
      proxyDriverId: "openshell-credentials",
      preparedGitHub: new Proxy(
        {},
        {
          get() {
            issuerAccess++;
            throw Error("Credential-free metadata must never access the issuer or prepared store.");
          },
        },
      ),
      async admitSource({ app, agent, namespace, path, origin, countSecretReads }) {
        readsBeforeAdmission = countSecretReads();
        const config = {
          origin,
          repository_id: String(repository.id),
          repository: repository.full_name,
          agent_id: agent.id,
        };
        const input = {
          name: "identity-only",
          type: "credential-free-repository-metadata",
          config,
        };
        const post = (body) => app.request("POST", path, { body });
        // No implicit execution authority: the catalog requires it, and the refusal names it.
        const implicit = await post(input);
        assert.equal(implicit.status, 400, "no implicit execution authority");
        assert.equal(
          implicit.body.error.message,
          credentialSourceFieldRequired("credential-free-repository-metadata", "config.authority"),
        );
        const { status, data: source } = await post({
          ...input,
          config: { ...config, authority: "execution" },
        });
        assert.equal(status, 201);
        assert.equal(source.ownerCapability, "credential_proxy");
        for (const [url, select] of [
          [path, (data) => data.find(({ id }) => id === source.id)],
          [path + "/" + source.id, (data) => data],
        ]) {
          const response = await app.request("GET", url);
          assert.equal(response.status, 200);
          assert.equal(select(response.data).ownerCapability, "credential_proxy");
        }
        assert.equal(source.egress.adoption, "credential_free");
        assert.deepEqual(source.secrets, {});
        return bindRuntimeSource(app, namespace, agent, source);
      },
    });
    assert.equal(
      f.secretReads,
      readsBeforeAdmission,
      "source + Agent + revision admission never read a provider Secret",
    );
    assert.deepEqual(
      f.revision.credentialSources,
      [
        {
          sourceId: f.source.id,
          sourceType: f.source.type,
          credentialProxyId: f.controller.selectedDriver("credential_gateway").id,
        },
      ],
      "a new protected source names the Proxy even when the Gateway has the same ID",
    );
    const capture = (changed) => captureMetadata(f, changed);
    const resolve = async (captured, peer) => {
      const selection = noMaterialSelection(await f.resolve(captured, peer), captured);
      return f.permitRequest(captured, selection, { noMaterial: true });
    };
    const emptyDigest = createHash("sha256").digest("hex");
    const accepted = capture();
    for (const changed of [
      { target: { method: "POST" } },
      { body: Buffer.from("not-bodyless") },
      { target: { path: "/repos/other/repository" } },
      ...["authorization", "cookie", "proxy-authorization", "x-oce-binding", "x-api-key"].map(
        (name) => ({ headers: [{ name, value: "must-not-send" }] }),
      ),
    ]) {
      const { refused } = await f.resolve(capture(changed));
      assert.ok(refused, "do not admit a different read or ambient credentials");
    }
    const old = f.observed.evidence.enforced_capabilities;
    f.observed.evidence.enforced_capabilities = old.slice(0, -1);
    assert.ok(
      (await f.resolve(capture())).refused,
      "credentialed-only four-capability installation cannot claim no-material",
    );
    f.observed.evidence.enforced_capabilities = old;
    const permit = await resolve(accepted);
    const allowed = (await f.authorize(permit)).allowed;
    assert.equal(allowed.no_material_required, true);
    assert.equal(allowed.credential_headers_sha256.toString("hex"), emptyDigest);
    const audience = await receipt(accepted);
    const {
      binding: { material },
      dispatch,
    } = audience;
    assert.deepEqual(Object.keys(material).sort(), [
      "binding",
      "grantHash",
      "isolationId",
      "kind",
      "source",
    ]);
    assert.equal(material.kind, "no_material_required");
    assert.equal(material.isolationId, f.agent.id);
    assert.equal(dispatch.injectionDigest, emptyDigest);
    assert.equal(
      dispatch.association.installation.policyHash,
      accepted.verified_execution_policy_hash,
    );
    assert.equal(
      dispatch.association.custodyId,
      createHash("sha256").update(accepted.response_custody).digest("hex"),
    );
    f.setResponse({ status: 200, body: { ...repository, private: "must not release" } });
    const response = await f.send(accepted, { credential_headers: [] });
    const protectedResponse = await f.protect(accepted, response);
    assert.equal(protectedResponse.response_complete, true);
    assert.deepEqual(JSON.parse(protectedResponse.body), repository);
    const installed = await installedReceipts(pool, f.installation, "no_material_required");
    assert.ok(
      installed.length === 1 && installed[0].exact && installed[0].observation.kind === "response",
      "installed observer reads the real no-material dispatch + response row with its genuine peer shape",
    );
    const configured = (
      await pool.query(
        "SELECT EXISTS (SELECT FROM occ.credential_source_secrets WHERE credential_source_id=$1) AS secret, EXISTS (SELECT FROM occ.prepared_github_families WHERE source_id=$1) AS family",
        [f.source.id],
      )
    ).rows;
    assert.deepEqual(configured, [{ secret: false, family: false }]);
    const [request, ...extra] = f.providerRequests;
    assert.equal(request.method, "GET");
    assert.equal(request.path, "/repos/" + repository.full_name);
    assert.equal(request.body, undefined);
    assert.deepEqual(Object.keys(request.headers).sort(), ["connection", "host"]);
    assert.deepEqual(extra, []);
    assert.equal(proxy.egress.authorizations, 1, "one acknowledged durable dispatch");

    for (const changed of [
      { no_material_required: false },
      { no_material_required: undefined },
      { credential_headers_sha256: Buffer.alloc(32) },
      { evidence: { material_id: "forged" } },
    ]) {
      const send = await resolve(capture());
      assert.ok(
        (await f.authorize({ ...send, ...changed })).refused,
        "false, absent, conflicting, or nonempty selection",
      );
    }
    assert.equal(proxy.egress.authorizations, 1);
    // Final-gate installation replacement must not convert the old positive selection into a send.
    const replaced = await resolve(capture());
    const instance = f.observed.evidence.instance_id;
    f.observed.evidence.instance_id = "00000000-0000-4000-8000-000000000001";
    assert.ok((await f.authorize(replaced)).refused);
    f.observed.evidence.instance_id = instance;

    const forbidden = capture();
    assert.ok((await f.authorize(await resolve(forbidden))).allowed);
    f.setResponse({
      status: 200,
      body: repository,
      trailers: { "x-first": "first", "x-forbidden-last": "private" },
    });
    const actual = await f.send(forbidden, { credential_headers: [] });
    assert.deepEqual(actual.trailers.at(-1), { name: "x-forbidden-last", value: "private" });
    assert.deepEqual(await f.protect(forbidden, actual), { blocked: true });
    assert.equal(
      f.providerRequests.length,
      2,
      "origin executed; not even its response head released",
    );

    await assertLostDispatch(capture(), { noMaterial: true });
    assert.equal(
      proxy.egress.authorizations,
      3,
      "only approved read, forbidden trailer read, and uncertain dispatch",
    );

    const withdrawn = await resolve(capture());
    const route =
      "/namespaces/" +
      f.namespace.id +
      "/agents/" +
      f.agent.id +
      "/credential-sources/" +
      f.source.id +
      "/withdraw";
    assert.equal((await f.request("POST", route)).status, 202);
    assert.ok(
      (await f.authorize(withdrawn)).refused,
      "independent before-send policy observes last route withdrawal",
    );
    assert.ok(
      (await f.resolve(capture())).refused,
      "withdrawal also closes the before-access gate",
    );
    assert.equal(f.providerRequests.length, 2);
    assert.equal(
      f.secretReads,
      readsBeforeAdmission,
      "zero provider Secret reads, including refusal paths",
    );
    assert.equal(issuerAccess, 0, "zero issuer or prepared-material calls");
  },
);
