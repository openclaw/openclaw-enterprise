import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { waitForStockSupervisor } from "../helpers/openshell-stock-supervisor-image.ts";
import { ensureOpenShellProviderProfile } from "../../apps/controller/src/backends/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { grpc, loader, openShellService, type Grpc } from "../helpers/openshell-grpc-sdk.ts";
import { bindWireServer } from "./openshell-gateway-wire-fixture.ts";

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
  type Wire = Record<string, unknown>;
  const methods: Record<string, (request: Wire) => Wire | undefined> = {
    GetProviderProfile(request) {
      checkWorkspace(request);
      assert.equal(request.id, profile.id);
      calls.push("read");
      return stored && { profile: stored };
    },
    ImportProviderProfiles(request) {
      checkWorkspace(request);
      assert.ok(Array.isArray(request.profiles) && request.profiles.length === 1);
      const incoming = profileFrom(request.profiles[0]);
      assert.equal(incoming.id, profile.id);
      calls.push("import");
      stored = { ...incoming, resource_version: "7" };
      return { imported: true };
    },
    UpdateProviderProfiles(request) {
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
    },
  };
  const proto = new URL(
    "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
    import.meta.url,
  );
  const service = openShellService(
    grpc.loadPackageDefinition(
      loader.loadSync(fileURLToPath(proto), {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: false,
        oneofs: true,
      }),
    ),
  );
  const server = new grpc.Server();
  server.addService(
    service,
    Object.fromEntries(
      Object.entries(methods).map(([method, handle]) => [
        method,
        (call: { request: Wire }, done: Grpc.sendUnaryData<Wire>) => {
          try {
            const reply = handle(call.request);
            done(reply ? null : { code: grpc.status.NOT_FOUND }, reply);
          } catch (error) {
            done(error as Error);
          }
        },
      ]),
    ),
  );
  const port = await bindWireServer(server);
  const client = new GrpcOpenShellGatewayClient({ endpoint: `127.0.0.1:${port}` });
  t.after(() => {
    client.close();
    server.forceShutdown();
  });
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

test("stock Supervisor readiness pins the Pod and its container", async (t) => {
  const digest = "sha256:" + "a".repeat(64);
  const configDigest = "sha256:" + "b".repeat(64);
  const otherDigest = "sha256:" + "c".repeat(64);
  const expected = {
    sandboxId: "sandbox",
    sandboxUid: "sandbox-uid",
    image: `registry.example/supervisor@${digest}`,
    digests: [digest, configDigest],
  };
  const pod = {
    metadata: {
      uid: "pod-uid",
      name: "supervisor",
      labels: {
        "openshell.ai/boundary-role": "supervisor",
        "openshell.ai/boundary-pair": "pair",
      },
      annotations: { "openshell.ai/sandbox-id": expected.sandboxId },
      ownerReferences: [{ kind: "Sandbox", uid: expected.sandboxUid }],
    },
    spec: { containers: [{ name: "supervisor", image: expected.image }] },
  };
  const running = {
    name: "supervisor",
    ready: true,
    imageID: `containerd://${configDigest}`,
    containerID: "containerd://owned",
    state: { running: {} },
  };
  const ready = { ...pod, status: { phase: "Running", containerStatuses: [running] } };
  const pending = {
    ...pod,
    status: {
      phase: "Pending",
      containerStatuses: [
        { name: "supervisor", ready: false, state: { waiting: { reason: "ContainerCreating" } } },
      ],
    },
  };
  const noRead = async () =>
    assert.fail("must check the initial identity and image before reading");
  await t.test("waits for the selected container's ready status and runtime digest", async (t) => {
    let reads = 0;
    const readPod = async (signal: AbortSignal) => {
      assert.equal(signal.aborted, false);
      reads++;
      return ready;
    };
    assert.deepEqual(await waitForStockSupervisor(pending, readPod, expected, t.signal), running);
    assert.equal(reads, 1);
    assert.deepEqual(await waitForStockSupervisor(ready, noRead, expected, t.signal), running);
  });
  await t.test("rejects a wrong requested or resolved image before readiness", async (t) => {
    await assert.rejects(
      waitForStockSupervisor(
        { ...pending, spec: { containers: [{ name: "supervisor", image: "other" }] } },
        noRead,
        expected,
        t.signal,
      ),
      /must select the verified stock image/,
    );
    const wrongImage = {
      ...ready,
      status: {
        ...ready.status,
        containerStatuses: [{ ...running, ready: false, imageID: otherDigest }],
      },
    };
    await assert.rejects(
      waitForStockSupervisor(wrongImage, noRead, expected, t.signal),
      /running supervisor image must match/,
    );
  });
  await t.test("refuses a replaced Pod or restarted container during the wait", async (t) => {
    await assert.rejects(
      waitForStockSupervisor(
        pending,
        async () => ({ ...ready, metadata: { ...pod.metadata, uid: "replacement" } }),
        expected,
        t.signal,
      ),
      /supervisor Pod UID changed/,
    );
    const starting = {
      ...ready,
      status: { ...ready.status, containerStatuses: [{ ...running, ready: false }] },
    };
    const replacement = {
      ...ready,
      status: {
        ...ready.status,
        containerStatuses: [{ ...running, containerID: "containerd://replacement" }],
      },
    };
    await assert.rejects(
      waitForStockSupervisor(starting, async () => replacement, expected, t.signal),
      /supervisor container identity changed/,
    );
  });
  await t.test("reports the last waiting reason when startup does not finish", async (t) => {
    await assert.rejects(
      waitForStockSupervisor(pending, noRead, expected, t.signal, 25),
      /did not become ready within 25 ms \(phase=Pending, reason=ContainerCreating/,
    );
    const cancellation = new Error("cancelled fixture");
    await assert.rejects(
      waitForStockSupervisor(pending, noRead, expected, AbortSignal.abort(cancellation)),
      (error) => error === cancellation,
    );
  });
});
