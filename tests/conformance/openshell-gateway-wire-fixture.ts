import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";

export { grpc };
export type { Grpc };

type Labels = Record<string, string>;
type WorkspaceScope = { workspace?: string | undefined; selection?: "workspace" };
type Scoped = { workspace_scope?: WorkspaceScope };
type Named = { name?: string | undefined };
type ScopedSandbox = Scoped & { sandbox?: string | undefined };
type ScopedService = ScopedSandbox & Named;
type ScopedProvider = Scoped & { provider?: string | undefined; credential_key?: string };
type WireTime = { seconds?: string; nanos?: number };
type Metadata = Named & {
  id?: string;
  workspace?: string | undefined;
  labels?: Labels | undefined;
  annotations?: Labels | undefined;
  resource_version?: string;
};
type NetworkEndpoint = {
  host?: string;
  port?: number;
  ports?: number[];
  path?: string;
  protocol?: string;
  tls?: string;
  enforcement?: string;
  access?: string;
  allowed_ips?: string[];
  rules?: {
    allow?: {
      method?: string;
      path?: string;
      query?: Record<string, { glob?: string; any?: string[] }>;
    };
  }[];
  websocket_credential_rewrite?: boolean;
  credential_binding?: { provider?: string | undefined };
};
type NetworkPolicy = {
  name?: string | undefined;
  binaries?: { path?: string }[];
  endpoints?: NetworkEndpoint[];
};
type SandboxPolicy = {
  version?: number;
  filesystem?: { read_only?: string[]; read_write?: string[] };
  process?: { run_as_user?: string; run_as_group?: string };
  network_policies?: Record<string, NetworkPolicy>;
};
type SandboxSpec = {
  template?: { image?: string; resources?: unknown; driver_config?: unknown };
  policy?: SandboxPolicy;
  providers?: string[];
  restart_policy?: string;
};
type Sandbox = {
  metadata?: Metadata;
  spec?: SandboxSpec | undefined;
  status?: { phase?: string; exit_code?: number; restart_count?: number };
};
type SandboxReply = { sandbox?: Sandbox | undefined; service_urls?: Labels };
type DeletionReply = { outcome?: string; sandbox_id?: string };
type Provider = {
  metadata?: Metadata;
  type?: string;
  credentials?: Labels;
  config?: Labels;
  credential_expiration_times?: Record<string, WireTime>;
  profile_workspace?: string;
};
type ProviderReply = { provider?: Provider | undefined };
type ProviderReceipt = { receipt_id?: string | undefined; kind?: string };
type ProviderProfile = {
  id?: string;
  display_name?: string;
  category?: string;
  annotations?: Labels | undefined;
  resource_version?: string;
  scope?: string;
  credentials?: {
    name?: string | undefined;
    env_vars?: string[];
    required?: boolean;
    auth_style?: string;
    header_name?: string;
    refresh?: {
      strategy?: string;
      token_url?: string;
      material?: { name?: string | undefined; required?: boolean; secret?: boolean }[];
    };
  }[];
  files?: { path?: string; content?: string; env_var?: string }[];
  endpoints?: NetworkEndpoint[];
  binaries?: { path?: string }[];
};
type RefreshStatus = {
  provider?: string | undefined;
  credential_key?: string;
  strategy?: string;
  status?: string;
  expiration_time?: WireTime;
  next_refresh_time?: WireTime;
  last_refresh_time?: WireTime;
  recovery_action?: string;
  failure_code?: string;
};
export type WireSandboxLogLine = {
  sandbox_id?: string;
  event_time?: WireTime;
  level?: string;
  target?: string;
  message?: string;
  source?: string;
  fields?: Labels;
};
type ExecRequest = ScopedSandbox & {
  command?: string[];
  environment?: Labels;
  stdin?: Buffer;
  execution_timeout?: WireTime;
  tty?: boolean;
  no_login_shell?: boolean;
  request_id?: string;
};
type ExecFrame =
  | { stdout: { data: Buffer }; stderr?: never; exit?: never }
  | { stderr: { data: Buffer }; stdout?: never; exit?: never }
  | { exit: { exit_code?: number }; stdout?: never; stderr?: never };

