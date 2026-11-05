import assert from "node:assert/strict";
import test from "node:test";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { ensureOpenShellProviderProfile } from "../../apps/controller/src/backends/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  checkOpenShellGitProviders,
  OpenShellGitRouteError,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-installation.ts";

test("provider profile wire defaults preserve Git overlap enforcement", async (t) => {
  const workspace = "profile-wire";
  const provider = "oce-runtime-revision-1";
  const id = "oce-codex-runtime";
  const files = [
    {
      path: "runtime.json",
      content: "{{config.runtime_json}}",
      env_var: "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
    },
    {
      path: "config.toml",
      content: "{{config.config_toml}}",
      env_var: "OPENCLAW_PLUGIN_CODEX_CONFIG_TOML",
    },
    {
      path: "node-setup.json",
      content: "{{config.node_setup_json}}",
      env_var: "OPENCLAW_NODE_SETUP_ENVELOPE",
    },
    { path: "node-ca.pem", content: "{{config.node_ca_pem}}", env_var: "OPENCLAW_NODE_CA_PATH" },
  ];
  const runtime = {
    id,
    display_name: "Codex runtime files (OpenClaw Enterprise)",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    files,
    inference_capable: false,
  };
  const endpoints = [{ host: "model.example.test", port: 443 }];
  const credentials = [{ name: "model_key", env_vars: ["MODEL_KEY"] }];
  let response: { profile?: Record<string, unknown> } | undefined;
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: "model",
    workspace,
    sandbox: "sandbox",
    revisionId: "revision-1",
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      methods.GetProvider = (request) => {
        assert.equal(request.name, provider);
        return {
          provider: {
            type: id,
            profile_workspace: workspace,
            metadata: { name: provider, workspace, resource_version: "1" },
          },
        };
      };
      methods.GetProviderProfile = (request) => {
        assert.equal(request.id, id);
        assert.ok(request.workspace_scope && typeof request.workspace_scope === "object");
        assert.equal(
          "workspace" in request.workspace_scope && request.workspace_scope.workspace,
          workspace,
        );
        return response;
      };
    },
  });
  assert.ok(client instanceof GrpcOpenShellGatewayClient);
  const signal = AbortSignal.timeout(10_000);

  for (const lists of [{}, { endpoints }, { credentials }, { endpoints, credentials }]) {
    await t.test(
      `accepts runtime files with ${Object.keys(lists).join(" and ") || "omitted lists"}`,
      async () => {
        // The real codec omits empty repeated fields; the guard must still inspect this profile.
        response = { profile: { ...runtime, ...lists } };
        await checkOpenShellGitProviders(client, workspace, [provider], signal);
        const profile = await client.getProviderProfile(workspace, id, signal);
        assert.deepEqual(profile?.definition?.files, files);
        assert.deepEqual(profile?.definition?.endpoints, "endpoints" in lists ? endpoints : []);
        assert.deepEqual(
          profile?.definition?.credentials,
          "credentials" in lists ? credentials : [],
        );
      },
    );
  }

  await t.test("missing profile remains unverified", async () => {
    response = undefined;
    assert.equal(await client.getProviderProfile(workspace, id, signal), undefined);
    await assert.rejects(checkOpenShellGitProviders(client, workspace, [provider], signal), {
      name: OpenShellGitRouteError.name,
      reason: "provider_overlap",
    });
  });

  for (const profile of [undefined, { ...runtime, id: "another-profile" }]) {
    await t.test(
      profile ? "rejects mismatched profile ID" : "rejects absent profile envelope",
      async () => {
        response = profile ? { profile } : {};
        await assert.rejects(
          checkOpenShellGitProviders(client, workspace, [provider], signal),
          /GetProviderProfile returned another profile/,
        );
      },
    );
  }

  for (const overlap of [
    { endpoints: [{ host: "uploads.github.com", port: 443 }], credentials },
    { endpoints, credentials: [{ name: "github", env_vars: ["GITHUB_TOKEN"] }] },
  ]) {
    await t.test(
      `rejects overlap through ${overlap.endpoints === endpoints ? "GITHUB_TOKEN" : "GitHub hostname"}`,
      async () => {
        response = { profile: { ...runtime, ...overlap } };
        await assert.rejects(checkOpenShellGitProviders(client, workspace, [provider], signal), {
          name: OpenShellGitRouteError.name,
          reason: "provider_overlap",
        });
      },
    );
  }
});

