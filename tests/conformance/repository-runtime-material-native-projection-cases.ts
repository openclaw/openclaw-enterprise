import type { OpenClawConfigurationDocument } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  codexPluginState,
  openClawPluginState,
  runtimeBinding,
  fixture,
  present,
  recordField,
} from "./repository-runtime-material-fixture.ts";
import {
  parseRecord,
  preparedCodexManifest,
  preparedNativeDocument,
  deepFreeze,
} from "./repository-runtime-material-observations.ts";

test("Embedded OpenClaw repository bindings without Codex plugins do not receive broker policy", async () => {
  const f = await fixture("embedded");
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const codexRuntimeManifests = [...f.objects.values()].filter(
    (object) =>
      object.kind === "ConfigMap" &&
      object.metadata.namespace === f.namespace &&
      typeof object.data?.["runtime.json"] === "string",
  );
  assert.deepEqual(codexRuntimeManifests, []);
});

test("Embedded OpenClaw plugin runtime does not receive Codex broker policy", async () => {
  const f = await fixture("embedded");
  f.revision.plugins = openClawPluginState();
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const manifest = preparedCodexManifest(f);
  assert.equal(manifest.kind, "openclaw");
  assert.equal(manifest.repositoryBrokerNetworkPolicy, undefined);
});

test("An embedded OpenClaw revision pinned to Codex cannot mount the repository broker bridge", async () => {
  const f = await fixture("embedded");
  f.revision.plugins = codexPluginState();
  await assert.rejects(
    f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])),
    /dedicated Codex Harness/,
  );
  assert.equal(
    [...f.objects.values()].some((resource) => resource.kind === "Deployment"),
    false,
  );
});

// Both consumer shapes must trust the projected CA without disabling TLS verification.
for (const mode of ["embedded", "dedicated"] as const) {
  test(`Repository consumer projects a combined broker CA bundle (${mode})`, async () => {
    const f = await fixture(mode);
    const publicCa = Buffer.from(
      "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
    );
    await f.driver.prepareRevision(
      f.revision,
      f.context([runtimeBinding("session_with_ca", publicCa)]),
    );
    const environment = Object.fromEntries(
      f
        .requireConsumer()
        .spec.template.spec.containers[0].env.map(({ name, value }) => [name, value]),
    );
    assert.match(
      present(environment.SSL_CERT_FILE),
      /^\/run\/oce\/repository-credentials\/sessions\/[a-f0-9]{64}\/ca-bundle\.pem$/,
    );
    assert.equal(environment.GIT_SSL_CAINFO, environment.SSL_CERT_FILE);
    assert.equal(environment.NODE_EXTRA_CA_CERTS, environment.SSL_CERT_FILE);
  });
}

// OCC refuses a nonempty agents.list and the pinned OpenClaw Gateway rejects any list, so
// the projected roster is the keyed agents.entries.
test("Kubernetes projects the repository client into native exec paths without changing admitted configuration", async () => {
  const f = await fixture();
  const shim = "/opt/oce/repository-credentials/bin";
  f.revision.configuration.tools = {
    allow: ["exec", "process"],
    exec: {
      host: "gateway",
      mode: "full",
      timeoutSec: 120,
      pathPrepend: ["/operator/bin", shim, "/shared/bin", shim],
    },
  };
  f.revision.configuration.agents.ownership = "explicit";
  f.revision.configuration.agents.entries = {
    custom: {
      tools: {
        allow: ["exec"],
        exec: { host: "gateway", mode: "full", pathPrepend: ["/agent/bin", shim] },
      },
    },
    "own-exec": { tools: { exec: { mode: "full" } } },
    inherits: { tools: { allow: ["exec", "process"] } },
    plain: {},
  };
  const original = structuredClone(f.revision.configuration);
  deepFreeze(f.revision.configuration);

  // The actual runtime document must survive OpenClaw's exec environment
  // construction; setting only the Kubernetes container PATH is insufficient.
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  const expected = structuredClone(original);
  expected.models = {
    providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
  };
  recordField(recordField(expected, "tools"), "exec").pathPrepend = [
    shim,
    "/operator/bin",
    "/shared/bin",
  ];
  recordField(
    recordField(recordField(recordField(expected.agents, "entries"), "custom"), "tools"),
    "exec",
  ).pathPrepend = [shim, "/agent/bin"];
  recordField(
    recordField(recordField(recordField(expected.agents, "entries"), "own-exec"), "tools"),
    "exec",
  ).pathPrepend = [shim, "/operator/bin", "/shared/bin"];
  assert.deepEqual(parseRecord(preparedNativeDocument(f)), expected);
  assert.deepEqual(f.revision.configuration, original);
});