// Fields exercised by the peer come from the pinned supplier schemas in tests/fixtures.
// The loader omits absent fields, adds oneof discriminants and decodes uint64 as strings.
type WireMethods = {
  Health: [Record<string, never>, { status?: string }];
  GetSandbox: [Scoped & Named, SandboxReply];
  CreateSandbox: [
    Scoped &
      Named & {
        spec?: SandboxSpec | undefined;
        labels?: Labels | undefined;
        annotations?: Labels | undefined;
        request_id?: string;
        service_exposures?: {
          service?: string;
          target_port?: number;
          authorization_mode?: string;
        }[];
      },
    SandboxReply,
  ];
  GetService: [
    ScopedService,
    {
      endpoint?: {
        sandbox?: string | undefined;
        name?: string | undefined;
        target_port?: number;
        authorization_mode?: string;
      };
      url?: string;
    },
  ];
  DeleteService: [ScopedService & { allow_missing?: boolean; request_id?: string }, DeletionReply];
  DeleteSandbox: [Scoped & Named, DeletionReply];
  GetWorkspace: [Named, { workspace?: { metadata?: Metadata; status?: { phase?: string } } }];
  GetSandboxPolicyStatus: [
    ScopedSandbox & { global?: boolean; version?: number },
    {
      revision?: { version?: number; status?: string; policy?: SandboxPolicy };
      active_version?: number;
    },
  ];
  UpdateConfig: [
    ScopedSandbox & {
      policy?: SandboxPolicy;
      expected_resource_version?: string;
      request_id?: string;
    },
    { version?: number },
  ];
  GetDraftPolicy: [
    ScopedSandbox & { status_filter?: string },
    {
      draft_version?: string;
      chunks?: {
        id?: string;
        status?: string;
        hit_count?: number;
        proposed_rule?: NetworkPolicy;
      }[];
    },
  ];
  CreateProvider: [
    Scoped & { provider?: Provider | undefined; request_id?: string },
    ProviderReply,
  ];
  UpdateProvider: [
    Scoped & {
      provider?: Provider | undefined;
      credential_expiration_times?: Record<string, WireTime>;
      request_id?: string;
    },
    ProviderReply,
  ];
  ImportProviderProfiles: [
    Scoped & { profiles?: { profile?: ProviderProfile; source?: string }[]; request_id?: string },
    { imported?: boolean; profiles?: ProviderProfile[] },
  ];
  GetProviderProfile: [Scoped & { id?: string }, { profile?: ProviderProfile }];
  ListProviderProfiles: [
    Scoped & { page_token?: string },
    { profiles?: ProviderProfile[]; next_page_token?: string },
  ];
  GetSandboxProviderStatus: [
    ScopedSandbox & { provider?: string | undefined; receipt_id?: string | undefined },
    { status?: { state?: string; reason?: string; receipt?: ProviderReceipt } },
  ];
  DetachSandboxProvider: [
    ScopedSandbox & {
      provider?: string | undefined;
      expected_resource_version?: string;
      request_id?: string;
    },
    { detached?: boolean; receipt?: ProviderReceipt },
  ];
  GetProviderRefreshStatus: [ScopedProvider, { credentials?: RefreshStatus[] }];
  ConfigureProviderRefresh: [
    ScopedProvider & { strategy?: string; material?: Labels; request_id?: string },
    { status?: RefreshStatus },
  ];
  RotateProviderCredential: [ScopedProvider & { request_id?: string }, { status?: RefreshStatus }];
  DeleteProviderRefresh: [
    ScopedProvider & { allow_missing?: boolean; request_id?: string },
    DeletionReply,
  ];
  GetSandboxLogs: [
    ScopedSandbox & { lines?: number; since_time?: WireTime },
    { logs?: WireSandboxLogLine[]; buffer_total?: number },
  ];
  ExecSandbox: [ExecRequest, ExecFrame];
};

export type WireRequest<M extends keyof WireMethods> = WireMethods[M][0];
export type WireReply<M extends keyof WireMethods> = WireMethods[M][1];

type Cancellation = {
  once(event: "cancelled", listener: () => void): void;
};
type UnaryCall<M extends keyof WireMethods> = Cancellation & {
  request: WireRequest<M>;
  metadata: Pick<Grpc.Metadata, "get">;
};
type ExecCall = Cancellation & {
  request: ExecRequest;
  emit(event: "error", status: { code: number; details: string }): boolean;
  write(frame: ExecFrame, callback?: (error: Error | null | undefined) => void): boolean;
  end(): void;
};
type WireHandlers = {
  [M in keyof WireMethods]?: M extends "ExecSandbox"
    ? (call: ExecCall) => void
    : (call: UnaryCall<M>, reply: Grpc.sendUnaryData<WireReply<M>>) => void;
};

function loadService(
  fixture: string,
  options: Parameters<typeof loader.loadSync>[1],
): Record<string, Grpc.MethodDefinition<unknown, unknown>> {
  // The descriptors are passed to grpc-js unchanged. Case handlers separately
  // constrain the decoded fields and replies they actually observe.
  return openShellService(
    grpc.loadPackageDefinition(
      loader.loadSync(join(import.meta.dirname, "../fixtures", fixture), options),
    ),
  );
}

const wireOptions = { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true };

export function addWireService(
  server: Grpc.Server,
  handlers: WireHandlers,
  peer: "wire" | "health" | "workload" = "wire",
): void {
  const service = loadService(
    "openshell-v0.1.5-wire.proto",
    peer === "health" ? { keepCase: true, enums: String } : wireOptions,
  );
  if (peer === "workload") {
    const { GetSandbox } = service;
    const { ExecSandbox } = loadService("openshell-workload-exec.proto", wireOptions);
    assert.ok(GetSandbox && ExecSandbox);
    server.addService({ GetSandbox, ExecSandbox }, handlers);
    return;
  }
  server.addService(service, handlers);
}

export function bindWireServer(
  server: Grpc.Server,
  credentials = grpc.ServerCredentials.createInsecure(),
): Promise<number> {
  return new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", credentials, (error, port) => {
      if (error) {
        reject(error);
      } else {
        resolve(port);
      }
    }),
  );
}

export function shutdownWireServer(server: Grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}

export function boundPort(server: { address(): AddressInfo | string | null }): number {
  const address = server.address();
  assert.ok(address && typeof address !== "string", "expected a bound TCP listener");
  return address.port;
}
