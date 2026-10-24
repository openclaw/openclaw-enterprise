import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import {
  InstalledDriver,
  OpenClawController,
  PostgresWorkQueue,
  ResourceStateConflictError,
} from "../../packages/occ/src/index.ts";
import { waitFor } from "../helpers/wait-for.mjs";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { expireWorkLease } from "../helpers/postgres-worker-revision-support.mjs";

async function createPolicyApp(t, recordOperations = false, { laxDriver = false } = {}) {
  const grant = {
    id: "python-demo",
    binary: "/usr/bin/python3.11",
    host: "example.org",
    ports: [{ from: 443, to: 443 }],
  };
  const providerRefusalGrant = {
    ...grant,
    id: "wide-ports",
    host: "ports.example.org",
    ports: [{ from: 1, to: 2048 }],
  };
  // The real Driver validates and freezes policy; this case proves HTTP/IAM/PostgreSQL admission,
  // while the OpenShell runtime lane proves enforcement and loaded-version application.
  const sandboxConfiguration = {
    gateway: { workspaceMode: "operator" },
    kubernetes: {
      runtimeClassName: "openshell-sandbox",
      serviceAccount: { mode: "gatewayConfigured" },
      sandboxDataMount: {
        subPath: "workspace",
        mountPath: "/sandbox/enterprise",
        readOnly: false,
      },
    },
    policy: {
      process: { runAsUser: "1000", runAsGroup: "1000" },
      networkPolicies: [
        {
          name: "python-default",
          binaries: [{ path: grant.binary }],
          endpoints: [{ host: "example.com", ports: [443], tls: "skip" }],
        },
      ],
    },
  };
  const sandboxDriver = new OpenShellSandboxDriver(sandboxConfiguration, {
    id: "policy-openshell",
    implementation: "openshell",
    backend: {
      id: "openshell",
      drivers: { sandbox: "policy-openshell", credential_gateway: "policy-credentials" },
      client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
    },
  });
  let definition = OpenShellSandboxDriver;
  if (laxDriver) {
    // A package Driver may declare a looser contribution and skip its own recheck. OCC still
    // owns the stored grant shape and the ceiling, so its shared rules must hold regardless.
    sandboxDriver.admitNetworkPolicy = (additions, version, defaults) => ({
      driverId: sandboxDriver.id,
      implementation: sandboxDriver.implementation,
      version,
      defaults: defaults ?? {},
      additions,
    });
    definition = {
      configurationSchema: OpenShellSandboxDriver.configurationSchema,
      validateConfiguration: (input) => OpenShellSandboxDriver.validateConfiguration(input),
      configurationContributions: [
        {
          scope: "agent",
          key: "sandbox-network-policy",
          configurationSchema: { type: "object", properties: { additions: { type: "array" } } },
          validateConfiguration: () => [],
        },
      ],
    };
  }
  const fixture = await createPostgresAgentApp(t, {
    label: "sandbox-policy",
    authSecret: "sandbox-policy-postgres-session-secret-32-characters",
    sandboxDriver,
    controllerOptions: {
      sandboxNetworkPolicyCeiling: [grant, providerRefusalGrant],
      recordOperations,
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: sandboxDriver.id,
          implementation: sandboxDriver.implementation,
          definition,
        },
      ],
    },
  });
  return { ...fixture, grant, providerRefusalGrant, sandboxDriver, sandboxConfiguration };
}

