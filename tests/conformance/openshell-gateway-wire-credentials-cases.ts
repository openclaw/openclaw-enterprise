import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  createOpenShellBackend,
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
  type WireRequest,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

import { completeSandboxRevision } from "../integration/sandbox-driver-revision-fixture.ts";

export function registerCredentialsCases(): void {
  test("OpenShell client serializes v0.1.5 provider updates and detach receipts", async () => {
    const requests: {
      updates: WireRequest<"UpdateProvider">[];
      detaches: WireRequest<"DetachSandboxProvider">[];
      statuses: WireRequest<"GetSandboxProviderStatus">[];
    } = { updates: [], detaches: [], statuses: [] };
    const server = new grpc.Server();
    addWireService(server, {
      UpdateProvider(call, callback) {
        requests.updates.push(call.request);
        const provider = call.request.provider;
        const config = provider?.config;
        callback(null, {
          provider: {
            metadata: {
              name: provider?.metadata?.name,
              labels: { "app.kubernetes.io/managed-by": "openclaw-enterprise" },
              resource_version: "8",
            },
            type: config === undefined ? "oce-openai" : "oce-codex-runtime",
            ...(config === undefined ? {} : { config }),
          },
        });
      },
      DetachSandboxProvider(call, callback) {
        requests.detaches.push(call.request);
        callback(null, {
          detached: true,
          receipt: { receipt_id: "receipt-detach", kind: "PROVIDER_MUTATION_KIND_DETACH" },
        });
      },
      GetSandboxProviderStatus(call, callback) {
        requests.statuses.push(call.request);
        callback(null, {
          status: {
            receipt: { receipt_id: call.request.receipt_id },
            state: "PROVIDER_READINESS_STATE_REVOKED",
            reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
          },
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      auth: { mode: "unauthenticated" },
    });
    try {
      const updated = await client.updateProviderConfig(
        "tenant-workspace",
        "oce-runtime-0000000000000000",
        { node_setup_json: '{"bootstrapToken":"renewed"}' },
        "7",
        AbortSignal.timeout(2_000),
      );
      await client.updateProviderCredentials(
        "tenant-workspace",
        "oce-cs-000000000000000000000000",
        { OPENAI_API_KEY: "wire-rotated-value" },
        AbortSignal.timeout(2_000),
        { OPENAI_API_KEY: "2026-10-01T18:00:00Z" },
      );
      const detached = await client.detachSandboxProvider(
        "tenant-workspace",
        "sandbox-wire",
        "oce-cs-000000000000000000000000",
        AbortSignal.timeout(2_000),
        { expectedResourceVersion: "17", requestId: "expiry-detach-wire" },
      );
      assert.ok(detached);
      const status = await client.getSandboxProviderStatus(
        "tenant-workspace",
        "sandbox-wire",
        "oce-cs-000000000000000000000000",
        AbortSignal.timeout(2_000),
        detached.receiptId,
      );

      // Config reconciliation fences the exact provider version and merges only
      // the renewed setup field.
      const [configUpdate, credentialUpdate] = requests.updates;
      assert.equal(configUpdate?.workspace_scope?.workspace, "tenant-workspace");
      assert.equal(configUpdate?.provider?.metadata?.name, "oce-runtime-0000000000000000");
      assert.equal(configUpdate?.provider?.metadata?.resource_version, "7");
      assert.deepEqual(configUpdate?.provider?.config, {
        node_setup_json: '{"bootstrapToken":"renewed"}',
      });
      assert.ok(configUpdate?.request_id);
      assert.match(configUpdate.request_id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(updated, {
        name: "oce-runtime-0000000000000000",
        type: "oce-codex-runtime",
        labels: { "app.kubernetes.io/managed-by": "openclaw-enterprise" },
        config: { node_setup_json: '{"bootstrapToken":"renewed"}' },
        resourceVersion: "8",
      });
      // Credential rotation retains the existing merge-only request.
      assert.equal(credentialUpdate?.workspace_scope?.workspace, "tenant-workspace");
      assert.equal(credentialUpdate?.provider?.metadata?.name, "oce-cs-000000000000000000000000");
      assert.deepEqual(credentialUpdate?.provider?.credentials, {
        OPENAI_API_KEY: "wire-rotated-value",
      });
      assert.deepEqual(credentialUpdate?.credential_expiration_times, {
        OPENAI_API_KEY: { seconds: "1790877600", nanos: 0 },
      });
      assert.ok(credentialUpdate?.request_id);
      assert.match(credentialUpdate.request_id, /^[0-9a-f-]{36}$/);
      // Detach names the exact Sandbox and provider; status then follows the detach receipt.
      assert.equal(requests.detaches[0]?.workspace_scope?.workspace, "tenant-workspace");
      assert.equal(requests.detaches[0]?.sandbox, "sandbox-wire");
      assert.equal(requests.detaches[0]?.provider, "oce-cs-000000000000000000000000");
      assert.equal(requests.detaches[0]?.expected_resource_version, "17");
      assert.equal(requests.detaches[0]?.request_id, "expiry-detach-wire");
      assert.deepEqual(detached, { receiptId: "receipt-detach", detached: true });
      assert.equal(requests.statuses[0]?.receipt_id, "receipt-detach");
      assert.equal(status.state, "PROVIDER_READINESS_STATE_REVOKED");
      // An empty value would leave the old credential in place, so the client refuses it.
      await assert.rejects(
        client.updateProviderCredentials(
          "tenant-workspace",
          "oce-cs-000000000000000000000000",
          { OPENAI_API_KEY: "" },
          AbortSignal.timeout(2_000),
        ),
        /must be nonempty/,
      );
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("OpenShell gateway rechecks a revoked source through the Sandbox's provider list", async () => {
    const sourceId = "cs_recheck";
    const provider = openShellProviderName(sourceId);
    const namespace = {
      id: "ns_recheck",
      name: "tenant-workspace",
      status: "ready" as const,
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    const revision = completeSandboxRevision({
      id: "rev_recheck",
      namespaceId: namespace.id,
      agentId: "agt_recheck",
      sandboxDriverId: "sandbox-openshell",
      harness: { id: "codex", version: "default", mode: "embedded" },
    });
    const workspace = openShellWorkspaceName(namespace);
    // The provider names each Sandbox lists; a missing entry is a Sandbox that does not exist.
    const sandboxes = new Map([
      ["os-listed", ["operator-static", provider]],
      ["os-detached", ["operator-static"]],
      // An empty repeated field is not encoded, so the client sees no providers list at all.
      ["os-bare", []],
    ]);
    const calls: (
      [string, string | undefined] | [string, string | undefined, string | undefined]
    )[] = [];
    const server = new grpc.Server();
    addWireService(server, {
      GetSandbox(call, callback) {
        calls.push(["GetSandbox", call.request.name]);
        // Sandbox names are scoped to the Namespace's workspace: another workspace has none.
        const providers =
          call.request.workspace_scope?.workspace === workspace && call.request.name !== undefined
            ? sandboxes.get(call.request.name)
            : undefined;
        if (providers === undefined) {
          callback(Object.assign(new Error("not found"), { code: grpc.status.NOT_FOUND }));
          return;
        }
        callback(null, {
          sandbox: { metadata: { name: call.request.name }, spec: { providers } },
        });
      },
      DetachSandboxProvider(call, callback) {
        calls.push(["DetachSandboxProvider", call.request.sandbox, call.request.provider]);
        assert.ok(call.request.sandbox !== undefined);
        const providers = sandboxes.get(call.request.sandbox);
        assert.ok(providers);
        sandboxes.set(
          call.request.sandbox,
          providers.filter((name) => name !== call.request.provider),
        );
        callback(null, { detached: true, receipt: { receipt_id: "receipt-recheck" } });
      },
      GetSandboxProviderStatus(call, callback) {
        calls.push(["GetSandboxProviderStatus", call.request.sandbox, call.request.receipt_id]);
        callback(null, {
          status: {
            receipt: { receipt_id: call.request.receipt_id },
            state: "PROVIDER_READINESS_STATE_PENDING",
            reason: "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR",
          },
        });
      },
      // A missing Sandbox is absent only once the Workspace read passes (finding 1676).
      GetWorkspace(call, callback) {
        calls.push(["GetWorkspace", call.request.name]);
        callback(null, {
          workspace: {
            metadata: { name: call.request.name },
            status: { phase: "WORKSPACE_PHASE_ACTIVE" },
          },
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      auth: { mode: "unauthenticated" },
    });
    const gateway = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/local/bin/codex"] },
      {
        backend: createOpenShellBackend(
          {
            id: "wire-backend",
            type: "openshell",
            configuration: {
              endpoint: `http://127.0.0.1:${port}`,
              auth: { mode: "unauthenticated" },
            },
            drivers: {
              sandbox: "sandbox-openshell",
              credential_gateway: "credential-gateway-openshell",
            },
          },
          { gatewayClient: client },
        ),
      },
    );
    const recheck = (resourceName: string) =>
      gateway.withdraw({
        namespace,
        revision,
        sandbox: {
          resourceName,
          namespaceName: namespace.name,
          agentId: revision.agentId,
          revisionId: revision.id,
        },
        sourceId,
        signal: AbortSignal.timeout(2_000),
        recheck: true,
      });
    try {
      // A Sandbox that lists the provider again, as after a late create, is detached once more;
      // the fresh receipt is not yet confirmed.
      assert.deepEqual(await recheck("os-listed"), {
        sourceId,
        state: "pending",
        reason: "PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR",
      });
      assert.deepEqual(sandboxes.get("os-listed"), ["operator-static"]);
      // Once the Sandbox no longer lists it, or no longer exists, a recheck mutates nothing; a
      // missing Sandbox is absent only after GetWorkspace and a second GetSandbox (finding 1692).
      assert.deepEqual(await recheck("os-listed"), { sourceId, state: "revoked" });
      assert.deepEqual(await recheck("os-detached"), { sourceId, state: "revoked" });
      assert.deepEqual(await recheck("os-bare"), { sourceId, state: "revoked" });
      assert.deepEqual(await recheck("os-missing"), { sourceId, state: "absent" });
      assert.deepEqual(calls, [
        ["GetSandbox", "os-listed"],
        ["DetachSandboxProvider", "os-listed", provider],
        ["GetSandboxProviderStatus", "os-listed", "receipt-recheck"],
        ["GetSandbox", "os-listed"],
        ["GetSandbox", "os-detached"],
        ["GetSandbox", "os-bare"],
        ["GetSandbox", "os-missing"],
        ["GetWorkspace", workspace],
        ["GetSandbox", "os-missing"],
      ]);
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  test("OpenShell client serializes v0.1.5 gateway-owned refresh", async () => {
    const requests: {
      profiles: WireRequest<"ImportProviderProfiles">[];
      configures: WireRequest<"ConfigureProviderRefresh">[];
      rotations: WireRequest<"RotateProviderCredential">[];
      statuses: WireRequest<"GetProviderRefreshStatus">[];
      deletes: WireRequest<"DeleteProviderRefresh">[];
    } = { profiles: [], configures: [], rotations: [], statuses: [], deletes: [] };
    const minted = {
      provider: "oce-cs-000000000000000000000000",
      credential_key: "TOOLS_TOKEN",
      strategy: "PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_CLIENT_CREDENTIALS" as const,
      status: "refreshed",
      expiration_time: { seconds: "1790881200", nanos: 0 },
      next_refresh_time: { seconds: "1790880900", nanos: 0 },
      last_refresh_time: { seconds: "1790877600", nanos: 5 },
    };
    const server = new grpc.Server();
    // The upstream oracle decodes every request, so a renumbered refresh field fails here rather
    // than configuring a provider whose token endpoint or material OpenShell never sees.
    addWireService(server, {
      ImportProviderProfiles(call, callback) {
        requests.profiles.push(call.request);
        callback(null, {
          imported: true,
          profiles:
            call.request.profiles?.map(({ profile }) => {
              assert.ok(profile);
              return profile;
            }) ?? [],
        });
      },
      ConfigureProviderRefresh(call, callback) {
        requests.configures.push(call.request);
        callback(null, { status: { ...minted, status: "configured" } });
      },
      RotateProviderCredential(call, callback) {
        requests.rotations.push(call.request);
        callback(null, { status: minted });
      },
      GetProviderRefreshStatus(call, callback) {
        requests.statuses.push(call.request);
        if (call.request.provider !== minted.provider) {
          callback({ code: grpc.status.NOT_FOUND, details: "provider not found" });
          return;
        }
        callback(null, {
          credentials: [
            { ...minted, credential_key: "OTHER_TOKEN", status: "error" },
            {
              ...minted,
              status: "reauthorization_required",
              recovery_action: "PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_REAUTHORIZE",
              failure_code: "oauth_invalid_grant",
            },
          ],
        });
      },
      DeleteProviderRefresh(call, callback) {
        requests.deletes.push(call.request);
        callback(null, { outcome: "DELETION_OUTCOME_ALREADY_ABSENT" });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({
      endpoint: `http://127.0.0.1:${port}`,
      auth: { mode: "unauthenticated" },
    });
    const signal = () => AbortSignal.timeout(2_000);
    try {
      await client.importProviderProfile(
        "tenant-workspace",
        {
          id: minted.provider,
          displayName: "OAuth2 (wire)",
          category: "PROVIDER_PROFILE_CATEGORY_OTHER",
          credentials: [
            {
              name: "access_token",
              envVars: ["TOOLS_TOKEN"],
              required: true,
              authStyle: "bearer",
              headerName: "authorization",
              refresh: {
                strategy: minted.strategy,
                tokenUrl: "https://issuer.example.test/token",
                scopes: [],
                material: [
                  { name: "client_id", required: true, secret: false },
                  { name: "client_secret", required: true, secret: true },
                ],
              },
            },
          ],
          endpoints: [{ host: "tools.example.test", port: 443, protocol: "rest", path: "/**" }],
          binaries: ["/usr/bin/curl"],
          inferenceCapable: false,
          annotations: {},
        },
        signal(),
      );
      const configured = await client.configureProviderRefresh(
        {
          workspace: "tenant-workspace",
          provider: minted.provider,
          credentialKey: "TOOLS_TOKEN",
          strategy: minted.strategy,
          material: { client_id: "occ-tools", client_secret: "wire-client-secret" },
          requestId: "6b1f9b8e-2c4f-5a7d-9e3b-0c1d2e3f4a5b",
        },
        signal(),
      );
      const rotated = await client.rotateProviderCredential(
        "tenant-workspace",
        minted.provider,
        "TOOLS_TOKEN",
        "7c2a0c9f-3d5a-5b8e-af4c-1d2e3f4a5b6c",
        signal(),
      );
      const status = await client.getProviderRefreshStatus(
        "tenant-workspace",
        minted.provider,
        "TOOLS_TOKEN",
        signal(),
      );
      const missing = await client.getProviderRefreshStatus(
        "tenant-workspace",
        "oce-cs-missing",
        "TOOLS_TOKEN",
        signal(),
      );
      await client.deleteProviderRefresh(
        "tenant-workspace",
        minted.provider,
        "TOOLS_TOKEN",
        signal(),
      );

      // The token endpoint and material declarations travel only in the profile.
      const credential = requests.profiles[0]?.profiles?.[0]?.profile?.credentials?.[0];
      assert.deepEqual(credential?.refresh, {
        strategy: minted.strategy,
        token_url: "https://issuer.example.test/token",
        material: [
          { name: "client_id", required: true, secret: false },
          { name: "client_secret", required: true, secret: true },
        ],
      });
      const [configure] = requests.configures;
      assert.equal(configure?.workspace_scope?.workspace, "tenant-workspace");
      assert.equal(configure?.provider, minted.provider);
      assert.equal(configure?.credential_key, "TOOLS_TOKEN");
      assert.equal(configure?.strategy, minted.strategy);
      assert.deepEqual(configure?.material, {
        client_id: "occ-tools",
        client_secret: "wire-client-secret",
      });
      assert.equal(configure?.request_id, "6b1f9b8e-2c4f-5a7d-9e3b-0c1d2e3f4a5b");
      assert.deepEqual(configured, {
        status: "configured",
        expirationTime: "2026-10-01T19:00:00.000000000Z",
        nextRefreshTime: "2026-10-01T18:55:00.000000000Z",
        lastRefreshTime: "2026-10-01T18:00:00.000000005Z",
      });
      assert.equal(requests.rotations[0]?.credential_key, "TOOLS_TOKEN");
      assert.equal(requests.rotations[0]?.request_id, "7c2a0c9f-3d5a-5b8e-af4c-1d2e3f4a5b6c");
      assert.equal(rotated.status, "refreshed");
      // Status selects the exact credential key and keeps only the safe recovery fields.
      assert.deepEqual(status, {
        status: "reauthorization_required",
        expirationTime: "2026-10-01T19:00:00.000000000Z",
        nextRefreshTime: "2026-10-01T18:55:00.000000000Z",
        lastRefreshTime: "2026-10-01T18:00:00.000000005Z",
        recoveryAction: "PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_REAUTHORIZE",
        failureCode: "oauth_invalid_grant",
      });
      assert.equal(missing, undefined);
      assert.equal(requests.deletes[0]?.allow_missing, true);
      assert.equal(requests.deletes[0]?.credential_key, "TOOLS_TOKEN");
      const deleteRequest = requests.deletes[0];
      assert.ok(deleteRequest?.request_id);
      assert.match(deleteRequest.request_id, /^[0-9a-f-]{36}$/);
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });
}