test("reconciles a Workspace provider profile without replaying a failed write", async (t) => {
  const workspace = "profile-reconcile";
  const profile: Omit<OpenShellProviderProfile, "annotations"> = {
    id: "oce-source-profile",
    displayName: "Original profile",
    category: "PROVIDER_PROFILE_CATEGORY_OTHER",
    credentials: [],
    endpoints: [{ host: "tools.example.test", port: 443, protocol: "rest" }],
    binaries: ["/usr/bin/curl"],
    inferenceCapable: false,
  };
  const calls: string[] = [];
  let stored: Record<string, unknown> | undefined;
  let update: "success" | "matching" | "foreign" = "success";
  function profileFrom(value: unknown): Record<string, unknown> {
    assert.ok(value && typeof value === "object" && "profile" in value);
    assert.ok(value.profile && typeof value.profile === "object");
    return { ...value.profile };
  }
  function checkWorkspace(request: Record<string, unknown>) {
    const scope = request.workspace_scope;
    assert.ok(scope && typeof scope === "object" && "workspace" in scope);
    assert.equal(scope.workspace, workspace);
  }
  const { client }: { client: GrpcOpenShellGatewayClient } = await gitExpiryGateway(t, {
    model: "model",
    workspace,
    sandbox: "sandbox",
    revisionId: "revision-1",
    deadline: "2030-01-01T00:00:00Z",
    platformProfile: false,
    configure(methods: Record<string, (request: Record<string, unknown>) => unknown>) {
      methods.GetProviderProfile = (request) => {
        checkWorkspace(request);
        assert.equal(request.id, profile.id);
        calls.push("read");
        return stored && { profile: stored };
      };
      methods.ImportProviderProfiles = (request) => {
        checkWorkspace(request);
        assert.ok(Array.isArray(request.profiles) && request.profiles.length === 1);
        const incoming = profileFrom(request.profiles[0]);
        assert.equal(incoming.id, profile.id);
        calls.push("import");
        stored = { ...incoming, resource_version: "7" };
        return { imported: true };
      };
      methods.UpdateProviderProfiles = (request) => {
        checkWorkspace(request);
        assert.equal(request.id, profile.id);
        const incoming = profileFrom(request.profile);
        assert.equal(incoming.id, profile.id);
        assert.equal(request.expected_resource_version, stored?.resource_version);
        const version = String(request.expected_resource_version);
        calls.push("update:" + version);
        if (update !== "foreign") {
          stored = { ...incoming, resource_version: String(Number(version) + 1) };
        }
        return { updated: update === "success" };
      };
    },
  });
  assert.ok(client instanceof GrpcOpenShellGatewayClient);
  const signal = AbortSignal.timeout(10_000);
  const reconcile = (displayName: string) =>
    ensureOpenShellProviderProfile(client, workspace, { ...profile, displayName }, signal);

  await reconcile("Original profile");
  assert.deepEqual(calls.splice(0), ["read", "import"]);
  await reconcile("Original profile");
  assert.deepEqual(calls.splice(0), ["read"]);

  await reconcile("Updated profile");
  assert.deepEqual(calls.splice(0), ["read", "update:7"]);

  update = "matching";
  await reconcile("Concurrent matching profile");
  assert.deepEqual(calls.splice(0), ["read", "update:8", "read"]);

  update = "foreign";
  await assert.rejects(reconcile("Unapplied profile"), /UpdateProviderProfiles did not update/);
  assert.deepEqual(calls.splice(0), ["read", "update:9", "read"]);
  assert.equal(stored?.display_name, "Concurrent matching profile");
});
