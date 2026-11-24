import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveChannelRouting } from "../../apps/controller/src/drivers/channel/routing.ts";
import { nativeValues } from "../browser/console-agents-browser-helpers.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
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