test(
  "policy admission cannot acquire grants from a Driver snapshot",
  requiresPostgres,
  async (t) => {
    const fixture = await createPolicyApp(t);
    const {
      controller,
      state,
      pool,
      inject,
      deployAgent,
      grant,
      sandboxDriver,
      sandboxConfiguration,
    } = fixture;
    const second = { ...grant, id: "second", host: "second.example.org" };
    const cases = [
      { name: "empty", ceiling: [], input: [], allowed: true },
      { name: "within ceiling", ceiling: [grant], input: [grant], allowed: true },
      { name: "explicit over ceiling", ceiling: [], input: [grant], code: "OUTSIDE_CEILING" },
      { name: "Driver adds over ceiling", ceiling: [], input: [], replacement: [grant] },
      { name: "Driver adds within ceiling", ceiling: [grant], input: [], replacement: [grant] },
      { name: "Driver removes grants", ceiling: [grant], input: [grant], replacement: [] },
      {
        name: "Driver reorders grants",
        ceiling: [grant, second],
        input: [grant, second],
        replacement: [second, grant],
      },
      ...[
        "driverId",
        "implementation",
        "version",
        "null defaults",
        "array defaults",
        "missing defaults",
        "mutate input",
      ].map((fault) => ({ name: `Driver ${fault}`, ceiling: [grant], input: [grant], fault })),
      {
        name: "Driver later mutation",
        ceiling: [grant],
        input: [grant],
        fault: "later mutation",
        allowed: true,
      },
      {
        name: "Driver accessor snapshot",
        ceiling: [grant],
        input: [grant],
        fault: "accessor",
        allowed: true,
      },
      { name: "protected empty", ceiling: [], input: [], protected: true, allowed: true },
      {
        name: "protected Driver adds",
        ceiling: [],
        input: [],
        replacement: [grant],
        protected: true,
      },
      { name: "protected caller adds", ceiling: [grant], input: [grant], protected: true },
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        // Deploy with the authentic Driver before introducing the faulty admission response.
        const { namespace, agent } = await deployAgent(`Integrity ${scenario.name}`);
        const restarted = new OpenClawController(controller.installation, {
          state,
          recordOperations: true,
          sandboxNetworkPolicyCeiling: scenario.ceiling,
          driverConfigurations: [
            {
              capability: "sandbox",
              driverId: sandboxDriver.id,
              implementation: sandboxDriver.implementation,
              definition: OpenShellSandboxDriver,
            },
          ],
        });
        for (const capability of ["iam", "configuration", "compute", "secret"]) {
          const driver = controller.selectedDriver(capability);
          restarted.registerDriver(driver);
          restarted.selectDriver(capability, driver.id);
        }
        if (scenario.protected) {
          const proxyConfiguration = { middlewareName: "integrity", authorityScope: "execution" };
          const proxy = new OpenShellCredentialProxyDriver(proxyConfiguration, {
            id: sandboxDriver.id,
            sandbox: sandboxDriver,
            backend: {
              id: "openshell",
              drivers: { sandbox: sandboxDriver.id, credential_proxy: sandboxDriver.id },
              client: new OpenShellGateway({ serviceName: "openshell-gateway" }),
            },
          });
          restarted.installDriver(
            new InstalledDriver(
              {
                id: sandboxDriver.id,
                implementation: "openshell",
                configuration: { sandbox: sandboxConfiguration, proxy: proxyConfiguration },
              },
              { capabilities: { sandbox: sandboxDriver, credential_proxy: proxy } },
            ),
            ["sandbox", "credential_proxy"],
          );
        } else {
          restarted.registerDriver(sandboxDriver);
          restarted.selectDriver("sandbox", sandboxDriver.id);
        }
        const app = fixture.createApp(restarted);
        const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
        const enabled = await inject("PATCH", `${path}/editing`, { enabled: true }, app);
        assert.equal(enabled.statusCode, 200, enabled.body);
        const policy = () =>
          state.read((view) => view.sandboxPolicies.find(namespace.id, agent.id));
        const revisions = () =>
          state.read((view) => view.revisions.listRevisions(namespace.id, agent.id));
        const jobs = async () =>
          (
            await pool.query(
              "SELECT * FROM occ.controller_work WHERE namespace_id=$1 ORDER BY idempotency_key",
              [namespace.id],
            )
          ).rows;
        const before = await policy();
        const beforeRevisions = await revisions();
        const beforeJobs = await jobs();
        const admit = sandboxDriver.admitNetworkPolicy;
        let admissions = 0;
        let snapshotReads = 0;
        sandboxDriver.admitNetworkPolicy = function (...args) {
          admissions++;
          if (scenario.fault === "mutate input") {
            args[0][0].host = "unapproved.example.org";
          }
          const snapshot = structuredClone(admit.apply(this, args));
          if (scenario.fault === "driverId") {
            snapshot.driverId = "wrong-driver";
          }
          if (scenario.fault === "implementation") {
            snapshot.implementation = "wrong-implementation";
          }
          if (scenario.fault === "version") {
            snapshot.version++;
          }
          if (scenario.fault === "null defaults") {
            snapshot.defaults = null;
          }
          if (scenario.fault === "array defaults") {
            snapshot.defaults = [];
          }
          if (scenario.fault === "missing defaults") {
            delete snapshot.defaults;
          }
          if (scenario.fault === "later mutation") {
            queueMicrotask(() => {
              snapshot.additions[0].host = "unapproved.example.org";
              snapshot.additions[0].ports[0].to = 444;
            });
          }
          if (scenario.fault === "accessor") {
            let reads = 0;
            Object.defineProperty(snapshot, "additions", {
              enumerable: true,
              get() {
                snapshotReads++;
                return ++reads === 1 ? scenario.input : [second];
              },
            });
          }
          // Keep authentic admission, then perturb only the selected snapshot field.
          return scenario.replacement === undefined
            ? snapshot
            : { ...snapshot, additions: scenario.replacement };
        };
        try {
          if (scenario.name === "within ceiling") {
            let getterReads = 0;
            const raw = {
              ...grant,
              get host() {
                getterReads++;
                return grant.host;
              },
            };
            // HTTP serialization would consume the getter before OCC can reject it.
            await assert.rejects(
              restarted.updateAgentSandboxPolicy(
                fixture.principal.id,
                namespace.id,
                agent.id,
                "networking",
                before.version,
                [raw],
              ),
              (error) => {
                assert.ok(error instanceof ResourceStateConflictError);
                assert.ok(error.details?.some(({ code }) => code === "INVALID_TYPE"));
                return true;
              },
            );
            assert.equal(getterReads, 0);
            assert.equal(admissions, 0);
            assert.deepEqual(await policy(), before);
            assert.deepEqual(await revisions(), beforeRevisions);
            assert.deepEqual(await jobs(), beforeJobs);
          }
          const body = { expectedVersion: before.version, additions: scenario.input };
          const preview = await inject("POST", `${path}/validate`, body, app);
          assert.deepEqual(await policy(), before, "preview must never write policy");
          // Exercise save as well before asserting either refusal: old source persisted
          // Driver-added grants even where protected preview had already refused them.
          const save = await inject("PUT", path, body, app);
          if (scenario.allowed) {
            assert.equal(preview.statusCode, 200, preview.body);
            assert.equal(preview.json().data.success, true, preview.body);
            assert.deepEqual(preview.json().data.data.additions, scenario.input);
            assert.equal(save.statusCode, 200, save.body);
            assert.deepEqual((await policy()).additions, scenario.input);
            assert.equal((await policy()).version, before.version + 1);
          } else {
            assert.deepEqual(await policy(), before, "refusal must not persist any policy change");
            assert.equal(save.statusCode, 409, save.body);
            if (scenario.protected && scenario.input.length > 0) {
              assert.equal(preview.statusCode, 409, preview.body);
            } else {
              assert.equal(preview.statusCode, 200, preview.body);
              assert.equal(preview.json().data.success, false, preview.body);
              assert.ok(
                preview
                  .json()
                  .data.error.details.some(
                    ({ code }) => code === (scenario.code ?? "INVALID_VALUE"),
                  ),
              );
            }
            if (scenario.code === "OUTSIDE_CEILING") {
              assert.equal(admissions, 0, "OCC must refuse the caller before Driver admission");
            } else if (scenario.replacement !== undefined || scenario.fault !== undefined) {
              assert.equal(
                admissions,
                2,
                "both preview and save must inspect the faulty Driver result",
              );
            }
          }
          if (scenario.fault === "accessor") {
            assert.equal(snapshotReads, 2);
          }
          if (scenario.fault !== undefined) {
            assert.equal(admissions, 2);
          }
          assert.deepEqual(await revisions(), beforeRevisions);
          assert.deepEqual(await jobs(), beforeJobs);
        } finally {
          sandboxDriver.admitNetworkPolicy = admit;
        }
      });
    }
  },
);

