import assert from "node:assert/strict";
import test from "node:test";
import {
  BROKER_PROXY_DISABLED,
  BROKER_HOST_DENIED,
  BROKER_PROXY_DOMAINS,
} from "../helpers/refusal-text.mjs";
import {
  runtimeBinding,
  fixture,
  codexAppServer,
  recordField,
  jsonRecord,
  type MaterialConfiguration,
} from "./repository-runtime-material-fixture.ts";
import {
  preparedCodexConfig,
  preparedCodexManifest,
  runtimeWrites,
} from "./repository-runtime-material-observations.ts";

test("Dedicated Codex repository bindings receive broker network policy centrally", async () => {
  const f = await fixture("dedicated", undefined, {
    repositoryNamespace: "123-control",
  });
  await f.driver.prepareRevision(
    f.revision,
    f.context([
      runtimeBinding(
        "session_custom_control",
        undefined,
        "https://git.123-control.svc.cluster.local",
      ),
    ]),
  );
  const config = preparedCodexConfig(f);
  assert.match(config, /^\[features\]$/m);
  assert.doesNotMatch(config, /^\[network_proxy\]$/m);
  assert.doesNotMatch(config, /^\[\[network\.private_endpoints\]\]$/m);
  assert.doesNotMatch(config, /privateEndpoints|private_endpoints|default_permissions/);
  assert.deepEqual(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, {
    host: "git.123-control.svc.cluster.local",
    domains: {},
  });
});

test("Dedicated Codex repository policy is independent of preset shape", async (t) => {
  for (const [name, configure] of [
    ["default", () => {}],
    [
      "swe",
      (configuration: MaterialConfiguration) => {
        configuration.agents.defaults.instructions = "Handle software engineering work.";
      },
    ],
    [
      "custom",
      (configuration: MaterialConfiguration) => {
        codexAppServer(configuration).networkProxy = {
          enabled: true,
          mode: "limited",
          domains: { "github.com": "allow" },
        };
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture("dedicated");
      configure(f.revision.configuration);
      await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
      const policy = recordField(preparedCodexManifest(f), "repositoryBrokerNetworkPolicy");
      assert.equal(policy.host, "git.credentials.svc.cluster.local");
      if (name === "custom") {
        assert.deepEqual(policy.domains, { "github.com": "allow" });
      }
    });
  }
});

test("Dedicated Codex repository policy preserves compatible domain decisions", async () => {
  const f = await fixture("dedicated");
  codexAppServer(f.revision.configuration).networkProxy = {
    enabled: true,
    mode: "limited",
    domains: { "GitHub.COM ": "allow", "*.credentials.svc.cluster.local": "deny" },
  };
  await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
  assert.deepEqual(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, {
    host: "git.credentials.svc.cluster.local",
    domains: { "github.com": "allow", "*.credentials.svc.cluster.local": "deny" },
  });
});

test("Dedicated Codex repository policy preserves an explicitly disabled network proxy", async () => {
  const f = await fixture("dedicated");
  codexAppServer(f.revision.configuration).networkProxy = { enabled: false };
  await assert.rejects(f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])), {
    message: BROKER_PROXY_DISABLED,
  });
  assert.deepEqual(
    runtimeWrites(f.calls),
    [],
    "explicit network-proxy disablement must fail before runtime configuration or workload writes",
  );
});

test("Dedicated Codex repository policy preserves explicit broker host denies", async () => {
  const f = await fixture("dedicated");
  // The Helm default broker host is git.<Namespace>.svc.<cluster domain>; a 63-character
  // Namespace name, the Kubernetes maximum, gives the longest realistic host.
  const host = `git.${"n".repeat(63)}.svc.cluster.local`;
  const networkProxy = (codexAppServer(f.revision.configuration).networkProxy ??= {});
  jsonRecord(networkProxy).domains = {
    [` ${host.toUpperCase()} `]: "deny",
    [host]: "allow",
  };
  await assert.rejects(
    f.driver.prepareRevision(
      f.revision,
      f.context([runtimeBinding(undefined, undefined, `https://${host}`)]),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, BROKER_HOST_DENIED);
      // Only preparation catches this deny, and the worker drops the whole
      // worker.compute-prepare-failed line when the message is over 256 characters
      // (apps/controller/src/worker.ts MAX_COMPUTE_FAILURE_MESSAGE_LENGTH): the text must fit.
      const diagnostic = f.driver.describePrepareRevisionFailure(error);
      assert.equal(diagnostic.message, BROKER_HOST_DENIED);
      assert.ok(diagnostic.message.length <= 256, `${diagnostic.message.length} characters`);
      return true;
    },
  );
  assert.deepEqual(
    runtimeWrites(f.calls),
    [],
    "explicit administrative denies must fail before runtime configuration or workload writes",
  );
});

test("Dedicated Codex repository policy accepts stock private-network settings", async (t) => {
  for (const [name, networkProxy] of [
    ["full mode", { enabled: true, mode: "full" }],
    ["local binding", { enabled: true, mode: "limited", allowLocalBinding: true }],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture("dedicated");
      codexAppServer(f.revision.configuration).networkProxy = networkProxy;
      await f.driver.prepareRevision(f.revision, f.context([runtimeBinding()]));
      assert.deepEqual(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, {
        host: "git.credentials.svc.cluster.local",
        domains: {},
      });
    });
  }
});

test("Dedicated Codex repository policy rejects malformed domain policy containers", async (t) => {
  for (const [name, networkProxy, reason] of [
    [
      "domains array",
      { enabled: true, mode: "limited", domains: ["github.com"] },
      { message: BROKER_PROXY_DOMAINS },
    ],
    [
      "domains scalar",
      { enabled: true, mode: "limited", domains: "github.com" },
      { message: BROKER_PROXY_DOMAINS },
    ],
  ] as const) {
    await t.test(name, async () => {
      const f = await fixture("dedicated");
      codexAppServer(f.revision.configuration).networkProxy = networkProxy;
      await assert.rejects(
        f.driver.prepareRevision(f.revision, f.context([runtimeBinding()])),
        reason,
      );
      assert.deepEqual(
        runtimeWrites(f.calls),
        [],
        "malformed explicit domain policy containers must fail before runtime configuration or workload writes",
      );
    });
  }
});

test("Dedicated Codex without repository bindings does not receive broker policy", async () => {
  const f = await fixture("dedicated");
  delete f.revision.repositoryCredentials;
  await f.driver.prepareRevision(f.revision, f.context(undefined));
  const config = preparedCodexConfig(f);
  assert.doesNotMatch(config, /private_endpoints/);
  assert.equal(preparedCodexManifest(f).repositoryBrokerNetworkPolicy, undefined);
});
