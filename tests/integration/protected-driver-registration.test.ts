import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentRevision,
  ComputeDriver,
  Driver,
  EgressInstallation,
  Namespace,
  SandboxHarnessStatusContext,
} from "../../packages/contracts/src/index.ts";
import { InstalledDriver, OpenClawController } from "../../packages/occ/src/index.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { ComputeLifecycleDispatcher } from "../../apps/controller/src/drivers/compute/lifecycle-hooks.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { routedRevision } from "../helpers/kubernetes-routed-scenarios.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";

test("one installed Driver owns both protected capabilities, lifecycle and verified release", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-protected-driver-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = "release-fixture";
  const entry = join(directory, "node_modules", id);
  await mkdir(entry, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ dependencies: { [id]: "1.0.0" } }),
  );
  await writeFile(
    join(entry, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", exports: "./index.mjs" }),
  );
  const fixture = new URL(
    "../fixtures/driver-packages/protected-execution-driver/index.ts",
    import.meta.url,
  );
  await writeFile(join(entry, "index.mjs"), stripTypeScriptTypes(await readFile(fixture, "utf8")));
  const { calls } = (await import(
    join(entry, "index.mjs")
  )) as typeof import("../fixtures/driver-packages/protected-execution-driver/index.ts");

  let installed: EgressInstallation;
  let trusted = true;
  const { cert, key, caBundle: ca } = await harnessTlsFixture(t);
  const peer = createServer({ cert, key }, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-supervisor");
    res.writeHead(trusted ? 200 : 401).end(JSON.stringify(installed));
  }).listen(0);
  t.after(() => new Promise<void>((resolve) => peer.close(() => resolve())));
  await once(peer, "listening");
  const endpoint = "https://localhost:" + (peer.address() as { port: number }).port;
  const base = createInstallationDriverConfiguration();
  const configuration = {
    ...base,
    presets: { includeDefaults: false },
    drivers: {
      ...base.drivers,
      sandbox: { id, package: id, configuration: { endpoint, ca } },
      credential_proxy: { id, configuration: {} },
    },
  };
  const path = join(directory, "installation.yaml");
  await writeFile(path, JSON.stringify(configuration));
  const load = () =>
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
      packageRoot: directory,
    });
  const api = (await load())!;
  const owner = api.protectedDriver!;
  assert.deepEqual(calls, { validate: 1, create: 1, lifecycle: 0, close: 0 });
  const controller = new OpenClawController({
    id: "installation",
    name: "installation",
    createdAt: "2026-10-01T00:00:00Z",
  });
  controller.installDriver(owner, ["sandbox", "credential_proxy"]);
  const sandbox = controller.selectedDriver("sandbox");
  const proxy = controller.selectedDriver("credential_proxy");
  assert.equal(sandbox, api.sandboxDriver);
  assert.equal(proxy, api.proxyDriver);
  assert.equal(sandbox.id, proxy.id);
  await controller.validateBackendConfiguration();
  assert.throws(
    () => controller.installDriver(owner, ["sandbox", "credential_proxy"]),
    /already registered/,
  );

  const scope = {
    installationId: "installation",
    namespaceId: "ns-fixture",
    agentId: "agent",
    revisionId: "revision",
    servicePrincipalId: "principal",
    executionId: "execution",
  };
  const plan = {
    id: "plan",
    generation: 1,
    execution: scope,
    driver: owner.ref,
    sandboxDriverId: id,
    egressDriverId: id,
    routes: [],
  };
  const admission = {
    executionAdmission: { version: 3, mode: "protected" },
    egressPlan: plan,
  } as const;
  api.computeDriver.validateExecutionAdmission!(admission, owner);
  // A worker loads its own instance, but reads the registration bound by the API admission.
  const worker = (await load())!;
  const check = worker.computeDriver.validateExecutionAdmission!.bind(worker.computeDriver);
  check(admission, "stored");
  assert.throws(() => check(admission, owner), /exact paired Compute release/);
  assert.throws(
    () =>
      check(
        {
          ...admission,
          egressPlan: { ...plan, driver: { ...owner.ref, configurationId: "a".repeat(64) } },
        },
        "stored",
      ),
    /exact paired Compute release/,
  );
  const { driver: _, ...legacyPlan } = plan;
  const legacy = {
    executionAdmission: { version: 2, mode: "protected" },
    egressPlan: legacyPlan,
  } as const;
  assert.throws(() => check(legacy, worker.protectedDriver), /exact paired Compute release/);
  assert.throws(() => check(legacy, "stored"), /exact paired Compute release/);
  assert.throws(
    () => check({ ...admission, egressPlan: legacyPlan }, "stored"),
    /registration in execution admission/,
  );

  // Drive the same configure, observe, commit, verify, enrollment and release boundary as Kubernetes.
  assert.throws(
    () =>
      new ProtectedExecutionDriver(
        new InstalledDriver({ ...owner.ref, configuration: {} }, { capabilities: { sandbox } }),
      ),
    /no longer supplies the selected capability/,
  );
  // Only installation composition that explicitly received the historical IDs can release a stored v2 plan.
  const previous = new InstalledDriver(
    { ...owner.ref, configuration: {} },
    { capabilities: { sandbox, credential_proxy: proxy } },
    { sandbox: sandbox.id, credential_proxy: proxy.id },
  );
  const compatibility = new ProtectedExecutionDriver(previous);
  assert.equal(compatibility.admits(legacy, "stored"), true);
  assert.equal(compatibility.admits(legacy, previous), false);

  const release = new ProtectedExecutionDriver(owner);
  const context = {
    plan,
    signal: t.signal,
    revision: {
      ...routedRevision(api.computeDriver),
      backendId: null,
      ...admission,
    } as AgentRevision,
    namespace: { id: scope.namespaceId } as Namespace,
  };
  const wiring = await release.configure(context);
  installed = {
    plan,
    sandboxId: "sandbox",
    sender: proxy.sourceControl.sender,
    installedAt: new Date().toISOString(),
    enforcement: {
      authorityScope: "execution",
      instanceId: "instance",
      configurationId: "policy-install",
      policyHash: "policy-hash",
      peerKeyId: "fixture-key",
    },
  };
  let committed: EgressInstallation | undefined;
  const custody = {
    recordEgressInstallation: async (value: EgressInstallation) => {
      committed = value;
    },
    currentEgressInstallation: async () => {
      if (!same) {
        installed = { ...installed, sandboxId: "replacement" };
      }
      return committed;
    },
  };
  let same = true;
  let releases = 0;
  const enroll = (prepared = wiring) =>
    release.enroll(
      context,
      prepared,
      custody,
      async () => true,
      async () =>
        ({
          revision: context.revision,
          namespace: context.namespace,
        }) as SandboxHarnessStatusContext,
      (startupId, current) => {
        assert.deepEqual(current, installed);
        releases++;
        return { startupId, sandboxId: current.sandboxId };
      },
    );
  assert.equal(await enroll(), true);
  assert.equal(releases, 1);
  same = false;
  await assert.rejects(enroll(), /exact current committed installation/);
  await assert.rejects(
    enroll({ ...wiring, plan: { ...plan, generation: 2 } }),
    /different protected egress plan/,
  );
  await assert.rejects(
    enroll({ ...wiring, configuration: { routes: ["https://other.invalid"] } }),
    /deny-all release profile/,
  );
  trusted = false;
  await assert.rejects(enroll(), /Unauthenticated fixture supervisor/);
  assert.equal(
    releases,
    1,
    "no release on changed runtime, substituted wiring or unauthenticated peer",
  );

  // Selection of the two capabilities installs one real Compute lifecycle owner.
  let hooks: readonly Driver[] = [];
  const seed: ComputeDriver = Object.assign(Object.create(api.computeDriver), {
    setLifecycleDrivers(selected: readonly Driver[]) {
      hooks = selected;
    },
  });
  controller.registerDriver(seed);
  controller.selectDriver("compute", seed.id);
  assert.equal(hooks.length, 1);
  await new ComputeLifecycleDispatcher(hooks).afterNamespacePrepared(context.namespace);
  assert.equal(calls.lifecycle, 1);

  // Two separate registrations cannot establish a protected Backend, even with the same IDs.
  const split = new OpenClawController(controller.installation);
  for (const view of [sandbox, proxy] as const) {
    split.registerDriver(view);
    split.selectDriver(view.capability, view.id);
  }
  await assert.rejects(split.validateBackendConfiguration(), /same registered Driver/);
  await Promise.all([owner.close(), owner.close()]);
  assert.equal(calls.close, 1);
  await Promise.all([worker.protectedDriver!.close(), worker.protectedDriver!.close()]);
  assert.equal(calls.close, 2);

  configuration.drivers.credential_proxy.id = "other-owner";
  await writeFile(path, JSON.stringify(configuration));
  await assert.rejects(load(), /same installed Driver as Sandbox/);
  configuration.drivers.credential_proxy.id = id;
  configuration.drivers.sandbox.configuration.endpoint = endpoint.replace("https:", "http:");
  await writeFile(path, JSON.stringify(configuration));
  await assert.rejects(load(), /Fixture peer must use TLS/);
});