test("Kubernetes supplies a native repository exec prefix when no tools configuration exists", async (t) => {
  // OpenClaw drops an empty agents.list beside an implicit empty roster, so it passes through.
  for (const list of [undefined, []]) {
    await t.test(list === undefined ? "no list" : "empty list", async () => {
      const f = await fixture();
      if (list !== undefined) {
        f.revision.configuration.agents.list = list;
      }
      const original = structuredClone(f.revision.configuration);
      deepFreeze(f.revision.configuration);
      await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
      assert.deepEqual(parseRecord(preparedNativeDocument(f)), {
        ...original,
        models: {
          providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
        },
        tools: { exec: { pathPrepend: ["/opt/oce/repository-credentials/bin"] } },
      });
      assert.deepEqual(f.revision.configuration, original);
    });
  }
});

test("Kubernetes preserves native exec settings without repository bindings", async (t) => {
  for (const runtimeBindings of [undefined, []]) {
    await t.test(runtimeBindings === undefined ? "missing" : "empty", async () => {
      const f = await fixture();
      delete f.revision.repositoryCredentials;
      f.revision.configuration.tools = {
        allow: ["exec"],
        exec: { host: "gateway", mode: "full", pathPrepend: ["/operator/bin"] },
      };
      const document = JSON.stringify(f.revision.configuration);
      deepFreeze(f.revision.configuration);
      await f.driver.prepareRevision(f.revision, f.context(runtimeBindings));
      assert.deepEqual(parseRecord(preparedNativeDocument(f)), {
        ...parseRecord(document),
        models: {
          providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
        },
      });
      assert.equal(JSON.stringify(f.revision.configuration), document);
    });
  }
});

