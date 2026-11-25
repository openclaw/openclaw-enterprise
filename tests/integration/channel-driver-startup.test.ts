import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveChannelRouting } from "../../apps/controller/src/drivers/channel/routing.ts";
import { createRuntimeAuthFixture } from "../browser/console-agents-runtime-auth-fixture.ts";
import { nativeValues } from "../browser/console-agents-browser-helpers.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  createInjectedControllerFixture,
  injectedRequest,
  readyNamespaceFixture,
} from "./occ-api-injected-fixture.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";

async function load(t: TestContext, channel?: unknown) {
  const configuration = createInstallationDriverConfiguration();
  if (channel !== undefined) {
    Object.assign(configuration.drivers, { channel });
  }
  const loaded = await loadInstallationFile(t, configuration);
  assert.ok(loaded);
  return loaded;
}

test("Installation startup installs every bundled Channel Driver when drivers.channel is omitted", async (t) => {
  const loaded = await load(t);
  assert.deepEqual(
    loaded.channelDrivers?.map(({ provider, driver }) => [provider, driver.id]),
    [["slack", "slack-channel"]],
  );
  // Startup inspection reports the resolved default selections like any other Driver.
  assert.deepEqual(
    loaded.installation.drivers.channel.map(({ id, configuration }) => [id, configuration]),
    [["slack-channel", {}]],
  );
  // Compute admission resolves enabled providers through this same set.
  assert.equal(
    resolveChannelRouting(["slack"], loaded.channelDrivers ?? []).drivers[0]?.id,
    "slack-channel",
  );
});

test("drivers.channel selects the installed providers", async (t) => {
  const loaded = await load(t, []);
  assert.deepEqual(loaded.channelDrivers, []);
  // Slack is not selected, so an Agent that enables it cannot be admitted.
  assert.throws(
    () => resolveChannelRouting(["slack"], loaded.channelDrivers ?? []),
    /exactly one installed Channel Driver/,
  );
});

test("drivers.channel rejects unknown, duplicate and malformed selections at startup", async (t) => {
  await assert.rejects(load(t, { id: "slack-channel" }), /drivers\.channel must be an array/);
  await assert.rejects(
    load(t, [{ id: "discord-channel", configuration: {} }]),
    /drivers\.channel\[0\]\.id must select a bundled Channel Driver: slack-channel/,
  );
  await assert.rejects(
    load(t, [
      { id: "slack-channel", configuration: {} },
      { id: "slack-channel", configuration: {} },
    ]),
    /duplicates another Channel Driver/,
  );
  // Closed schema: the Slack Driver accepts no settings.
  await assert.rejects(
    load(t, [{ id: "slack-channel", configuration: { fileHosts: ["files.slack.com"] } }]),
    (error: Error & { error?: { details?: readonly { code: string }[] } }) =>
      error.error?.details?.some(({ code }) => code === "UNKNOWN_FIELD") === true,
  );
});

test("Agent configuration save refuses Slack when drivers.channel installs no Slack Driver", async (t) => {
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  };
  for (const [selection, refused] of [
    [undefined, false],
    [[], true],
  ] as const) {
    // The real API receives the provider set that the Installation loader resolved, which
    // composition gives to both OCC and Kubernetes Compute.
    const { channelDrivers } = await load(t, selection);
    const fixture = await createConsoleAppFixture(t, { channelRuntime: true, channelDrivers });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Slack ${refused ? "refused" : "admitted"}`, {
      ready: true,
    });
    const saved = await fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
      body: {
        kind: "agent",
        values: nativeValues("slack-driver-selection", { harnessId: "codex", channels: { slack } }),
      },
    });
    if (!refused) {
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      continue;
    }
    // Without the Driver, Compute admission refuses the enabled channel before anything is stored.
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.equal(saved.body.error.code, "INVALID_REQUEST");
    assert.match(saved.body.error.message, /channels\.slack .*install its Channel Driver/);
  }
});

test("SSH Compute deployment refuses an enabled channel without an installed Channel Driver", async (t) => {
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  };
  // SSH Compute resolves no channels itself, so OCC must refuse the gap for every Compute.
  const { channelDrivers } = await load(t, []);
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "SSH without channels", {
    channelDrivers,
  });
  const deploy = async (name: string, enabled: boolean) => {
    const configuration = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      {
        body: {
          kind: "agent",
          values: nativeValues(name, { channels: { slack: { ...slack, enabled } } }),
        },
      },
    );
    assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
    const agent = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name,
        configurationId: configuration.body.data.id,
        harnessAuth: { method: "runtime" },
      },
    });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    return fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.body.data.id}/deploy`,
    );
  };
  // Without the Slack Driver, an Agent with Slack enabled records no revision.
  const refused = await deploy("ssh-slack-enabled", true);
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "INVALID_REQUEST");
  assert.match(refused.body.error.message, /channels\.slack .*install its Channel Driver/);
  // An Agent with the channel turned off still deploys on the same Installation.
  const admitted = await deploy("ssh-slack-off", false);
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
});

test("Agent provisioning refuses an enabled channel without an installed Channel Driver in the API", async () => {
  // A Compute that provisions Agents but has no channel rules of its own, so only OCC refuses.
  const computeDriver = createReadyComputeDriver("compute-provisioning-no-channels", {
    agentProvisioning: { executionModes: ["dedicated"] },
    validateAgentProvisioning() {},
    async provisionAgentRuntimeCredentials() {
      return { transportConfigured: true };
    },
    async getAgentRuntimeCredentialStatus() {
      return { transportConfigured: false };
    },
  });
  // The API owns the Installation's Channel Driver set; drivers.channel: [] installs none.
  const fixture = await createInjectedControllerFixture(
    {
      channelDrivers: [],
      computeDriver,
      configurationDriver: createTestConfigurationDriver({ exact: true }),
      secretDriver: createTestSecretDriver(),
    },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries: _summaries, ...options }) {
        return factory(options);
      },
    },
  );
  const { namespace } = await readyNamespaceFixture(
    {
      fixture,
      request: (method, path, options) => injectedRequest(fixture.app, method, path, options),
    },
    "Provisioning without channels",
  );
  const controller = fixture.controller;
  assert(controller, "bootstrap must create the controller");
  const harnessSecret = await controller.createSecret(fixture.principal.id, {
    namespaceId: namespace.id,
    name: "provisioning-model-key",
    value: "synthetic-model-key",
  });
  const provision = (enabled: boolean, requestId: string) =>
    controller.provisionAgent(fixture.principal.id, {
      namespaceId: namespace.id,
      requestId,
      name: requestId,
      executionMode: "dedicated",
      configuration: {
        kind: "agent",
        values: {
          ...createHarnessConfiguration("openclaw", "gpt-4.1"),
          channels: { slack: { enabled, mode: "socket" } },
        },
      },
      harnessAuth: { method: "api_key", source: harnessSecret.ref },
    });
  // The worker that would deploy this Agent has no Channel Drivers, so the API refuses the
  // request before anything is stored or queued.
  await assert.rejects(provision(true, "slack-enabled"), {
    name: "ConfigurationHarnessError",
    message: /channels\.slack is not a supported channel: install its Channel Driver/,
  });
  // With the channel off, the request passes every check and reaches the provisioning store,
  // which this in-memory state does not provide.
  await assert.rejects(provision(false, "slack-off"), {
    name: "DependencyUnavailableError",
    message: /requires durable PostgreSQL state/,
  });
});
