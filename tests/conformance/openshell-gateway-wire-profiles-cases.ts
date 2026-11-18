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

export function registerProfilesCases(): void {
  test("OpenShell client serializes v0.1.5 credential providers, profiles, and attachment status", async () => {
    const requests: {
      profiles: WireRequest<"ImportProviderProfiles">[];
      providers: WireRequest<"CreateProvider">[];
      sandboxes: WireRequest<"CreateSandbox">[];
      statuses: WireRequest<"GetSandboxProviderStatus">[];
    } = { profiles: [], providers: [], sandboxes: [], statuses: [] };
    const server = new grpc.Server();

    // The upstream oracle decodes every request, so a renumbered credential, endpoint path, or
    // provider attachment field fails here instead of silently dropping an injected credential.
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
      CreateProvider(call, callback) {
        requests.providers.push(call.request);
        // Echo the credential so the assertion below proves the client, not this stub, redacts it.
        callback(null, { provider: call.request.provider });
      },
      CreateSandbox(call, callback) {
        requests.sandboxes.push(call.request);
        callback(null, {
          sandbox: { metadata: { name: call.request.name, labels: {} } },
          service_urls: {
            "": `http://tenant-workspace--${call.request.name}.openshell.localhost:8080/`,
          },
        });
      },
      GetSandboxProviderStatus(call, callback) {
        requests.statuses.push(call.request);
        callback(null, {
          status: {
            state: "PROVIDER_READINESS_STATE_READY",
            reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
          },
        });
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });

    try {
      // Client initialization yields; cancel before it can dispatch the mutation.
      const abort = new AbortController();
      const pending = client.createProvider(
        {
          workspace: "tenant-workspace",
          name: "cancelled-source",
          type: "oce-openai",
          labels: {},
          credentials: { OPENAI_API_KEY: "wire-test-value" },
          credentialExpirationTimes: {
            OPENAI_API_KEY: "2026-10-01T18:00:00.123Z",
          },
        },
        abort.signal,
      );
      abort.abort(new Error("cancelled during setup"));
      await assert.rejects(pending, /cancelled during setup/);
      assert.equal(requests.providers.length, 0);

      await client.importProviderProfile(
        "tenant-workspace",
        {
          id: "oce-openai",
          displayName: "OpenAI",
          category: "PROVIDER_PROFILE_CATEGORY_INFERENCE",
          credentials: [
            {
              name: "api_key",
              envVars: ["OPENAI_API_KEY"],
              required: true,
              authStyle: "bearer",
              headerName: "authorization",
            },
          ],
          files: [
            {
              path: "runtime.json",
              content: "{{config.runtime_json}}",
              environmentVariable: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
            },
          ],
          endpoints: [{ host: "api.openai.com", port: 443, protocol: "rest", path: "/v1/**" }],
          binaries: ["/app/bin/codex"],
          inferenceCapable: true,
          annotations: { "openclaw.dev/profile-digest": "digest" },
        },
        AbortSignal.timeout(2_000),
      );
      const provider = await client.createProvider(
        {
          workspace: "tenant-workspace",
          name: "oce-cs-000000000000000000000000",
          type: "oce-openai",
          labels: { "openclaw.dev/credential-source-id": "cs_example" },
          credentials: { OPENAI_API_KEY: "wire-test-value" },
          credentialExpirationTimes: {
            OPENAI_API_KEY: "2026-10-01T18:00:00.123Z",
          },
          config: { runtime_json: '{"kind":"codex","selections":{}}' },
        },
        AbortSignal.timeout(2_000),
      );
      await client.createSandbox(
        {
          name: "sandbox-wire",
          workspace: "tenant-workspace",
          requestId: "7dfed2b8-8cef-4513-ab04-020baf3ccbf3",
          labels: {},
          annotations: {},
          serviceExposures: [],
          spec: { providers: ["oce-cs-000000000000000000000000"] },
        },
        AbortSignal.timeout(2_000),
      );
      const status = await client.getSandboxProviderStatus(
        "tenant-workspace",
        "sandbox-wire",
        "oce-cs-000000000000000000000000",
        AbortSignal.timeout(2_000),
      );

      const [profileImport] = requests.profiles;
      assert.deepEqual(profileImport?.workspace_scope, {
        workspace: "tenant-workspace",
        selection: "workspace",
      });
      assert.deepEqual(profileImport?.profiles?.[0]?.profile?.credentials, [
        {
          name: "api_key",
          env_vars: ["OPENAI_API_KEY"],
          required: true,
          auth_style: "bearer",
          header_name: "authorization",
        },
      ]);
      assert.deepEqual(profileImport?.profiles?.[0]?.profile?.files, [
        {
          path: "runtime.json",
          content: "{{config.runtime_json}}",
          env_var: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
        },
      ]);
      assert.deepEqual(profileImport?.profiles?.[0]?.profile?.endpoints, [
        {
          host: "api.openai.com",
          port: 443,
          protocol: "rest",
          path: "/v1/**",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          access: "NETWORK_ACCESS_PRESET_READ_WRITE",
        },
      ]);
      assert.deepEqual(profileImport?.profiles?.[0]?.profile?.binaries, [
        { path: "/app/bin/codex" },
      ]);
      assert.equal(
        profileImport?.profiles?.[0]?.profile?.category,
        "PROVIDER_PROFILE_CATEGORY_INFERENCE",
      );
      // Provider credentials are keyed by the environment variable the supervisor injects.
      assert.deepEqual(requests.providers[0]?.provider?.credentials, {
        OPENAI_API_KEY: "wire-test-value",
      });
      assert.deepEqual(requests.providers[0]?.provider?.credential_expiration_times, {
        OPENAI_API_KEY: { seconds: "1790877600", nanos: 123_000_000 },
      });
      assert.equal(requests.providers[0]?.provider?.type, "oce-openai");
      assert.deepEqual(requests.providers[0]?.provider?.config, {
        runtime_json: '{"kind":"codex","selections":{}}',
      });
      assert.deepEqual(provider.config, {
        runtime_json: '{"kind":"codex","selections":{}}',
      });
      // The profile lives in the provider's workspace, not in platform scope.
      assert.equal(requests.providers[0]?.provider?.profile_workspace, "tenant-workspace");
      assert.equal(
        requests.providers[0]?.provider?.metadata?.labels?.["openclaw.dev/credential-source-id"],
        "cs_example",
      );
      // The client never copies credential material out of a gateway response.
      assert.equal(JSON.stringify(provider).includes("wire-test-value"), false);
      assert.deepEqual(requests.sandboxes[0]?.spec?.providers, ["oce-cs-000000000000000000000000"]);
      assert.equal(requests.statuses[0]?.sandbox, "sandbox-wire");
      assert.equal(requests.statuses[0]?.provider, "oce-cs-000000000000000000000000");
      assert.deepEqual(status, {
        state: "PROVIDER_READINESS_STATE_READY",
        reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
      });
    } finally {
      client.close();
      await shutdownWireServer(server);
    }
  });

  // Namespace cleanup finds prepared Git profiles by listing them (finding 2206): a profile on a
  // later page, or one without annotations, must still decode with its owner annotation intact.
  test("OpenShell client lists a Workspace's provider profiles across pages", async () => {
    const requests: WireRequest<"ListProviderProfiles">[] = [];
    const server = new grpc.Server();
    addWireService(server, {
      ListProviderProfiles(call, callback) {
        requests.push(call.request);
        callback(
          null,
          call.request.page_token === ""
            ? { profiles: [{ id: "openai", scope: "platform" }], next_page_token: "page-2" }
            : {
                profiles: [
                  {
                    id: "oce-git-" + "a".repeat(32),
                    resource_version: "3",
                    annotations: { "openclaw.dev/prepared-git-binding": "a".repeat(48) },
                    scope: "workspace",
                  },
                ],
              },
        );
      },
    });
    const port = await bindWireServer(server);
    const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
    try {
      const profiles = await client.listProviderProfiles(
        "tenant-workspace",
        AbortSignal.timeout(5_000),
      );
      assert.deepEqual(
        profiles.map(({ id, resourceVersion, annotations }) => ({
          id,
          resourceVersion,
          annotations,
        })),
        [
          { id: "openai", resourceVersion: "0", annotations: {} },
          {
            id: "oce-git-" + "a".repeat(32),
            resourceVersion: "3",
            annotations: { "openclaw.dev/prepared-git-binding": "a".repeat(48) },
          },
        ],
      );
      // Namespace cleanup reads the server-set scope to skip platform profiles.
      assert.deepEqual(
        profiles.map(({ definition }) => definition?.scope),
        ["platform", "workspace"],
      );
      assert.deepEqual(
        requests.map(({ workspace_scope, page_token }) => [workspace_scope?.workspace, page_token]),
        [
          ["tenant-workspace", ""],
          ["tenant-workspace", "page-2"],
        ],
      );
    } finally {
      client.close();
      server.forceShutdown();
    }
  });
}