test("Kubernetes rejects malformed repository exec configuration before any API access", async (t) => {
  const rosterRefusal =
    "The OpenClaw Gateway rejects agents.list: remove it and configure each Agent under agents.entries, keyed by its Agent ID.";
  const malformed: Array<[string, OpenClawConfigurationDocument, string]> = [
    ["tools null", { tools: null }, "Repository credentials require tools to be an object."],
    ["tools array", { tools: [] }, "Repository credentials require tools to be an object."],
    [
      "exec string",
      { tools: { exec: "full" } },
      "Repository credentials require tools.exec to be an object.",
    ],
    [
      "exec null",
      { tools: { exec: null } },
      "Repository credentials require tools.exec to be an object.",
    ],
    [
      "exec array",
      { tools: { exec: [] } },
      "Repository credentials require tools.exec to be an object.",
    ],
    [
      "prefix scalar",
      { tools: { exec: { pathPrepend: "/operator/bin" } } },
      "Repository credentials require tools.exec.pathPrepend to be an array of strings.",
    ],
    [
      "prefix null",
      { tools: { exec: { pathPrepend: null } } },
      "Repository credentials require tools.exec.pathPrepend to be an array of strings.",
    ],
    [
      "prefix nonstring",
      { tools: { exec: { pathPrepend: ["/operator/bin", 1] } } },
      "Repository credentials require tools.exec.pathPrepend to be an array of strings.",
    ],
    ["agents null", { agents: null }, "Repository credentials require agents to be an object."],
    ["agents array", { agents: [] }, "Repository credentials require agents to be an object."],
    // The projection leaves agents.list to the roster refusal: the Gateway rejects every list.
    ["agent list object", { agents: { list: {} } }, rosterRefusal],
    ["agent list null", { agents: { list: null } }, rosterRefusal],
    ["agent list entry null", { agents: { list: [null] } }, rosterRefusal],
    [
      "agent list prefix nonstring",
      { agents: { list: [{ id: "main", tools: { exec: { pathPrepend: [false] } } }] } },
      rosterRefusal,
    ],
    [
      "agent entries null",
      { agents: { entries: null } },
      "Repository credentials require agents.entries to be an object.",
    ],
    [
      "agent entries array",
      { agents: { entries: [] } },
      "Repository credentials require agents.entries to be an object.",
    ],
    [
      "agent entry null",
      { agents: { entries: { main: null } } },
      "Repository credentials require agents.entries entry to be an object.",
    ],
    [
      "agent entry exec string",
      { agents: { entries: { main: { tools: { exec: "full" } } } } },
      "Repository credentials require agents.entries entry.tools.exec to be an object.",
    ],
    [
      "agent entry prefix nonstring",
      { agents: { entries: { main: { tools: { exec: { pathPrepend: [false] } } } } } },
      "Repository credentials require agents.entries entry.tools.exec.pathPrepend to be an array of strings.",
    ],
    [
      "agent entry array",
      { agents: { entries: { main: [] } } },
      "Repository credentials require agents.entries entry to be an object.",
    ],
    [
      "agent tools null",
      { agents: { entries: { main: { tools: null } } } },
      "Repository credentials require agents.entries entry.tools to be an object.",
    ],
    [
      "agent tools array",
      { agents: { entries: { main: { tools: [] } } } },
      "Repository credentials require agents.entries entry.tools to be an object.",
    ],
    [
      "agent exec null",
      { agents: { entries: { main: { tools: { exec: null } } } } },
      "Repository credentials require agents.entries entry.tools.exec to be an object.",
    ],
    [
      "agent exec array",
      { agents: { entries: { main: { tools: { exec: [] } } } } },
      "Repository credentials require agents.entries entry.tools.exec to be an object.",
    ],
    [
      "agent prefix scalar",
      { agents: { entries: { main: { tools: { exec: { pathPrepend: "/agent/bin" } } } } } },
      "Repository credentials require agents.entries entry.tools.exec.pathPrepend to be an array of strings.",
    ],
  ];
  for (const [name, configuration, message] of malformed) {
    await t.test(name, async () => {
      const f = await fixture();
      const agentDefaults = f.revision.configuration.agents.defaults;
      Object.assign(f.revision.configuration, structuredClone(configuration));
      if (configuration.agents && !Array.isArray(configuration.agents)) {
        recordField(f.revision.configuration, "agents").defaults = agentDefaults;
      }
      const before = structuredClone(f.revision.configuration);
      await assert.rejects(f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])), {
        message,
      });
      assert.deepEqual(
        f.apiCalls,
        [],
        "invalid native configuration must fail before Kubernetes reads or writes",
      );
      // Activation is a separate reconciliation entrypoint and must not bypass
      // the same native configuration validation before consulting workloads.
      await assert.rejects(f.driver.activateRevision(f.revision, f.context([runtimeBinding()])), {
        message,
      });
      assert.deepEqual(f.apiCalls, [], "activation must reject before Kubernetes reads or writes");
      assert.deepEqual(f.revision.configuration, before);
    });
  }
});

test("Kubernetes rejects invalid repository text before any API access", async (t) => {
  for (const [name, content] of [
    ["unpaired high surrogate", "\ud800"],
    ["unpaired low surrogate", "\udfff"],
    ["UTF-8 byte limit", "\u00e9".repeat(32 * 1024) + "a"],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture();
      const binding = runtimeBinding();
      binding.files["ca.pem"] = content;
      const document = parseRecord(binding.files["client.json"]);
      document.hasPublicCa = true;
      binding.files["client.json"] = JSON.stringify(document);
      // No Secret or workload may observe text that cannot be stored losslessly.
      await assert.rejects(f.driver.prepareRevision(f.revision, f.context([binding])), {
        message: "Repository credential material is invalid.",
      });
      assert.deepEqual(f.apiCalls, []);
    });
  }
});
