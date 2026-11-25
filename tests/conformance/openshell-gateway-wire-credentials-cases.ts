import assert from "node:assert/strict";
import test from "node:test";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
  type WireRequest,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

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
}
