import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { resolveChannelRouting } from "../../apps/controller/src/drivers/channel/routing.ts";
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
