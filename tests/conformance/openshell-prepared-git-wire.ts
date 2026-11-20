import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import {
  OpenShellPreparedGitProvider,
  type OpenShellPreparedGitBinding,
  type OpenShellPreparedGitScope,
  type OpenShellPreparedGitToken,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

export const scope = {
  workspace: "git-dogfood",
  workspaceId: "workspace-id",
  sandbox: "git-execution",
  executionId: "execution-one",
  repository: "example/project",
  gitOrigin: "https://github.com",
  apiOrigin: "https://api.github.com",
  binaries: ["/usr/bin/git", "/usr/bin/gh"],
} satisfies OpenShellPreparedGitScope;
export const token = (suffix = "first"): OpenShellPreparedGitToken => ({
  value: `synthetic-installation-token_${suffix}`,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});

export const signal = (): AbortSignal => AbortSignal.timeout(5_000);

async function loadWireService(t: TestContext): Promise<Grpc.ServiceDefinition> {
  const directory = await temporaryDirectory(t, "prepared-git-wire-");
  // Independent pinned v0.1.5 oracle, extended with fields from upstream
  // openshell.proto at bdb956f2cd65a635f1294fccf1d138d263bf650f; never load the client schema.
  let proto = await readFile(
    new URL("../fixtures/openshell-v0.1.5-wire.proto", import.meta.url),
    "utf8",
  );
  proto = proto.replace(
    "  PROVIDER_MUTATION_KIND_UPDATE = 3;",
    "  PROVIDER_MUTATION_KIND_UPDATE = 3;\n  PROVIDER_MUTATION_KIND_OBSERVE = 4;",
  );
  // The shared wire fixture omits the installed-identity fields exercised here.
  proto = proto.replace(
    "message ProviderMutationReceipt {",
    "message ProviderMutationReceipt {\n  ProviderDesiredIdentity desired = 6;",
  );
  proto = proto.replace(
    "message SandboxStatus {",
    `message SandboxStatus {
  string main_process_instance_id = 8;
  SandboxConfigurationAdmission configuration_admission = 11;
  optional bool configuration_activated = 12;`,
  );
  proto = proto.replace(
    "message ProviderReadinessStatus {",
    `message ProviderReadinessStatus {
  ConfigUpdateOperation operation = 8;
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
    message SandboxConfigurationAdmission {
      string instance_id = 1;
      int32 state = 2;
      uint32 policy_version = 3;
      string policy_hash = 4;
      uint64 config_revision = 5;
      uint64 provider_env_revision = 6;
    }
    message ConfigUpdateOperation {
      string operation_id = 1;
      int32 state = 5;
      int32 outcome = 6;
      google.protobuf.Timestamp completed_time = 110;
    }
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
  return openShellService(grpc.loadPackageDefinition(definition));
}

export function installedStatus(binding: OpenShellPreparedGitBinding): WireInstalledStatus {
  const now = { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 };
  return {
    state: "PROVIDER_READINESS_STATE_READY",
    reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
    receipt: {
      receipt_id: "current-observation",
      kind: "PROVIDER_MUTATION_KIND_OBSERVE",
      workspace: scope.workspace,
      provider: binding.provider,
      desired: {
        sandbox_id: "sandbox-id",
        sandbox: scope.sandbox,
        attachment_epoch: "attachment-one",
        provider_id: binding.providerId,
        provider_resource_version: binding.resourceVersion,
        provider_env_revision: "101",
        config_revision: "202",
        policy_hash: "policy-hash",
      },
    },
    observed: {
      session_id: "supervisor-session",
      sequence: "1",
      attachment_epoch: "attachment-one",
      provider_env_revision: "101",
      config_revision: "202",
      policy_hash: "policy-hash",
      credentials_installed: true,
      policy_active: true,
      launch_environment_installed: true,
      process_instance_id: "process-instance",
      reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
    },
    network_instance_id: "network-instance",
    observed_time: now,
    evaluated_time: now,
  };
}

const workspaceScope = {
  workspace_scope: Type.Object({ workspace: Type.String() }),
};
const timestamp = Type.Object({
  seconds: Type.String(),
  nanos: Type.Optional(Type.Integer()),
});
const credentials = Type.Record(Type.String(), Type.String());
const expirations = Type.Record(Type.String(), timestamp);
const resourceVersion = Type.Optional(Type.String());
const providerName = Type.String();
const requestSchemas = {
  GetWorkspace: Type.Object({ name: Type.String() }),
  GetSandbox: Type.Object({ ...workspaceScope, name: Type.String() }),
  GetSandboxProviderStatus: Type.Object({
    ...workspaceScope,
    sandbox: Type.String(),
    receipt_id: Type.Optional(Type.String()),
  }),
  GetProviderProfile: Type.Object({ ...workspaceScope, id: Type.String() }),
  ImportProviderProfiles: Type.Object({
    ...workspaceScope,
    request_id: Type.String(),
    profiles: Type.Array(
      Type.Object({
        profile: Type.Object({
          resource_version: Type.Optional(Type.String()),
          credentials: Type.Array(
            Type.Object({
              name: Type.String(),
              env_vars: Type.Array(Type.String()),
              required: Type.Boolean(),
              auth_style: Type.String(),
              header_name: Type.String(),
              stable_placeholder: Type.Boolean(),
            }),
          ),
          endpoints: Type.Array(
            Type.Object({
              host: Type.String(),
              port: Type.Integer(),
              path: Type.String(),
              tls: Type.Optional(Type.String()),
            }),
          ),
        }),
      }),
    ),
  }),
  GetProvider: Type.Object({ ...workspaceScope, name: Type.String() }),
  CreateProvider: Type.Object({
    ...workspaceScope,
    provider: Type.Object({
      metadata: Type.Object({
        name: providerName,
        resource_version: resourceVersion,
        labels: credentials,
      }),
      credentials,
      profile_workspace: Type.String(),
      credential_expiration_times: Type.Optional(expirations),
    }),
  }),
  UpdateProvider: Type.Object({
    ...workspaceScope,
    provider: Type.Object({
      metadata: Type.Object({ name: providerName, resource_version: resourceVersion }),
      credentials,
    }),
    credential_expiration_times: Type.Optional(expirations),
  }),
};

type Requests = {
  [Method in keyof typeof requestSchemas]: Static<(typeof requestSchemas)[Method]>;
};
type RecordedMethod = Exclude<keyof Requests, "GetWorkspace">;
export type RecordedRequest = {
  [Method in RecordedMethod]: { method: Method; request: Requests[Method] };
}[RecordedMethod];

type WireTimestamp = Static<typeof timestamp>;
type WireProfile = Requests["ImportProviderProfiles"]["profiles"][number]["profile"] & {
  resource_version: string;
};
type WireProvider = Omit<
  Requests["CreateProvider"]["provider"],
  "metadata" | "credential_expiration_times"
> & {
  metadata: Requests["CreateProvider"]["provider"]["metadata"] & {
    id: string;
    workspace: string;
    resource_version: string;
  };
  credential_expiration_times?: Static<typeof expirations> | undefined;
};
export interface WireInstalledStatus {
  state: string;
  reason: string;
  receipt: {
    receipt_id: string;
    kind: string;
    workspace: string;
    provider: string;
    desired: {
      sandbox_id: string;
      sandbox: string;
      attachment_epoch: string;
      provider_id: string;
      provider_resource_version: string;
      provider_env_revision: string;
      config_revision: string;
      policy_hash: string;
    };
  };
  observed: {
    session_id: string;
    sequence: string;
    attachment_epoch: string;
    provider_env_revision: string;
    config_revision: string;
    policy_hash: string;
    credentials_installed: boolean;
    policy_active: boolean;
    launch_environment_installed: boolean;
    process_instance_id: string;
    reason: string;
  };
  network_instance_id: string;
  observed_time: WireTimestamp;
  evaluated_time: WireTimestamp;
  operation?: {
    operation_id: string;
    state: number;
    outcome: number;
    completed_time?: WireTimestamp | undefined;
  };
}

export type WireProviderStatus = Pick<WireInstalledStatus, "state"> & Partial<WireInstalledStatus>;

type ProviderReply = { provider: WireProvider };

interface Replies {
  GetWorkspace: { workspace: { metadata: { name: string; id: string } } };
  GetSandbox: {
    sandbox: {
      metadata: { id: string; name: string; workspace: string };
      status: {
        phase: string;
        main_process_instance_id: string;
        configuration_activated: boolean;
        configuration_admission: {
          instance_id: string;
          state: number;
          policy_version: number;
          policy_hash: string;
          config_revision: string;
          provider_env_revision: string;
        };
      };
    };
  };
  GetSandboxProviderStatus: { status: WireProviderStatus };
  GetProviderProfile: { profile: WireProfile };
  ImportProviderProfiles: { imported: boolean; profiles: WireProfile[] };
  GetProvider: ProviderReply;
  CreateProvider: ProviderReply;
  UpdateProvider: ProviderReply;
}

type Handlers = {
  [Method in keyof Requests]: (
    request: Requests[Method],
    callback: Grpc.sendUnaryData<Replies[Method]>,
  ) => void;
};

function isRequest<Method extends keyof Requests>(
  method: Method,
  request: unknown,
): request is Requests[Method] {
  return Check(requestSchemas[method], request);
}

function unary<Method extends keyof Requests>(method: Method, handler: Handlers[NoInfer<Method>]) {
  return ({ request }: { request: unknown }, callback: Grpc.sendUnaryData<Replies[Method]>) => {
    // Decode with the independent schema. Check only the fields the peer or cases read,
    // and keep the decoded object intact so its profile can round-trip with all fields.
    assert.ok(isRequest(method, request), `Malformed ${method} request`);
    handler(request, callback);
  };
}

interface WireState {
  requests: RecordedRequest[];
  profile?: WireProfile;
  provider?: WireProvider;
  conflict: boolean;
  lost: boolean;
  denyReads: boolean;
  workspaceId: string;
  workspaceReads: number;
  status?: WireProviderStatus;
  mainProcessInstanceId: string;
  sandboxPhase: string;
  // Runs as each recorded request arrives, before the server answers it.
  onRequest?: (entry: RecordedRequest) => void;
  // Holds the provider write's answer this long (a slow but healthy gateway).
  writeDelayMs: number;
}

export async function wire(t: TestContext, bearerTokenPath?: string) {
  const service = await loadWireService(t);
  const state: WireState = {
    requests: [],
    conflict: false,
    lost: false,
    denyReads: false,
    workspaceId: scope.workspaceId,
    workspaceReads: 0,
    mainProcessInstanceId: "network-instance",
    sandboxPhase: "SANDBOX_PHASE_READY",
    writeDelayMs: 0,
  };
  const server = new grpc.Server();

  function record(entry: RecordedRequest): void {
    state.requests.push(entry);
    assert.equal(entry.request.workspace_scope.workspace, scope.workspace);
    state.onRequest?.(entry);
  }

  function answerWrite(callback: Grpc.sendUnaryData<ProviderReply>, provider: WireProvider): void {
    if (state.writeDelayMs) {
      setTimeout(() => callback(null, { provider }), state.writeDelayMs);
    } else {
      callback(null, { provider });
    }
  }

  server.addService(service, {
    GetSandbox: unary("GetSandbox", (request, callback) => {
      record({ method: "GetSandbox", request });
      assert.equal(request.name, scope.sandbox);
      callback(null, {
        sandbox: {
          metadata: { id: "sandbox-id", name: scope.sandbox, workspace: scope.workspace },
          status: {
            phase: state.sandboxPhase,
            main_process_instance_id: state.mainProcessInstanceId,
            configuration_activated: true,
            configuration_admission: {
              instance_id: "configuration-instance",
              state: 2,
              policy_version: 1,
              policy_hash: "policy-hash",
              config_revision: "202",
              provider_env_revision: "101",
            },
          },
        },
      });
    }),
    GetSandboxProviderStatus: unary("GetSandboxProviderStatus", (request, callback) => {
      record({ method: "GetSandboxProviderStatus", request });
      assert.equal(request.sandbox, scope.sandbox);
      assert.equal(request.receipt_id, undefined);
      callback(null, { status: state.status ?? { state: "PROVIDER_READINESS_STATE_PENDING" } });
    }),
    GetWorkspace: unary("GetWorkspace", (request, callback) => {
      state.workspaceReads += 1;
      assert.equal(request.name, scope.workspace);
      callback(null, { workspace: { metadata: { name: scope.workspace, id: state.workspaceId } } });
    }),
    GetProviderProfile: unary("GetProviderProfile", (request, callback) => {
      record({ method: "GetProviderProfile", request });
      if (state.denyReads) {
        callback({ code: grpc.status.PERMISSION_DENIED, details: "workspace" });
        return;
      }
      if (!state.profile) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, { profile: state.profile });
    }),
    ImportProviderProfiles: unary("ImportProviderProfiles", (request, callback) => {
      record({ method: "ImportProviderProfiles", request });
      assert.equal(request.profiles.length, 1);
      assert.match(request.request_id, /^[a-f0-9-]{36}$/);
      const [item] = request.profiles;
      assert.ok(item);
      state.profile = { ...item.profile, resource_version: "1" };
      callback(null, { imported: true, profiles: [state.profile] });
    }),
    GetProvider: unary("GetProvider", (request, callback) => {
      record({ method: "GetProvider", request });
      if (!state.provider) {
        callback({ code: grpc.status.NOT_FOUND });
        return;
      }
      callback(null, { provider: state.provider });
    }),
    CreateProvider: unary("CreateProvider", (request, callback) => {
      record({ method: "CreateProvider", request });
      state.provider = {
        ...request.provider,
        metadata: {
          ...request.provider.metadata,
          id: "provider-id",
          workspace: scope.workspace,
          resource_version: "1",
        },
      };
      answerWrite(callback, state.provider);
    }),
    UpdateProvider: unary("UpdateProvider", (request, callback) => {
      record({ method: "UpdateProvider", request });
      assert.ok(state.provider);
      // The independent server enforces the released resource-version precondition.
      if (
        state.conflict ||
        request.provider.metadata.resource_version !== state.provider.metadata.resource_version
      ) {
        callback({ code: grpc.status.ABORTED, details: "concurrent writer" });
        return;
      }
      state.provider = {
        ...state.provider,
        credentials: request.provider.credentials,
        credential_expiration_times: request.credential_expiration_times,
        metadata: { ...state.provider.metadata, resource_version: "2" },
      };
      if (state.lost) {
        assert.ok(state.provider.credentials.GITHUB_TOKEN);
        callback({
          code: grpc.status.UNAVAILABLE,
          details: state.provider.credentials.GITHUB_TOKEN,
        });
        return;
      }
      answerWrite(callback, state.provider);
    }),
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  ).catch((error: unknown) => {
    server.forceShutdown();
    throw error;
  });
  const client = new GrpcOpenShellGatewayClient({
    endpoint: `127.0.0.1:${port}`,
    ...(bearerTokenPath === undefined
      ? {}
      : { auth: { mode: "bearerTokenFile", path: bearerTokenPath } }),
  });
  t.after(() => {
    client.close();
    server.forceShutdown();
  });
  return { state, binding: new OpenShellPreparedGitProvider(client, scope), client };
}