test(
  "deployment cannot acquire grants from an empty Driver request",
  requiresPostgres,
  async (t) => {
    const fixture = await createPolicyApp(t);
    const { controller, state, pool, inject, deployAgent, grant, sandboxDriver } = fixture;
    for (const scenario of [
      { name: "saved empty", allowed: true },
      { name: "simulated missing-row read", absent: true, allowed: true },
      { name: "Driver adds to saved empty", injectGrant: true },
      { name: "Driver adds under simulated missing-row read", absent: true, injectGrant: true },
      { name: "Driver returns wrong version", wrongVersion: true },
      { name: "Driver throws private error", producerError: "error" },
      { name: "Driver throws null", producerError: "null" },
      {
        name: "registered external Sandbox without policy support",
        noAdmission: true,
        allowed: true,
      },
    ]) {
      await t.test(scenario.name, async () => {
        const { namespace, agent } = await deployAgent(`Deployment integrity ${scenario.name}`);
        let missingRowReads = 0;
        // Agent creation persists a policy row; occ_app intentionally cannot DELETE it.
        // Simulate only this exact Agent's legacy missing-row observation. All revision,
        // operation and other state calls still use the real PostgreSQL transaction.
        const withMissingRowRead = (view) =>
          Object.create(view, {
            sandboxPolicies: {
              value: Object.create(view.sandboxPolicies, {
                find: {
                  value: async (namespaceId, agentId) => {
                    const actual = await view.sandboxPolicies.find(namespaceId, agentId);
                    if (namespaceId === namespace.id && agentId === agent.id) {
                      assert.ok(actual, "the real PostgreSQL policy row must remain present");
                      assert.deepEqual(actual.additions, []);
                      missingRowReads++;
                      return undefined;
                    }
                    return actual;
                  },
                },
              }),
            },
          });
        const observedState = scenario.absent
          ? {
              read: (work) => state.read((view) => work(withMissingRowRead(view))),
              transact: (work) => state.transact((unit) => work(withMissingRowRead(unit))),
            }
          : state;
        const restarted = new OpenClawController(controller.installation, {
          state: observedState,
          recordOperations: true,
          sandboxNetworkPolicyCeiling: [],
          driverConfigurations: [
            {
              capability: "sandbox",
              driverId: sandboxDriver.id,
              implementation: sandboxDriver.implementation,
              definition: OpenShellSandboxDriver,
            },
          ],
        });
        const admit = sandboxDriver.admitNetworkPolicy;
        let admissions = 0;
        let expectedDefaults;
        // Keep the authentic selected Driver's identity/capability contract. Only alter
        // returned additions for faulty-admission cases, before the HTTP request.
        sandboxDriver.admitNetworkPolicy = function (...args) {
          admissions++;
          assert.deepEqual(args[0], []);
          assert.equal(args[1], 1, "empty policy and simulated missing-row fallback use version 1");
          if (scenario.producerError === "error") {
            throw new Error("PRIVATE_PRODUCER_DETAIL");
          }
          if (scenario.producerError === "null") {
            throw null;
          }
          const snapshot = admit.apply(this, args);
          expectedDefaults = snapshot.defaults;
          if (scenario.wrongVersion) {
            return { ...snapshot, version: snapshot.version + 1 };
          }
          return scenario.injectGrant ? { ...snapshot, additions: [grant] } : snapshot;
        };
        try {
          for (const capability of ["iam", "configuration", "compute", "secret"]) {
            const driver = controller.selectedDriver(capability);
            restarted.registerDriver(driver);
            restarted.selectDriver(capability, driver.id);
          }
          if (scenario.noAdmission) {
            // Use the existing external package's genuine Sandbox capability, with its
            // real factory validation. Neither optional policy member is implemented.
            const external =
              await import("../fixtures/driver-packages/protected-execution-driver/index.ts");
            const registration = external.createDriver({
              id: "deployment-no-policy",
              implementation: "deployment-no-policy-fixture",
              configuration: {
                endpoint: "https://127.0.0.1:443",
                ca: "unused-admission-fixture-ca",
              },
            });
            t.after(() => registration.close?.());
            const driver = registration.capabilities.sandbox;
            assert.ok(driver);
            assert.equal(driver.networkPolicy, undefined);
            assert.equal(driver.admitNetworkPolicy, undefined);
            restarted.registerDriver(driver);
            restarted.selectDriver("sandbox", driver.id);
            assert.equal(restarted.selectedDriver("sandbox"), driver);
          } else {
            restarted.registerDriver(sandboxDriver);
            restarted.selectDriver("sandbox", sandboxDriver.id);
            assert.equal(restarted.selectedDriver("sandbox"), sandboxDriver);
          }
          const app = fixture.createApp(restarted);
          const policy = () =>
            state.read((view) => view.sandboxPolicies.find(namespace.id, agent.id));
          const revisions = () =>
            state.read((view) => view.revisions.listRevisions(namespace.id, agent.id));
          const jobs = async () =>
            (
              await pool.query(
                "SELECT * FROM occ.controller_work WHERE namespace_id=$1 ORDER BY idempotency_key",
                [namespace.id],
              )
            ).rows;
          const beforePolicy = await policy();
          assert.ok(
            beforePolicy,
            "actual PostgreSQL row exists, including simulated missing-row cases",
          );
          assert.deepEqual(beforePolicy.additions, []);
          const beforeRevisions = await revisions();
          const beforeJobs = await jobs();
          const response = await inject(
            "POST",
            `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
            undefined,
            app,
          );
          assert.equal(response.body.includes("PRIVATE_PRODUCER_DETAIL"), false);
          const afterRevisions = await revisions();
          const afterJobs = await jobs();
          assert.deepEqual(
            await policy(),
            beforePolicy,
            "deployment must not rewrite the saved policy",
          );
          if (scenario.allowed) {
            assert.equal(response.statusCode, 202, response.body);
            const added = afterRevisions.filter(
              ({ id }) => !beforeRevisions.some((row) => row.id === id),
            );
            assert.equal(added.length, 1, "the HTTP request must persist a real revision");
            assert.equal(added[0].id, response.json().data.id);
            assert.equal(added[0].executionAdmission.mode, "unprotected");
            if (scenario.noAdmission) {
              assert.equal(added[0].sandboxDriverId, "deployment-no-policy");
              assert.equal(added[0].sandboxPolicy, undefined);
            } else {
              assert.deepEqual(added[0].sandboxPolicy.additions, []);
              assert.deepEqual(added[0].sandboxPolicy.defaults, expectedDefaults);
            }
            assert.ok(
              afterJobs.length > beforeJobs.length,
              "successful deployment must queue reconciliation",
            );
          } else {
            assert.deepEqual(
              afterRevisions,
              beforeRevisions,
              "refusal must not write any revision",
            );
            assert.deepEqual(afterJobs, beforeJobs, "refusal must not queue work");
            assert.equal(response.statusCode, 409, response.body);
            assert.equal(
              response.json().error.message,
              "The Sandbox Driver cannot enforce the complete requested policy.",
            );
            assert.deepEqual(response.json().error.details, [
              {
                path: "",
                code: "INVALID_VALUE",
                message: "The selected Driver could not validate the configuration.",
              },
            ]);
            assert.ok(
              !response.body.includes(grant.host),
              "diagnostics must not echo Driver grants",
            );
          }
          assert.equal(admissions, scenario.noAdmission ? 0 : 1);
          assert.equal(missingRowReads > 0, scenario.absent === true);
        } finally {
          sandboxDriver.admitNetworkPolicy = admit;
        }
      });
    }
  },
);

test(
  "Agent policy HTTP admission persists bounded grants without changing an admitted revision",
  requiresPostgres,
  async (t) => {
    const { pool, state, inject, deployAgent, grant, providerRefusalGrant } =
      await createPolicyApp(t);
    const { namespace, agent, revision } = await deployAgent("Sandbox policy");
    const base = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
    const read = await inject("GET", base);
    assert.equal(read.statusCode, 200, read.body);
    const original = read.json().data.policy;
    // A facet is mandatory; unsupported facets cannot read or mutate the network policy.
    assert.equal((await inject("GET", base.replace("/networking", ""))).statusCode, 404);
    for (const facet of ["filesystem", "process"]) {
      const unsupported = base.replace("/networking", `/${facet}`);
      assert.equal((await inject("GET", unsupported)).statusCode, 409);
      assert.equal(
        (await inject("PUT", unsupported, { expectedVersion: 1, additions: [grant] })).statusCode,
        409,
      );
    }

    assert.equal(read.json().data.editingEnabled, false);
    assert.deepEqual(original.additions, []);
    assert.deepEqual(revision.sandboxPolicy.additions, []);
    assert.deepEqual(read.json().data.defaults, revision.sandboxPolicy.defaults);

    // The general Agent endpoint cannot bypass the separately administered editing flag.
    const bypass = await inject("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
      sandboxPolicyEditing: true,
    });
    assert.equal(bypass.statusCode, 400, bypass.body);

    const disabled = await inject("PUT", base, { expectedVersion: 1, additions: [grant] });
    assert.equal(disabled.statusCode, 409, disabled.body);
    const enabled = await inject("PATCH", `${base}/editing`, { enabled: true });
    assert.equal(enabled.statusCode, 200, enabled.body);
    // Discovery returns owner URLs and schema only, with exact-resource authorization.
    const discoveryPath = `/namespaces/${namespace.id}/agents/${agent.id}/driver-configurations`;
    const discovery = await inject("GET", discoveryPath);
    assert.equal(discovery.statusCode, 200, discovery.body);
    const descriptor = discovery.json().data.configurations[0];
    assert.equal(descriptor.driverId, "policy-openshell");
    assert.equal(descriptor.key, "sandbox-network-policy");
    assert.equal(descriptor.actions.validate.href, `${base}/validate`);
    assert.equal(descriptor.actions.save.available, true);
    assert.deepEqual((await inject("GET", base)).json().data.configuration, descriptor);
    const installationDiscovery = await inject("GET", "/installation/driver-configurations");
    assert.equal(installationDiscovery.statusCode, 200, installationDiscovery.body);
    assert.equal(installationDiscovery.json().data.configurations[0].key, "startup");
    assert.deepEqual(installationDiscovery.json().data.configurations[0].actions, {});
    assert.equal(
      Object.hasOwn(installationDiscovery.json().data.configurations[0], "configuration"),
      false,
    );
    const beforePreview = await pool.query(
      "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
      [namespace.id],
    );
    const invalid = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 70000, to: "bad" }], host: "bad..host" }],
    });
    assert.equal(invalid.statusCode, 200, invalid.body);
    assert.equal(invalid.json().data.success, false);
    assert.ok(
      invalid.json().data.error.details.some(({ path }) => path === "/additions/0/ports/0/from"),
    );
    assert.ok(
      invalid.json().data.error.details.some(({ path }) => path === "/additions/0/ports/0/to"),
    );
    const invalidEnvelope = await inject("POST", `${base}/validate`, {
      expectedVersion: "wrong",
      additions: [],
    });
    assert.equal(invalidEnvelope.statusCode, 400, invalidEnvelope.body);
    const providerRefusal = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [providerRefusalGrant],
    });
    assert.equal(providerRefusal.statusCode, 200, providerRefusal.body);
    assert.equal(providerRefusal.json().data.success, false);
    assert.equal(providerRefusal.json().data.error.details[0].path, "/additions");
    const preview = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [grant],
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().data, { success: true, data: { additions: [grant] } });
    const range = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 444, to: 443 }] }],
    });
    assert.equal(range.json().data.error.details[0].code, "INVALID_RANGE");
    assert.equal((await inject("GET", base)).json().data.policy.version, 1);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
          [namespace.id],
        )
      ).rows,
      beforePreview.rows,
    );

    const broad = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, host: "*.example.org" }],
    });
    assert.equal(broad.statusCode, 409, broad.body);
    const wrongBinary = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, binary: "/usr/bin/python3" }],
    });
    assert.equal(wrongBinary.statusCode, 409, wrongBinary.body);
    const wrongPort = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 443, to: 444 }] }],
    });
    assert.equal(wrongPort.statusCode, 409, wrongPort.body);

    const changed = await inject("PUT", base, { expectedVersion: 1, additions: [grant] });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().data.version, 2);
    assert.deepEqual(changed.json().data.additions, [grant]);
    const stale = await inject("PUT", base, { expectedVersion: 1, additions: [] });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(
      (await inject("POST", `${base}/validate`, { expectedVersion: 1, additions: [grant] }))
        .statusCode,
      409,
    );
    assert.deepEqual(
      (await state.read((view) => view.revisions.findRevision(namespace.id, agent.id, revision.id)))
        .sandboxPolicy.additions,
      [],
      "saving a policy must preserve immutable deployment evidence",
    );

    // Disabling edits preserves approved grants; explicit redeployment consumes the desired policy.
    const off = await inject("PATCH", `${base}/editing`, { enabled: false });
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual((await inject("GET", base)).json().data.policy.additions, [grant]);
    assert.equal(
      (await inject("PUT", base, { expectedVersion: 2, additions: [] })).statusCode,
      409,
    );
    const deployed = await inject("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`);
    assert.equal(deployed.statusCode, 202, deployed.body);
    const saved = await state.read((view) =>
      view.revisions.findRevision(namespace.id, agent.id, deployed.json().data.id),
    );
    assert.deepEqual(saved.sandboxPolicy.additions, [grant]);
    assert.equal(saved.sandboxPolicy.version, 2);
    assert.deepEqual(saved.sandboxPolicy.defaults, revision.sandboxPolicy.defaults);

    // Database ownership and document constraints protect persistence even outside HTTP admission.
    await assert.rejects(
      pool.query(
        "UPDATE occ.sandbox_policies SET document = jsonb_set(document,'{agentId}',to_jsonb($2::text)) WHERE id = $1",
        [original.id, `agt_${randomUUID()}`],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      pool.query(
        "UPDATE occ.sandbox_policies SET document = jsonb_set(document,'{additions}', $2::jsonb) WHERE id = $1",
        [original.id, JSON.stringify([{ ...grant, ports: [{ from: 444, to: 443 }] }])],
      ),
      { code: "23514" },
    );
    await inject("PATCH", `${base}/editing`, { enabled: true });
    // Agent update authority cannot substitute for the independent policy-resource check.
    const restriction = `restriction-${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'update','sandbox_policy',$3,'deny')",
      [restriction, namespace.id, original.id],
    );
    assert.equal(
      (await inject("POST", `${base}/validate`, { expectedVersion: 2, additions: [grant] }))
        .statusCode,
      403,
    );
    const withoutEdit = (await inject("GET", discoveryPath)).json().data.configurations[0];
    assert.equal(withoutEdit.actions.save.available, false);
    // Owner read denial filters discovery without weakening the policy read endpoint.
    const readRestriction = `restriction-${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'read','sandbox_policy',$3,'deny')",
      [readRestriction, namespace.id, original.id],
    );
    assert.deepEqual((await inject("GET", discoveryPath)).json().data.configurations, []);
    assert.equal((await inject("GET", base)).statusCode, 403);
    const refused = await inject("PUT", base, { expectedVersion: 2, additions: [grant] });
    assert.equal(refused.statusCode, 403, refused.body);
    const denial = await pool.query(
      "SELECT actor_id FROM occ.audit_events WHERE kind = 'authorization_denial' AND details#>>'{__occAuditMetadata,authorization,resource,id}' = $1",
      [original.id],
    );
    assert.ok(denial.rowCount > 0, "the exact-resource authorization denial must be attributable");

    const other = await deployAgent("Independent policy authority");
    const otherBase = `/namespaces/${other.namespace.id}/agents/${other.agent.id}/sandbox-policy/networking`;
    const crossNamespace = await inject(
      "GET",
      `/namespaces/${namespace.id}/agents/${other.agent.id}/sandbox-policy/networking`,
    );
    assert.equal(crossNamespace.statusCode, 404, crossNamespace.body);
    assert.equal(
      (await inject("PATCH", `${otherBase}/editing`, { enabled: true })).statusCode,
      200,
    );
    // Policy-resource update permission alone cannot replace exact-Agent manage_policy.
    await pool.query(
      "INSERT INTO occ.iam_restrictions (id,namespace_id,action,resource_kind,resource_id,effect) VALUES ($1,$2,'manage_policy','agent',$3,'deny')",
      [`restriction-${randomUUID()}`, other.namespace.id, other.agent.id],
    );
    const agentRefused = await inject("PUT", otherBase, { expectedVersion: 1, additions: [grant] });
    assert.equal(agentRefused.statusCode, 403, agentRefused.body);
    assert.deepEqual((await inject("GET", otherBase)).json().data.policy.additions, []);
  },
);

test(
  "interrupted terminal policy recovery rolls back queue failure and a restarted worker finalizes it",
  requiresPostgres,
  async (t) => {
    const { pool, state, inject, deployAgent, grant } = await createPolicyApp(t, true);
    const { namespace, agent, revision } = await deployAgent("Interrupted policy recovery");
    await state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(namespace.id);
      await unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id);
    });
    const queue = new PostgresWorkQueue(pool, { maxAttempts: 1, leaseDurationMs: 50 });
    // Prior lifecycle work has completed; the active revision is the exact application target.
    for (let claim = await queue.claim(); claim !== undefined; claim = await queue.claim()) {
      await queue.complete(claim);
    }
    const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
    assert.equal((await inject("PATCH", `${path}/editing`, { enabled: true })).statusCode, 200);
    assert.equal(
      (await inject("PUT", path, { expectedVersion: 1, additions: [grant] })).statusCode,
      200,
    );
    const admitted = await inject("POST", `${path}/apply`, {
      expectedVersion: 2,
      revisionId: revision.id,
    });
    assert.equal(admitted.statusCode, 202, admitted.body);
    const claim = await queue.claim();
    assert.equal(claim.agentTarget, "sandbox_policy");
    await expireWorkLease(pool, claim.idempotencyKey);

    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM occ.sandbox_policies WHERE agent_id=$1 FOR UPDATE", [
      agent.id,
    ]);
    const workers = [];
    const start = async () => {
      const name = `policy-recovery-${randomUUID()}`;
      const worker = createControllerWorker({
        pool: new pg.Pool({ connectionString: databaseUrl, application_name: name }),
        computeDriver: createDevelopmentComputeDriver(),
        maxAttempts: 1,
        pollIntervalMs: 30_000,
        emit() {},
      });
      workers.push(worker);
      await worker.start();
      return { worker, name };
    };
    try {
      const interrupted = await start();
      // Hold finalization after the terminal queue UPDATE. Terminating that real PostgreSQL
      // session simulates losing the worker between writes, without replacing queue behavior.
      const pid = await waitFor("policy finalization blocked after queue recovery", async () => {
        const result = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%sandbox_policies%'",
          [interrupted.name],
        );
        return result.rows[0]?.pid;
      });
      await pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await interrupted.worker.stop();
      assert.equal(
        (await queue.findWork(claim.idempotencyKey)).state,
        "claimed",
        "the interrupted transaction must preserve recoverable work",
      );
      assert.equal((await inject("GET", path)).json().data.policy.application.state, "pending");
      await blocker.query("ROLLBACK");

      const recovered = await start();
      await waitFor("restarted worker finalizes abandoned application", async () => {
        const policy = (await inject("GET", path)).json().data.policy;
        return policy.application.state === "failed" ? policy : undefined;
      });
      await recovered.worker.stop();
      assert.equal((await queue.findWork(claim.idempotencyKey)).state, "failed_permanent");
      const audit = await pool.query(
        "SELECT actor_id FROM occ.audit_events WHERE action='openclaw.agents.sandbox_policy.application' AND resource_id=$1",
        [admitted.json().data.id],
      );
      assert.equal(audit.rowCount, 1, "terminal recovery emits one attributable policy failure");
      assert.equal(audit.rows[0].actor_id, claim.actorId);
      const next = await inject("PUT", path, { expectedVersion: 2, additions: [] });
      assert.equal(next.statusCode, 200, next.body);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      for (const worker of workers) {
        await worker.stop();
      }
    }
  },
);

