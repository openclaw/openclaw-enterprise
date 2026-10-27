import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";

const packet = (line) =>
  Buffer.from((Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line);

// Real Git creates the object IDs and pack. The command bodies are protocol inputs;
// no fetch or push is dispatched and no remote repository outcome is claimed.
export async function gitCommandBodies(t, pushRef) {
  const cwd = await temporaryDirectory(t, "online-git-commands-");
  await run("git", ["init", "--initial-branch=main", "--object-format=sha1"], { cwd });
  await writeFile(join(cwd, "README.md"), "Owned synthetic Git authorization fixture\n");
  await run("git", ["add", "README.md"], { cwd });
  await run(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"],
    { cwd },
  );
  const oid = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], {
    cwd,
    env: cleanEnvironment(),
    input: `${oid}\n`,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const update = `${"0".repeat(40)} ${oid}`;
  const first = packet(`${update} ${pushRef}\0report-status\n`);
  return {
    // Run only after the authorization under test allowed the exact upload-pack input.
    uploadPack: (input) =>
      execFileSync("git", ["upload-pack", "--stateless-rpc", "."], {
        cwd,
        input,
        env: cleanEnvironment(),
        timeout: 5000,
      }),
    fetch: Buffer.concat([packet(`want ${oid}\n`), Buffer.from("0000"), packet("done\n")]),
    push: Buffer.concat([first, Buffer.from("0000"), pack]),
    mixed: Buffer.concat([first, packet(`${update} refs/heads/main\n`), Buffer.from("0000"), pack]),
  };
}

// The stock gateway boundary for the worker expiry regression. The production gRPC client
// sends every request, including provider bootstrap, credential rotation and conditional detach.
// openshell-gateway-wire.test.mjs checks that client's encoding against the released schema.
// No Kubernetes, real supervisor, credential or model provider is needed for this test.
export async function gitExpiryGateway(
  t,
  {
    model,
    workspace,
    sandbox,
    revisionId,
    deadline,
    platformProfile,
    trackGitExpiry = false,
    onGitInstall = (_value) => {},
    modelSourceId = "",
  },
) {
  const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const grpc = require("@grpc/grpc-js");
  const path = fileURLToPath(
    new URL(
      "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
      import.meta.url,
    ),
  );
  const definition = require("@grpc/proto-loader").loadSync(path, {
    keepCase: true,
    enums: String,
    longs: String,
    defaults: false,
    oneofs: true,
  });
  const { OpenShell } = grpc.loadPackageDefinition(definition).openshell.v1;
  // One controlled installation supplies both the release evidence and the Git readiness wire.
  // Its enforcement instance, process, network instance and reconnectable session are distinct.
  const repositoryGitRecipient = Object.freeze({
    providerId: "git-id",
    attachmentEpoch: "original",
    processInstanceId: "same-process",
    networkInstanceId: "same-network",
  });
  const world = {
    repositoryGitRecipient,
    writes: 0,
    providerCreates: [],
    profileImports: [],
    detaches: [],
    reports: [],
    version: 13,
    modelFailed: false,
    gitExpiresAt: deadline,
    installedDigest: "",
    id: /** @type {string | undefined} */ (undefined),
  };
  const profiles = {
    inference: {
      id: "inference",
      endpoints: [{ host: "model.example.test" }],
      credentials: [{ name: "model_key", env_vars: ["MODEL_KEY"] }],
    },
  };
  // An operator provider may select a platform profile even when its Workspace has a namesake.
  const serviceProfile = {
    id: "service",
    endpoints: [{ host: "service.example.test", port: 443 }],
    credentials: [{ name: "service_key", env_vars: ["SERVICE_KEY"] }],
  };
  const platformService = structuredClone(serviceProfile);
  const retainedProfile = platformProfile ? platformService : profiles.inference;
  world.profileReads = [];
  world.addRetainedEndpoint = (host) => {
    assert.equal(world.detaches.length, 1, "change only the retained profile, after Git detached");
    retainedProfile.endpoints.push({ host, port: 443 });
    retainedProfile.resource_version = "2";
  };
  const providers = {
    [model]: {
      type: modelSourceId ? model : "inference",
      profile_workspace: workspace,
      metadata: {
        workspace,
        name: model,
        id: "model-id",
        resource_version: "7",
        ...(modelSourceId && {
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/credential-source-id": modelSourceId,
          },
        }),
      },
    },
  };
  if (platformProfile) {
    profiles.service = serviceProfile;
    providers["operator-service"] = {
      // On the stock wire an omitted profile_workspace is the empty string (platform).
      type: "service",
      metadata: { workspace, name: "operator-service", id: "service-id", resource_version: "4" },
    };
  }
  world.retainedProviders = Object.keys(providers);
  let gitName;
  const observe = (req) => {
    const name = req.provider;
    const git = name === gitName;
    const removed = world.detaches.length !== 0;
    const expired = git && !removed && Date.now() >= world.gitExpiresAt;
    const absent = git && removed;
    const profileChanged = retainedProfile.resource_version === "2";
    const snapshot = {
      attachment_epoch: removed ? "reduced" : repositoryGitRecipient.attachmentEpoch,
      config_revision: "3",
      provider_env_revision: profileChanged ? "9" : removed ? "8" : "6",
      policy_hash: profileChanged
        ? "reduced-updated-provider-policy"
        : removed
          ? "reduced-policy"
          : "original-policy",
    };
    const metadata = providers[name].metadata;
    const state = absent ? "REVOKED" : expired || (!git && world.modelFailed) ? "FAILED" : "READY";
    // Only the Sandbox resourceVersion changes between the expiry owner's first two reads.
    if (expired && world.version === 13) {
      world.version = 14;
    }
    if (removed) {
      world.reports.push([name, state, req.receipt_id ?? "OBSERVE"]);
    }
    const now = { seconds: Math.floor(Date.now() / 1000) };
    return {
      status: {
        state: "PROVIDER_READINESS_STATE_" + state,
        ...(expired && { reason: "PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED" }),
        receipt: {
          workspace,
          provider: name,
          receipt_id: "observe-" + name,
          kind: "PROVIDER_MUTATION_KIND_OBSERVE",
          desired: {
            ...snapshot,
            sandbox_id: world.id,
            sandbox,
            provider_id: absent ? "" : metadata.id,
            provider_resource_version: absent ? "0" : metadata.resource_version,
          },
        },
        observed: {
          ...snapshot,
          sequence: "81",
          session_id: "same-supervisor",
          process_instance_id: repositoryGitRecipient.processInstanceId,
          credentials_installed: !expired,
          launch_environment_installed: !expired,
          policy_active: true,
        },
        network_instance_id: repositoryGitRecipient.networkInstanceId,
        observed_time: now,
        evaluated_time: now,
      },
    };
  };
  const methods = {
    GetWorkspace: () => ({ workspace: { metadata: { name: workspace, id: "workspace-id" } } }),
    GetGatewayInfo: () => ({
      extensions: [
        {
          configured_name: "oce-prepared-git",
          kind: 4,
          protocol_major: 1,
        },
      ],
    }),
    GetSandbox: () =>
      world.id && {
        sandbox: {
          metadata: {
            id: world.id,
            name: sandbox,
            workspace,
            resource_version: String(world.version),
            annotations: { "openclaw.dev/revision-id": revisionId },
          },
          spec: {
            restart_policy: "SANDBOX_RESTART_POLICY_NEVER",
            providers: world.detaches.length
              ? world.retainedProviders
              : [...world.retainedProviders, gitName],
            provider_attachment_epoch: world.detaches.length
              ? "reduced"
              : repositoryGitRecipient.attachmentEpoch,
          },
          status: { phase: "SANDBOX_PHASE_READY" },
        },
      },
    GetProvider: ({ name }) => providers[name] && { provider: providers[name] },
    GetProviderProfile: ({ id, workspace_scope }) => {
      if (id === "service" && world.detaches.length) {
        world.profileReads.push(
          workspace_scope === undefined ? "platform" : workspace_scope.workspace,
        );
      }
      if (workspace_scope === undefined) {
        if (world.denyPlatformProfile) {
          throw Object.assign(Error("platform profile access denied"), {
            code: grpc.status.PERMISSION_DENIED,
          });
        }
        return id === "service" && { profile: platformService };
      }
      assert.equal(workspace_scope.workspace, workspace);
      return profiles[id] && { profile: profiles[id] };
    },
    ImportProviderProfiles: ({ profiles: [{ profile }] }) => {
      world.profileImports.push(profile.id);
      profiles[profile.id] = { ...profile, resource_version: "1" };
      return { imported: true };
    },
    CreateProvider: ({ provider: { metadata, type, profile_workspace } }) => {
      world.providerCreates.push(metadata.name);
      gitName = metadata.name;
      const provider = {
        metadata: {
          ...metadata,
          workspace,
          id: repositoryGitRecipient.providerId,
          resource_version: "1",
        },
        type,
        profile_workspace,
      };
      providers[gitName] = provider;
      return { provider };
    },
    UpdateProvider: ({ provider: { metadata, credentials }, credential_expiration_times }) => {
      const provider = providers[gitName];
      assert.equal(metadata.name, gitName);
      assert.equal(metadata.resource_version, provider.metadata.resource_version);
      provider.metadata.resource_version = String(Number(metadata.resource_version) + 1);
      if (trackGitExpiry) {
        // Report the expiry of the generation actually received on the stock CAS wire.
        const { seconds, nanos } = credential_expiration_times.GITHUB_TOKEN;
        world.gitExpiresAt = Number(seconds) * 1000 + Number(nanos ?? 0) / 1_000_000;
        world.installedDigest = createHash("sha256").update(credentials.GITHUB_TOKEN).digest("hex");
      }
      onGitInstall?.(credentials.GITHUB_TOKEN);
      world.writes++;
      return { provider };
    },
    GetSandboxProviderStatus: observe,
    DetachSandboxProvider: (req) => {
      assert.equal(req.sandbox, sandbox);
      assert.equal(req.provider, gitName);
      assert.equal(req.workspace_scope.workspace, workspace);
      assert.deepEqual(world.detaches, []);
      assert.equal(req.expected_resource_version, "14", "only send against a fresh observation");
      world.detaches.push(req.request_id);
      world.version = 15;
      // Stock committed the conditional removal; its reply was lost. No DETACH receipt
      // is available, only OBSERVE of the reduced installation on a subsequent read.
      throw Object.assign(Error("reply lost"), { code: grpc.status.UNAVAILABLE });
    },
  };
  const server = new grpc.Server();
  server.addService(
    OpenShell.service,
    Object.fromEntries(
      Object.entries(methods).map(([name, handle]) => [
        name,
        (call, done) => {
          try {
            const response = handle(call.request);
            done(response ? null : { code: grpc.status.NOT_FOUND }, response);
          } catch (error) {
            done(error);
          }
        },
      ]),
    ),
  );
  const port = await new Promise((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  const client = new GrpcOpenShellGatewayClient({ endpoint: "127.0.0.1:" + port });
  t.after(() => {
    client.close();
    server.forceShutdown();
  });
  return { client, world };
}
