import type { TestContext } from "node:test";
import type { OpenShellPreparedGitScope } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellPreparedGitProvider } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { temporaryDirectory } from "./temporary-directory.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");
interface WireProfile extends Record<string, unknown> {
  endpoints: { host: string }[];
}
interface WireProvider extends Record<string, unknown> {
  credentials: Record<string, string>;
  metadata: { resource_version: string; [key: string]: unknown };
}
interface WireRequest {
  workspace_scope: { workspace: string };
  sandbox: string;
  receipt_id?: string;
  name: string;
  profiles: { profile: WireProfile }[];
  request_id: string;
  provider: WireProvider;
  credential_expiration_times: Record<string, unknown>;
}
type Reply = (error: { code: number; details?: string } | null, response?: object) => void;
type Handler = (call: { request: WireRequest }, callback: Reply) => void;

export async function preparedGitWire(t: TestContext, scope: OpenShellPreparedGitScope) {
  const directory = await temporaryDirectory(t, "prepared-git-wire-");
  // Independent pinned v0.1.5 oracle, extended with fields from upstream
  // openshell.proto at bdb956f2cd65a635f1294fccf1d138d263bf650f; never load the client schema.
  let proto = await readFile(
    new URL("../fixtures/openshell-v0.1.5-wire.proto", import.meta.url),
    "utf8",
  );
  proto = proto.replace(
    "service OpenShell {",
    `service OpenShell {
    rpc GetProvider(GetProviderRequest) returns (ProviderResponse);
    rpc GetProviderProfile(GetProviderProfileRequest) returns (ProviderProfileResponse);`,
  );
  proto = proto.replace(
    "  string path_template = 9;",
    "  string path_template = 9;\n  bool stable_placeholder = 12;",
  );
  // The shared wire fixture omits the installed-identity fields exercised here.
  proto = proto.replace(
    "message ProviderMutationReceipt {",
    "message ProviderMutationReceipt {\n  ProviderDesiredIdentity desired = 6;",
  );
  proto = proto.replace(
    "message ProviderReadinessStatus {",
    `message ProviderReadinessStatus {
  ProviderReadinessObservation observed = 4;
  google.protobuf.Timestamp observed_time = 106;
  google.protobuf.Timestamp evaluated_time = 107;`,
  );
  // The remaining readiness reasons from the same pinned upstream source.
  proto = proto.replace(
    "  PROVIDER_READINESS_REASON_CREDENTIALS_WITHHELD = 6;\n",
    `  PROVIDER_READINESS_REASON_CREDENTIALS_WITHHELD = 6;
  PROVIDER_READINESS_REASON_CREDENTIAL_INSTALL_FAILED = 7;
  PROVIDER_READINESS_REASON_POLICY_ACTIVATION_FAILED = 8;
  PROVIDER_READINESS_REASON_PROCESS_INSTALL_FAILED = 9;
  PROVIDER_READINESS_REASON_SUPERVISOR_DISCONNECTED = 10;
  PROVIDER_READINESS_REASON_SUPERVISOR_LEASE_EXPIRED = 11;
  PROVIDER_READINESS_REASON_DESIRED_STATE_CHANGED = 12;
  PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED = 13;
  PROVIDER_READINESS_REASON_LOCAL_POLICY = 14;
  PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH = 15;
`,
  );
  proto += `
    message GetProviderRequest { string name = 1; WorkspaceSelector workspace_scope = 2; }
    message GetProviderProfileRequest { string id = 1; WorkspaceSelector workspace_scope = 2; }
    message ProviderProfileResponse { ProviderProfile profile = 1; }
    message ProviderDesiredIdentity {
      string sandbox_id = 1;
      string sandbox = 2;
      string attachment_epoch = 3;
      string provider_id = 4;
      uint64 provider_resource_version = 5;
      uint64 provider_env_revision = 6;
      uint64 config_revision = 7;
      string policy_hash = 8;
    }
    message ProviderReadinessObservation {
      string session_id = 1;
      uint64 sequence = 2;
      string attachment_epoch = 3;
      uint64 provider_env_revision = 4;
      uint64 config_revision = 5;
      string policy_hash = 6;
      bool credentials_installed = 7;
      bool policy_active = 8;
      bool launch_environment_installed = 9;
      string process_instance_id = 10;
      ProviderReadinessReason reason = 11;
    }
  `;
  const path = join(directory, "wire.proto");
  await writeFile(path, proto);
  const definition = await loader.load(path, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const OpenShell = grpc.loadPackageDefinition(definition).openshell.v1.OpenShell;
  const state: {
    requests: WireRequest[];
    profile?: WireProfile;
    provider?: WireProvider;
    conflict: boolean;
    lost: boolean;
    denyReads?: boolean;
    workspaceId: string;
    workspaceReads: number;
    status?: Record<string, unknown>;
    onRequest?: (request: WireRequest) => void;
    writeDelayMs: number;
  } = {
    requests: [],
    conflict: false,
    lost: false,
    workspaceId: scope.workspaceId,
    workspaceReads: 0,
    // Runs as each recorded request arrives, before the server answers it.
    // Holds the provider write's answer this long (a slow but healthy gateway).
    writeDelayMs: 0,
  };
  const server = new grpc.Server();
  const record = (call: { request: WireRequest }) => {
    state.requests.push(call.request);
    assert.equal(call.request.workspace_scope.workspace, scope.workspace);
    state.onRequest?.(call.request);
  };
  const answerWrite = (callback: Reply, ...answer: Parameters<Reply>) =>
    state.writeDelayMs
      ? setTimeout(() => callback(...answer), state.writeDelayMs)
      : callback(...answer);
  const handlers: Record<string, Handler> = {
    GetSandboxProviderStatus(call, callback) {
      record(call);
      assert.equal(call.request.sandbox, scope.sandbox);
      assert.equal(call.request.receipt_id, undefined);
      callback(null, { status: state.status ?? { state: "PROVIDER_READINESS_STATE_PENDING" } });
    },
    GetWorkspace(call, callback) {
      state.workspaceReads += 1;
      assert.equal(call.request.name, scope.workspace);
      callback(null, { workspace: { metadata: { name: scope.workspace, id: state.workspaceId } } });
    },
    GetProviderProfile(call, callback) {
      record(call);
      if (state.denyReads) {
        callback({ code: grpc.status.PERMISSION_DENIED, details: "workspace" });
        return;
      }
      if (!state.profile) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, { profile: state.profile });
    },
    ImportProviderProfiles(call, callback) {
      record(call);
      assert.equal(call.request.profiles.length, 1);
      assert.match(call.request.request_id, /^[a-f0-9-]{36}$/);
      const [entry] = call.request.profiles;
      assert.ok(entry);
      state.profile = { ...entry.profile, resource_version: "1" };
      callback(null, { imported: true, profiles: [state.profile] });
    },
    GetProvider(call, callback) {
      record(call);
      if (!state.provider) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, { provider: state.provider });
    },
    CreateProvider(call, callback) {
      record(call);
      state.provider = {
        ...call.request.provider,
        metadata: {
          ...call.request.provider.metadata,
          id: "provider-id",
          workspace: scope.workspace,
          resource_version: "1",
        },
      };
      answerWrite(callback, null, { provider: state.provider });
    },
    UpdateProvider(call, callback) {
      record(call);
      assert.ok(state.provider);
      // The independent server enforces the released resource-version precondition.
      if (
        state.conflict ||
        call.request.provider.metadata.resource_version !== state.provider.metadata.resource_version
      ) {
        callback({ code: grpc.status.ABORTED, details: "concurrent writer" });
        return;
      }
      state.provider = {
        ...state.provider,
        credentials: call.request.provider.credentials,
        credential_expiration_times: call.request.credential_expiration_times,
        metadata: { ...state.provider.metadata, resource_version: "2" },
      };
      if (state.lost) {
        callback({
          code: grpc.status.UNAVAILABLE,
          details: state.provider.credentials.GITHUB_TOKEN ?? "",
        });
        return;
      }
      answerWrite(callback, null, { provider: state.provider });
    },
  };
  server.addService(OpenShell.service, handlers);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error: Error | null, port: number) => (error ? reject(error) : resolve(port)),
    ),
  );
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  t.after(() => {
    client.close();
    server.forceShutdown();
  });
  return { state, binding: new OpenShellPreparedGitProvider(client, scope), client };
}
