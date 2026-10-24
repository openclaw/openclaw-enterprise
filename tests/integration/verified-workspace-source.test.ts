import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer, globalAgent, request as httpsRequest } from "node:https";
import { connect } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import { buffer } from "node:stream/consumers";
import { staticEgressFixture, requestId } from "../helpers/static-egress.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import { listen } from "../helpers/listen.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { createExternalProtectedDriver } from "../../apps/controller/src/composition/driver-packages.ts";
import { installEgressAuthority } from "../../apps/controller/src/composition/egress-authority.ts";
import { createCodexWorkspacePatProvider } from "../../apps/controller/src/drivers/egress-proxy/codex-workspace-provider.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { PostgresPlatformState, type PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import {
  egressAssociationInstallation,
  type CredentialProxyExchange,
  type EgressInstallation,
  type CapturedEgressUse,
  type AcceptedEgressAssociation,
  type EgressRequest,
  type CredentialSource,
  type EgressResponse,
} from "../../packages/contracts/src/index.ts";

// The external registration and identity verifier are production implementations. The
// installed sender and Kubernetes API are controlled TLS peers, not a native runtime proof.
for (const persistence of databaseUrl ? ["memory", "postgres"] : ["memory"]) {
  test(`verified workspace source fences real Secret versions through external composition (${persistence})`, async (t) => {
    const f = await staticEgressFixture(t, {
      admitRevision: false,
      ...(persistence === "postgres" ? { appFactory: postgresApp } : {}),
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: "workspace-owner",
          implementation: "external-workspace-owner",
          definition: OpenShellSandboxDriver,
        },
      ],
    });
    const directory = await temporaryDirectory(t, "verified-workspace-");
    const tls = await selfSigned(directory, {
      subjectAltName: "DNS:auth.openai.com,DNS:chatgpt.com",
    });
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    let mode = "normal";
    let identityCalls = 0;
    let deliveries = 0;
    const origin = createServer(tls, (req, res) => {
      const subject =
        req.headers.authorization === `Bearer ${tokenA}`
          ? workspaceA
          : req.headers.authorization === `Bearer ${tokenB}`
            ? workspaceB
            : undefined;
      assert.ok(subject, "the TLS peer authenticates the actual credential");
      if (req.headers.host === "chatgpt.com") {
        assert.equal(req.headers["chatgpt-account-id"], subject);
        deliveries++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ output: "synthetic reply" }));
        return;
      }
      assert.equal(req.headers.host, "auth.openai.com");
      assert.equal(req.url, "/api/accounts/v1/user-auth-credential/whoami");
      assert.equal(req.method, "GET");
      assert.equal(req.headers["chatgpt-account-id"], undefined);
      identityCalls++;
      res.setHeader("content-type", "application/json");
      if (mode === "redirect") {
        res.writeHead(302, { location: "https://chatgpt.com/forbidden" }).end();
      } else if (mode === "duplicate") {
        res.end(
          `{"chatgpt_account_id":"${subject}","chatgpt_account_id":"alternate","chatgpt_account_is_fedramp":false}`,
        );
      } else {
        res.end(
          JSON.stringify({
            chatgpt_account_id: subject,
            chatgpt_account_is_fedramp: mode === "fedramp",
            ignored: "synthetic-user@example.invalid",
          }),
        );
      }
    });
    const port = await listen(t, origin);
    const originalConnect = globalAgent.createConnection;
    let trustPeer = true;
    // Test-only network mapping: retain the fixed production URL, SNI, hostname
    // validation and certificate verification, but route the issuer to local TLS.
    t.mock.method(
      globalAgent,
      "createConnection",
      function (options: Record<string, unknown>, callback: unknown) {
        if (options.host !== "auth.openai.com" && options.host !== "chatgpt.com") {
          return originalConnect.call(globalAgent, options, callback as never);
        }
        return connect(
          {
            ...options,
            host: "127.0.0.1",
            port,
            servername: String(options.host),
            ca: trustPeer ? tls.cert : undefined,
          },
          callback as never,
        );
      },
    );
    const rotateSecret = async (value: string) => {
      const result = await f.request(
        "PATCH",
        `/namespaces/${f.namespace.id}/secrets/${f.secret.id}`,
        { body: { value } },
      );
      assert.equal(result.status, 200);
    };
    await rotateSecret(tokenA);
    let installed: EgressInstallation | undefined;
    let exchange: CredentialProxyExchange | undefined;
    const peerToken = randomUUID();
    let sandboxId = randomUUID();
    let instanceId = randomUUID();
    const associations = new Map<string, AcceptedEgressAssociation>();
    const peerExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const transport = {
      async verify(token: string) {
        return token === peerToken
          ? {
              sender: f.egress.sourceControl.sender,
              sandboxId,
              instanceId,
              exchangeId: "synthetic-exchange",
              expiresAt: peerExpiresAt,
            }
          : undefined;
      },
      capture(use: CapturedEgressUse) {
        const value = {
          execution: use.route.binding.execution,
          installation: egressAssociationInstallation(use.installation),
          exchangeId: "synthetic-exchange",
          responseId: randomUUID(),
          custodyId: randomUUID(),
        };
        associations.set(use.id, value);
        return value;
      },
      owns(value: AcceptedEgressAssociation, use: CapturedEgressUse) {
        return isDeepStrictEqual(value, associations.get(use.id));
      },
    };
    const provider = createCodexWorkspacePatProvider({
      workspaceForSource() {
        throw new Error(
          "A registration callback must never supply production workspace authority.",
        );
      },
    });
    const sandbox = Object.create(f.sandboxDriver, {
      id: { value: "workspace-owner" },
      implementation: { value: "external-workspace-owner" },
    });
    const proxy = Object.create(f.egress, {
      id: { value: "workspace-owner" },
      implementation: { value: "external-workspace-owner" },
      sourceControl: { value: { ...f.egress.sourceControl, providers: [provider] } },
      verifyInstallation: {
        value: async (_: unknown, value: EgressInstallation) => isDeepStrictEqual(installed, value),
      },
      bindExchange: {
        value: async (create: (owner: typeof transport) => CredentialProxyExchange) => {
          exchange = create(transport);
          return {
            close() {
              associations.clear();
            },
          };
        },
      },
    });
    const owner = createExternalProtectedDriver(
      {
        configurationSchema: { type: "object" },
        validateConfiguration: () => [],
        createDriver: () => ({ capabilities: { sandbox, credential_proxy: proxy } }),
      },
      {
        id: sandbox.id,
        implementation: sandbox.implementation,
        configuration: {},
        definition: OpenShellSandboxDriver,
      },
    );
    f.controller.registerDriver(owner);
    f.controller.selectDriver("sandbox", owner.require("sandbox").id);
    f.controller.selectDriver("credential_proxy", owner.require("credential_proxy").id);
    const selected = owner.require("credential_proxy").sourceControl.providers[0]!;
    assert.ok(
      !f.egress.sourceControl.providers.some((entry) => entry.ref.id === provider.ref.id),
      "external opt-in does not advertise the profile on the stock sender",
    );
    const create = (name: string, extra = {}) =>
      f.request("POST", `/namespaces/${f.namespace.id}/credential-sources`, {
        body: { name, type: "codex-pat", secrets: { access_token: f.secret.ref }, ...extra },
      });
    for (const invalid of ["redirect", "duplicate", "fedramp"]) {
      mode = invalid;
      assert.notEqual((await create("workspace-pat")).status, 201);
    }
    mode = "normal";
    // A TLS failure must not admit a source, even when its application reply is valid.
    globalAgent.destroy();
    trustPeer = false;
    assert.notEqual((await create("workspace-pat")).status, 201);
    trustPeer = true;
    const before = identityCalls;
    assert.notEqual(
      (await create("workspace-pat", { config: { url: "https://chatgpt.com" } })).status,
      201,
    );
    assert.equal(identityCalls, before);
    assert.equal(deliveries, 0, "no redirect was followed");
    const created = await create("workspace-pat");
    assert.equal(created.status, 201);
    const readSource = (id: string) =>
      f.controller.transact((unit: PlatformUnitOfWork) =>
        unit.credentialSources.findCredentialSource(f.namespace.id, id),
      );
    const source = (await readSource(created.data.id))!;
    assert.equal(source.egress?.adoption, "live");
    if (source.egress?.adoption !== "live") {
      return;
    }
    const proof = source.egress.verifiedIdentity!;
    assert.equal(proof.subject, workspaceA);
    assert.equal(proof.origin, "https://chatgpt.com");
    assert.deepEqual(proof.source, source.egress.key);
    const grant = selected.normalizeGrant(["fixture-model"], {}, source);
    assert.equal(grant.kind, "workspace_inference");
    const serialized = JSON.stringify(source);
    assert.ok(!serialized.includes(tokenA) && !serialized.includes(tokenB));
    assert.ok(!serialized.includes("synthetic-user@example.invalid"));
    const withoutProof = structuredClone(source);
    if (withoutProof.egress?.adoption === "live") {
      delete (withoutProof.egress as { verifiedIdentity?: unknown }).verifiedIdentity;
    }
    assert.throws(() => selected.normalizeGrant(["fixture-model"], {}, withoutProof), {
      message: /exact-source workspace binding/,
    });
    for (const altered of [
      { ...source, namespaceId: "different-namespace" },
      {
        ...source,
        egress: {
          ...source.egress,
          key: { ...source.egress.key, installationId: "different-installation" },
        },
      },
      {
        ...source,
        egress: { ...source.egress, secret: { ...source.egress.secret, id: "different-secret" } },
      },
    ]) {
      assert.throws(() => selected.normalizeGrant(["fixture-model"], {}, altered), {
        message: /exact-source workspace binding/,
      });
    }
    const useSource = async (chosen: CredentialSource) => {
      const result = await f.request(
        "PATCH",
        `/namespaces/${f.namespace.id}/agents/${f.agent.id}`,
        {
          body: {
            configurationId: f.agent.configurationId,
            harnessAuth: { method: "credential_source", sourceId: chosen.id },
            credentialSources: [{ sourceId: chosen.id }],
          },
        },
      );
      assert.equal(result.status, 200);
      return result.data;
    };
    const agent = await useSource(source);
    const role = await f.request("POST", `/namespaces/${f.namespace.id}/iam/roles`, {
      body: {
        name: "workspace-use",
        permissions: [{ action: "operate", resourceKind: "credential_source" }],
      },
    });
    assert.equal(role.status, 201);
    const grantAccess = async (id: string) => {
      const access = await f.request("POST", `/namespaces/${f.namespace.id}/iam/access-bindings`, {
        body: {
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: role.data.id,
          resourceKind: "credential_source",
          resourceId: id,
        },
      });
      assert.equal(access.status, 201);
    };
    await grantAccess(source.id);
    const deploy = async () => {
      sandboxId = randomUUID();
      instanceId = randomUUID();
      const deployed = await f.deployAgent(f.namespace.id, agent.id);
      const revision = await f.controller.transact((unit: PlatformUnitOfWork) =>
        unit.revisions.findRevision(f.namespace.id, agent.id, deployed.id),
      );
      assert.ok(revision?.egressPlan);
      installed = {
        plan: revision.egressPlan,
        sandboxId,
        sender: proxy.sourceControl.sender,
        installedAt: new Date().toISOString(),
        enforcement: {
          instanceId,
          configurationId: randomUUID(),
          policyHash: "ab".repeat(32),
          authorityScope: "execution",
        },
      };
      await f.controller.transact((unit: PlatformUnitOfWork) =>
        unit.credentialSources.recordEgressInstallation(installed!),
      );
    };
    await deploy();
    const binding = await installEgressAuthority(f.controller, owner);
    t.after(() => binding?.close());
    assert.ok(exchange);
    const signal = AbortSignal.timeout(30_000);
    const request = (workspace: string): EgressRequest => ({
      id: requestId(),
      method: "POST",
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: [
        ["content-type", "application/json"],
        ["chatgpt-account-id", workspace],
      ],
      body: Buffer.from(
        JSON.stringify({ model: "fixture-model", input: "synthetic input", store: false }),
      ),
      deadlineAt: new Date(Date.now() + 20_000).toISOString(),
      verifiedExecutionPolicyHash: installed!.enforcement.policyHash,
    });
    const resolve = (req: EgressRequest) => exchange!.resolve(peerToken, sandboxId, req, signal);
    const send = async (req: EgressRequest) => {
      const resolved = await resolve(req);
      assert.equal(resolved.kind, "ready");
      if (resolved.kind !== "ready") {
        throw new Error("No credential release");
      }
      const allowed = await exchange!.authorizeSend(
        peerToken,
        sandboxId,
        req.id,
        resolved.handle,
        resolved.evidence,
        resolved.injectionDigest,
        req.deadlineAt,
        signal,
      );
      assert.equal(
        allowed.kind,
        "allow",
        allowed.kind === "refused" ? JSON.stringify(allowed) : "credential send permission",
      );
      const response = await new Promise<EgressResponse>((accept, reject) => {
        const outgoing = httpsRequest(
          req.url,
          {
            method: req.method,
            rejectUnauthorized: true,
            headers: Object.fromEntries([...req.headers, ...resolved.headers]),
          },
          async (incoming) =>
            accept({
              status: incoming.statusCode!,
              headers: [["content-type", "application/json"]],
              body: await buffer(incoming),
              trailers: [],
            }),
        );
        outgoing.on("error", reject);
        outgoing.end(req.body);
      });
      await exchange!.beginResponse(peerToken, sandboxId, req.id);
      await exchange!.protectResponse(resolved.handle, response, signal);
      return resolved.evidence;
    };
    assert.equal((await resolve(request(workspaceB))).kind, "refused");
    const callsBeforeRelease = identityCalls;
    const evidenceA = await send(request(workspaceA));
    assert.equal(deliveries, 1);
    assert.equal(
      identityCalls,
      callsBeforeRelease,
      "release does not re-export material to the identity endpoint",
    );
    if ("pool" in f) {
      await f.pool.query(
        "UPDATE occ.credential_sources SET egress = egress - 'verifiedIdentity' WHERE id=$1",
        [source.id],
      );
      assert.equal(
        (await resolve(request(workspaceA))).kind,
        "refused",
        "lost durable proof closes release",
      );
      await f.pool.query("UPDATE occ.credential_sources SET egress = $2::jsonb WHERE id=$1", [
        source.id,
        source.egress,
      ]);
    }
    const heldRequest = request(workspaceA);
    const held = await resolve(heldRequest);
    assert.equal(held.kind, "ready");
    await rotateSecret(tokenB);
    assert.equal((await readSource(source.id))!.name, "workspace-pat");
    assert.deepEqual(
      (await readSource(source.id))!.egress,
      source.egress,
      "rotation does not replace the old grant or its proof",
    );
    if (held.kind === "ready") {
      assert.equal(
        (
          await exchange.authorizeSend(
            peerToken,
            sandboxId,
            heldRequest.id,
            held.handle,
            held.evidence,
            held.injectionDigest,
            heldRequest.deadlineAt,
            signal,
          )
        ).kind,
        "refused",
      );
    }
    assert.equal((await resolve(request(workspaceA))).kind, "refused");
    assert.equal((await resolve(request(workspaceB))).kind, "refused");
    assert.equal(deliveries, 1, "B cannot deliver under A's unchanged source grant");
    assert.equal(
      (await f.request("POST", `/namespaces/${f.namespace.id}/agents/${agent.id}/deploy`)).status,
      503,
    );
    const newProofCalls = identityCalls;
    const replacement = await create("workspace-pat-new-proof");
    assert.equal(replacement.status, 201);
    assert.equal(identityCalls, newProofCalls + 1);
    const readmitted = await f.request(
      "PATCH",
      `/namespaces/${f.namespace.id}/credential-sources/${replacement.data.id}`,
      {
        body: { secrets: { access_token: f.secret.ref } },
      },
    );
    assert.equal(readmitted.status, 200);
    assert.equal(
      identityCalls,
      newProofCalls + 2,
      "unbound source update repeats issuer verification through its actual Proxy owner",
    );
    const sourceB = (await readSource(replacement.data.id))!;
    assert.equal(sourceB.egress?.adoption, "live");
    if (sourceB.egress?.adoption !== "live") {
      return;
    }
    assert.equal(sourceB.egress.verifiedIdentity!.subject, workspaceB);
    assert.notEqual(sourceB.egress.verifiedIdentity!.materialVersion, proof.materialVersion);
    assert.equal(sourceB.egress.verifiedIdentity!.materialId, proof.materialId);
    await useSource(sourceB);
    await grantAccess(sourceB.id);
    await deploy();
    assert.equal((await resolve(request(workspaceA))).kind, "refused");
    const evidenceB = await send(request(workspaceB));
    assert.notDeepEqual(evidenceB, evidenceA);
    assert.equal(deliveries, 2);
    const audit = await f.controller.transact((unit: PlatformUnitOfWork) => unit.audit.list());
    assert.ok(!JSON.stringify(audit).includes(tokenA) && !JSON.stringify(audit).includes(tokenB));
    if ("pool" in f) {
      const restored = await new PostgresPlatformState(f.pool).read((view) =>
        view.credentialSources.findCredentialSource(f.namespace.id, sourceB.id),
      );
      assert.deepEqual(restored, sourceB);
      for (const invalid of [
        {
          ...sourceB.egress,
          verifiedIdentity: { ...sourceB.egress.verifiedIdentity, bearer: tokenB },
        },
        {
          ...sourceB.egress,
          verifiedIdentity: { ...sourceB.egress.verifiedIdentity, source: source.egress.key },
        },
      ]) {
        const result: { rows: { valid: boolean }[] } = await f.pool.query(
          "SELECT occ.static_egress_source_is_valid($1::jsonb,$2,$3) AS valid",
          [invalid, f.namespace.id, sourceB.id],
        );
        assert.equal(result.rows[0]?.valid, false);
      }
      const rows = await f.pool.query(
        "SELECT to_jsonb(s)::text AS value FROM occ.credential_sources s WHERE namespace_id=$1",
        [f.namespace.id],
      );
      assert.ok(
        rows.rows.every(
          (row: { value: string }) => !row.value.includes(tokenA) && !row.value.includes(tokenB),
        ),
      );
    }
  });
}
