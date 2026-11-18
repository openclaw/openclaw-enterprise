import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addWireService,
  bindWireServer,
  grpc,
  shutdownWireServer,
  type WireRequest,
} from "./openshell-gateway-wire-fixture.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { loader } from "../helpers/openshell-grpc-sdk.ts";

export function registerPolicyCases(): void {
  test("OpenShell decodes the optional applied public TCP report at field 8", () => {
    const definitions = loader.loadSync(
      fileURLToPath(
        new URL(
          "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
          import.meta.url,
        ),
      ),
      { keepCase: true, defaults: false, oneofs: true },
    );
    const admission = definitions["openshell.v1.SandboxConfigurationAdmission"];
    assert.ok(
      admission &&
        "format" in admission &&
        admission.format === "Protocol Buffer 3 DescriptorProto",
    );
    // Field 8 is a varint. Older senders omit it, while false and true are explicit.
    for (const { bytes, expected } of [
      { bytes: [], expected: undefined },
      { bytes: [0x40, 0], expected: false },
      { bytes: [0x40, 1], expected: true },
    ]) {
      const decoded = asRecord(admission.deserialize(Buffer.from(bytes)));
      assert.ok(decoded);
      assert.equal(decoded.applied_allow_unconfigured_public_tcp, expected);
    }
  });

  test("OpenShell policy updates preserve static and L7 constraints and carry fixed scoped CAS receipts", async (t) => {
    // These restrictions must survive decode/re-encode when a network grant is added.
    const policy = {
      version: 1,
      filesystem: { read_only: ["/usr"], read_write: ["/tmp"] },
      process: { run_as_user: "1000", run_as_group: "1000" },
      network_policies: {
        api: {
          name: "api",
          binaries: [{ path: "/usr/bin/python3.11" }],
          endpoints: [
            {
              host: "example.org",
              ports: [443],
              protocol: "rest",
              tls: "NETWORK_TLS_MODE_SKIP",
              enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
              rules: [{ allow: { method: "GET", path: "/status" } }],
              allowed_ips: ["93.184.216.0/24"],
            },
          ],
        },
      },
    };
    const calls: (
      | ["status", WireRequest<"GetSandboxPolicyStatus">]
      | ["update", WireRequest<"UpdateConfig">]
      | ["draft", WireRequest<"GetDraftPolicy">]
    )[] = [];
    const server = new grpc.Server();
    addWireService(server, {
      GetSandbox(call, callback) {
        callback(null, {
          sandbox: {
            metadata: {
              name: call.request.name,
              workspace: call.request.workspace_scope?.workspace,
              resource_version: "9007199254740993",
            },
            spec: { policy },
          },
        });
      },
      GetSandboxPolicyStatus(call, callback) {
        calls.push(["status", call.request]);
        callback(null, {
          revision: { version: 7, status: "POLICY_STATUS_LOADED", policy },
          active_version: 7,
        });
      },
      UpdateConfig(call, callback) {
        calls.push(["update", call.request]);
        callback(null, { version: 8 });
      },
      GetDraftPolicy(call, callback) {
        calls.push(["draft", call.request]);
        callback(null, {
          draft_version: "19",
          chunks: [
            {
              id: "draft-1",
              status: "pending",
              hit_count: 6,
              proposed_rule: policy.network_policies.api,
            },
          ],
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    t.after(async () => {
      client.close();
      await shutdownWireServer(server);
    });
    const target = { workspace: "exact-workspace", sandbox: "exact-sandbox" };
    const observed = await client.getSandbox(
      { name: target.sandbox, workspace: target.workspace },
      AbortSignal.timeout(2000),
    );
    assert.ok(observed);
    assert.equal(
      observed.resourceVersion,
      "9007199254740993",
      "sandbox CAS survives without JavaScript numeric rounding",
    );
    const status = await client.getPolicyStatus(target, AbortSignal.timeout(2000));
    assert.equal(status.activeVersion, 7);
    assert.equal(status.state, "POLICY_STATUS_LOADED");
    const model = asRecord(asRecord(status.policy.network_policies)?.api);
    const endpoints: unknown = model?.endpoints;
    assert.ok(Array.isArray(endpoints));
    const statusEndpoint = asRecord((endpoints as readonly unknown[])[0]);
    const [expectedEndpoint] = policy.network_policies.api.endpoints;
    assert.ok(statusEndpoint && expectedEndpoint);
    assert.deepEqual(statusEndpoint.rules, expectedEndpoint.rules);
    assert.deepEqual(statusEndpoint.allowed_ips, ["93.184.216.0/24"]);
    const update = {
      ...target,
      policy: status.policy,
      expectedResourceVersion: "9007199254740993",
      requestId: "79962864-9cdc-4b12-9561-218b42d004b2",
    };
    await client.updatePolicy(update, AbortSignal.timeout(2000));
    await client.updatePolicy(update, AbortSignal.timeout(2000));
    const [, firstUpdate, secondUpdate] = calls;
    assert.ok(firstUpdate?.[0] === "update" && secondUpdate?.[0] === "update");
    assert.deepEqual(
      firstUpdate[1],
      secondUpdate[1],
      "a retry must keep the original CAS version and idempotency UUID",
    );
    assert.equal(firstUpdate[1].expected_resource_version, update.expectedResourceVersion);
    assert.equal(firstUpdate[1].request_id, update.requestId);
    assert.deepEqual(firstUpdate[1].policy, status.policy);
    const drafts = await client.getPolicyDrafts(target, AbortSignal.timeout(2000));
    assert.equal(drafts.version, "19");
    const [chunk] = drafts.chunks;
    assert.ok(chunk);
    assert.equal(chunk.hit_count, 6);
    const draftEndpoints: unknown = asRecord(chunk.proposed_rule)?.endpoints;
    assert.ok(Array.isArray(draftEndpoints));
    const draftEndpoint = asRecord((draftEndpoints as readonly unknown[])[0]);
    assert.ok(draftEndpoint);
    assert.deepEqual(draftEndpoint.rules, expectedEndpoint.rules);
    for (const [, request] of calls) {
      assert.equal(request.sandbox, target.sandbox);
      assert.equal(request.workspace_scope?.workspace, target.workspace);
      assert.equal(
        asRecord(request)?.global,
        undefined,
        "Agent operations never select global policy",
      );
    }
    await assert.rejects(
      client.updatePolicy({ ...update, expectedResourceVersion: "0" }, AbortSignal.timeout(2000)),
      /nonzero/,
    );
    assert.equal(calls.length, 4, "unsafe CAS is refused before provider dispatch");
  });
}