test(
  "a looser Driver contribution cannot widen the shared grant rules or the ceiling",
  requiresPostgres,
  async (t) => {
    const { inject, deployAgent, grant } = await createPolicyApp(t, false, { laxDriver: true });
    const { namespace, agent } = await deployAgent("Lax policy Driver");
    const base = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
    assert.equal((await inject("PATCH", `${base}/editing`, { enabled: true })).statusCode, 200);
    // The shared rules refuse an empty port list before ceiling coverage is considered.
    const empty = await inject("POST", `${base}/validate`, {
      expectedVersion: 1,
      additions: [{ ...grant, host: "outside.example.net", ports: [] }],
    });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json().data.error.details, [
      {
        path: "/additions/0/ports",
        code: "INVALID_VALUE",
        message: "Configuration does not satisfy minItems.",
      },
    ]);
    // A reversed range on a delegated executable and host is refused, not stored.
    const reversed = await inject("PUT", base, {
      expectedVersion: 1,
      additions: [{ ...grant, ports: [{ from: 65535, to: 1 }] }],
    });
    assert.equal(reversed.statusCode, 409, reversed.body);
    assert.deepEqual(reversed.json().error.details, [
      {
        path: "/additions/0/ports/0/to",
        code: "INVALID_RANGE",
        message: "The end port must be at least the start port.",
      },
    ]);
    const saved = (await inject("GET", base)).json().data.policy;
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.additions, []);
  },
);

test(
  "restarted controller rechecks a reduced ceiling before saving, applying, or deploying",
  requiresPostgres,
  async (t) => {
    const fixture = await createPolicyApp(t);
    const { state, controller, pool, inject, deployAgent, grant, sandboxDriver } = fixture;
    const { namespace, agent, revision } = await deployAgent("Ceiling restart");
    // The fixture activates a real admitted revision; this test proves HTTP admission, not provider effects.
    await state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(namespace.id);
      await unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id);
    });
    const path = `/namespaces/${namespace.id}/agents/${agent.id}/sandbox-policy/networking`;
    assert.equal((await inject("PATCH", `${path}/editing`, { enabled: true })).statusCode, 200);
    const preview = await inject("POST", `${path}/validate`, {
      expectedVersion: 1,
      additions: [grant],
    });
    assert.equal(preview.json().data.success, true);
    assert.equal(
      (await inject("PUT", path, { expectedVersion: 1, additions: [grant] })).statusCode,
      200,
    );
    const previous = (await inject("GET", path)).json().data.policy;
    const jobs = await pool.query(
      "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
      [namespace.id],
    );
    // Startup is the owner of the ceiling. A new controller uses the same database and real IAM,
    // with a smaller operator delegation; no mutable test hook changes the running controller.
    const restarted = new OpenClawController(controller.installation, {
      state,
      recordOperations: false,
      sandboxNetworkPolicyCeiling: [],
      driverConfigurations: [
        {
          capability: "sandbox",
          driverId: sandboxDriver.id,
          implementation: sandboxDriver.implementation,
          definition: OpenShellSandboxDriver,
        },
      ],
    });
    for (const capability of ["iam", "configuration", "compute", "secret", "sandbox"]) {
      const driver = controller.selectedDriver(capability);
      restarted.registerDriver(driver);
      restarted.selectDriver(capability, driver.id);
    }
    const app = fixture.createApp(restarted);
    const revisions = await state.read((view) =>
      view.revisions.listRevisions(namespace.id, agent.id),
    );
    for (const [method, url, body] of [
      ["PUT", path, { expectedVersion: 2, additions: [grant] }],
      ["POST", `${path}/apply`, { expectedVersion: 2, revisionId: revision.id }],
      ["POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`, undefined],
    ]) {
      const refused = await inject(method, url, body, app);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(
        refused.json().error.message,
        "The requested network policy exceeds the Installation delegation ceiling.",
      );
      assert.deepEqual(refused.json().error.details, [
        {
          path: "/additions/0",
          code: "OUTSIDE_CEILING",
          message: "The grant exceeds the Installation delegation ceiling.",
        },
      ]);
    }
    assert.deepEqual(
      await state.read((view) => view.revisions.listRevisions(namespace.id, agent.id)),
      revisions,
    );
    assert.deepEqual((await inject("GET", path)).json().data.policy, previous);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT count(*) AS count FROM occ.controller_work WHERE namespace_id=$1",
          [namespace.id],
        )
      ).rows,
      jobs.rows,
    );
  },
);
