import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertNoSecretMaterial,
  createPluginDriverRealFixture,
} from "../helpers/plugin-driver-real.mjs";

// A ClawHub release compatible with the pinned runtime (OpenClaw 2026.9.8). Its
// integrity is the archive SHA-256 ClawHub publishes for this version, in the
// base64 form OpenClaw records for a ClawHub install.
const defaultRelease = {
  nativeId: "lobster",
  name: "Lobster",
  source: "clawhub",
  packageName: "@openclaw/lobster",
  version: "2026.9.7",
  integrity: "sha256-JcZWME9XIGfIGl8TZb+oeW2DyHqKNX+O3Y90W2lg40Q=",
  toolNames: ["lobster"],
};

function selectedRelease() {
  const raw = process.env.OCC_TEST_OPENCLAW_CLAWHUB_RELEASE;
  return raw === undefined || raw.trim() === "" ? defaultRelease : JSON.parse(raw);
}

// A revision whose release fails verification: its gateway container exits before the
// wrapper spawns the native gateway, no Pod of it is ever Ready, and its deployment
// never succeeds.
async function assertStartupRefused(fixture, agent, revisionId, modelSecret) {
  const refusal = await fixture.observeGatewayStartupRefusal(agent, revisionId);
  const lines = proofLines(refusal.previousLog);
  assertNoSecretMaterial(lines, [modelSecret], "refusal traces must not expose model credentials.");
  assert.equal(refusal.everReady, false, "a refused release never makes the gateway Ready.");
  assert.notEqual(refusal.lastTermination.exitCode, 0);
  assert.ok(
    lines.some((line) =>
      line.includes("OpenClaw plugin installed integrity does not match the admitted release."),
    ),
    `the gateway log must name the integrity refusal: ${JSON.stringify(lines)}`,
  );
  assert.ok(
    lines.some((line) => /"phase":"model-probe","outcome":"ok"/.test(line)),
    "startup reached plugin installation.",
  );
  assert.ok(
    !lines.some((line) => /"phase":"(plugin-install|native-spawn)"/.test(line)),
    "plugin installation never completed and the native gateway never spawned.",
  );
  assert.ok(
    !lines.some((line) => line.includes("http server listening")),
    "the native gateway never served.",
  );
  // activeRevisionId is recorded before runtime activation completes, so the
  // deployment status, not the active revision, shows the refusal.
  const status = await fixture.getDeploymentStatus(agent.id, revisionId);
  assert.notEqual(status.status, "succeeded");
}

const realLane = {
  skip:
    process.env.OCC_TEST_PLUGIN_DRIVER_OPENCLAW_CLAWHUB_REAL === "1"
      ? false
      : "Set OCC_TEST_PLUGIN_DRIVER_OPENCLAW_CLAWHUB_REAL=1 with disposable k3d/PostgreSQL, an immutable runtime image and model credentials.",
  timeout: 900_000,
};

// A well-formed ClawHub digest that is not the published archive's.
function otherDigest(label) {
  return `sha256-${createHash("sha256").update(label).digest("base64")}`;
}

// The administrator's approval is Installation configuration: the fixture writes
// it into the Installation file the real API and worker load at startup.
function createClawHubFixture(context, approvedPlugins) {
  return createPluginDriverRealFixture(context, {
    pluginDriverId: "occ-plugin",
    scenario: "openclaw",
    databaseUrl: process.env.OCC_TEST_PLUGIN_DRIVER_OPENCLAW_CLAWHUB_DATABASE_URL,
    pluginDriverConfiguration: { approvedPlugins },
    // The fixture's 1Gi default OOM-kills the gateway once lobster loads; the
    // harness topology suite uses the same 2Gi for an embedded gateway.
    gatewayMemoryLimit: "2Gi",
    // At 2 CPUs the gateway stays throttled for over a minute after ready on
    // slower hosts, so readiness flaps between the test's reads.
    gatewayCpuLimit: "4",
  });
}

// An embedded Agent with a model key whose Agent editor selects the plugin by ID only;
// package, version, source and digest come from the Installation's approval.
async function createAgentSelecting(fixture, release, { alsoAllow = [] } = {}) {
  const agent = await fixture.createAgent({
    harnessId: "openclaw",
    executionMode: "embedded",
    name: `openclaw-clawhub-${randomUUID()}`,
  });
  const modelSecret = await fixture.bindOpenAIModelSecret(agent.id);
  const allowedPlugins = ["openai", release.nativeId, ...alsoAllow];
  const configurationPath = `/namespaces/${fixture.namespaceId}/configurations/${agent.configurationId}`;
  const configuration = await fixture.request("GET", configurationPath);
  assert.equal(configuration.status, 200, JSON.stringify(configuration.error));
  const configured = await fixture.request("PATCH", configurationPath, {
    values: {
      ...configuration.data.values,
      plugins: { ...configuration.data.values.plugins, allow: allowedPlugins },
      tools: {
        ...configuration.data.values.tools,
        allow: ["read"],
        // OpenClaw 2026.9.8 puts plugin tools behind core exec (code mode, for
        // models that prefer it) or tool_call (Tool Search, on by default).
        // Turning both off gives the model lobster's own schema, so the
        // transcript records the plugin's own tool call.
        codeMode: { enabled: false },
        toolSearch: false,
      },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.error));
  await fixture.selectPlugin(agent.id, {
    pluginId: `occ-plugin:${release.nativeId}`,
    enabled: true,
    toolDefaults: { approval: "none" },
  });
  return { agent, modelSecret, allowedPlugins };
}

// The identity fields of the install record OpenClaw wrote in the gateway Pod.
function installRecordFor(release) {
  return {
    pluginId: release.nativeId,
    pluginVersion: release.version,
    source: "clawhub",
    clawhubPackage: release.packageName,
    version: release.version,
    integrity: release.integrity,
  };
}

// Native startup lines worth keeping as proof: startup phases, the plugin status
// and plugin refusals. Other gateway output stays in the cluster.
function proofLines(log) {
  return log
    .split("\n")
    .filter((line) =>
      /runtime\.startup_phase|plugin status|OpenClaw plugin|http server listening/.test(line),
    );
}

test(
  "an Installation-approved ClawHub release installs at its admitted identity and runs in a normal Agent turn",
  realLane,
  async (context) => {
    const release = selectedRelease();
    const pluginId = `occ-plugin:${release.nativeId}`;
    const [toolName] = release.toolNames;
    const turnMarker = `OPENCLAW_CLAWHUB_REAL_${randomUUID()}`;
    const outputMarker = `CLAWHUB_TOOL_OUTPUT_${randomUUID().replaceAll("-", "")}`;
    const prompt =
      process.env.OCC_TEST_OPENCLAW_CLAWHUB_PROMPT ??
      [
        // Lobster built-ins only: one item from commands.list, rendered as literal
        // text. No shell step, so nothing in it reads as OpenClaw's core exec tool.
        `Call the tool named "${toolName}" once with action "run" and pipeline: commands.list | head --n 1 | template --text '${outputMarker}'`,
        `Do not use any other tool. After it returns, include ${turnMarker} in your final answer.`,
      ].join("\n");
    const resultPattern = process.env.OCC_TEST_OPENCLAW_CLAWHUB_RESULT_EXPECT ?? outputMarker;

    const fixture = await createClawHubFixture(context, [release]);
    const { agent, modelSecret, allowedPlugins } = await createAgentSelecting(fixture, release);

    const deployed = await fixture.deployAndWait(agent);
    assert.deepEqual(
      deployed.revision.plugins?.releases,
      { [pluginId]: release },
      "admission records the exact approved release with the revision.",
    );
    assert.deepEqual(
      deployed.status.warnings,
      [],
      "a verified ClawHub install deploys without a plugin warning.",
    );

    // The Pod installed this exact release from ClawHub, not npm and not a newer
    // version. Startup already refused readiness on any mismatch; read it back here.
    assert.deepEqual(
      await fixture.readOpenClawPluginInstall(agent, release.nativeId),
      installRecordFor(release),
    );
    const policy = await fixture.readOpenClawPluginPolicy(agent, release.nativeId);
    assert.deepEqual(policy.plugins, { allow: allowedPlugins, enabled: true });
    assert.deepEqual(policy.tools.allow, ["read", release.nativeId]);
    // The model key reaches the gateway only through its environment, which the Pod
    // withholds from plugin CLI calls. No file the installer can read holds it.
    assert.deepEqual(
      await fixture.findGatewayFilesContainingEnvironmentValue(agent, "OPENAI_API_KEY"),
      [],
    );

    const sessionKey = `agent:main:clawhub-proof-${randomUUID()}`;
    const content = await fixture.normalGatewayTurn({
      agent,
      gatewayPassword: deployed.gatewayPassword,
      sessionKey,
      prompt,
      expectedPatterns: [turnMarker],
      secrets: [modelSecret],
    });
    assertNoSecretMaterial(
      content,
      [modelSecret],
      "ClawHub plugin proof response must not expose model credentials.",
    );
    // Read the turn from the native transcript. assertSessionToolCallEvidence also
    // requires a systemPromptReport, which OpenClaw 2026.9.8 no longer writes to
    // session entries, so this test checks the transcript directly.
    const evidence = await fixture.readSessionToolEvidence(agent, {
      sessionKey,
      turnMarker,
      toolName,
      resultPattern,
    });
    assert.equal(evidence.exists, true, `${sessionKey} must have a persisted transcript.`);
    assert.equal(evidence.userMarkerSeen, true, "the transcript must include the request.");
    assert.equal(evidence.assistantMarkerSeen, true, "the transcript must include the reply.");
    assert.equal(evidence.assistantError, false, "the Agent turn must succeed.");
    // The output marker appears only in the tool's own result, so a model reply
    // alone cannot satisfy this check.
    const matched = evidence.calls.find((call) =>
      evidence.results.some(
        (result) =>
          result.toolCallId === call.id && result.isError === false && result.matchesResult,
      ),
    );
    const transcript = {
      calls: evidence.calls,
      results: evidence.results,
      observedToolNames: evidence.diagnostics.observedToolNames,
    };
    assert.ok(
      matched,
      `the turn must call ${toolName} with a successful result containing the output marker: ${JSON.stringify(transcript)}`,
    );
    assert.deepEqual(
      evidence.diagnostics.observedToolNames,
      [toolName],
      `the turn must call only ${toolName}, not core exec or tool_call: ${JSON.stringify(transcript)}`,
    );
  },
);

test(
  "an admitted ClawHub release replays after its approval changes or is removed and the controllers restart, while new admissions follow the current approval",
  realLane,
  async (context) => {
    const release = selectedRelease();
    const pluginId = `occ-plugin:${release.nativeId}`;
    const fixture = await createClawHubFixture(context, [release]);
    const { agent, allowedPlugins } = await createAgentSelecting(fixture, release);
    const deployed = await fixture.deployAndWait(agent);
    assert.deepEqual(deployed.revision.plugins?.releases, { [pluginId]: release });
    assert.deepEqual(
      await fixture.readOpenClawPluginInstall(agent, release.nativeId),
      installRecordFor(release),
    );
    const revisionPath = `/namespaces/${fixture.namespaceId}/agents/${agent.id}/revisions/${deployed.revision.id}`;

    // Approval decides only what later admissions bind. Each step edits the
    // Installation, restarts the API and worker from it against the same PostgreSQL
    // state, then restarts the running revision's gateway Pod. The restarted
    // controller must read the admitted binding back unchanged, and the new Pod
    // must install exactly that release, not the Installation's current entry.
    const steps = [
      ["changed", [{ ...release, integrity: otherDigest(`changed ${release.packageName}`) }]],
      ["removed", []],
    ];
    for (const [label, approvedPlugins] of steps) {
      await fixture.restartControllers({ pluginDriverConfiguration: { approvedPlugins } });
      const stored = await fixture.request("GET", revisionPath);
      assert.equal(stored.status, 200, JSON.stringify(stored.error));
      assert.deepEqual(
        stored.data.plugins?.releases,
        { [pluginId]: release },
        `after the approval is ${label}, the restarted controller reads the admitted binding unchanged.`,
      );
      // The state volume keeps OpenClaw's install record, so the replacement Pod
      // starts over a persisted record: startup must drop it and install fresh.
      assert.deepEqual(await fixture.readOpenClawPersistedInstallRecord(agent, release.nativeId), {
        source: "clawhub",
        clawhubPackage: release.packageName,
        version: release.version,
        integrity: release.integrity,
      });
      const restarted = await fixture.replaceGatewayPod(agent);
      assert.equal(restarted.after.revisionId, deployed.revision.id);
      assert.deepEqual(
        await fixture.readOpenClawPluginInstall(agent, release.nativeId),
        installRecordFor(release),
        `after the approval is ${label}, the replacement Pod installs the admitted release.`,
      );
      // Uninstall strips the plugin from plugins.allow; startup restores the admitted policy.
      const policy = await fixture.readOpenClawPluginPolicy(agent, release.nativeId);
      assert.deepEqual(policy.plugins, { allow: allowedPlugins, enabled: true });
    }

    // With the approval removed, nothing new can select or admit the plugin: an
    // Agent save naming it and a deploy of the Agent that stored it are refused,
    // and the admitted revision stays active.
    const other = await fixture.createAgent({
      harnessId: "openclaw",
      executionMode: "embedded",
      name: `openclaw-clawhub-removed-${randomUUID()}`,
    });
    const refusedSave = await fixture.request(
      "PATCH",
      `/namespaces/${fixture.namespaceId}/agents/${other.id}`,
      {
        configurationId: other.configurationId,
        executionMode: other.executionMode,
        plugins: { [pluginId]: { enabled: true, toolDefaults: { approval: "none" } } },
      },
    );
    assert.equal(refusedSave.status, 400, JSON.stringify(refusedSave));
    assert.match(refusedSave.error.message, new RegExp(`does not offer: ${pluginId}`));
    const { deployed: refusedDeploy } = await fixture.requestDeployment(agent);
    assert.equal(refusedDeploy.status, 400, JSON.stringify(refusedDeploy));
    assert.match(refusedDeploy.error.message, new RegExp(`does not offer: ${pluginId}`));
    const revisions = await fixture.request(
      "GET",
      `/namespaces/${fixture.namespaceId}/agents/${agent.id}/revisions`,
    );
    assert.equal(revisions.status, 200, JSON.stringify(revisions.error));
    assert.deepEqual(
      revisions.data.map(({ id }) => id),
      [deployed.revision.id],
      "a refused deployment creates no revision.",
    );
    assert.equal((await fixture.getAgent(agent.id)).activeRevisionId, deployed.revision.id);
  },
);

test(
  "a ClawHub archive that does not match its admitted digest is refused before the gateway starts",
  realLane,
  async (context) => {
    const release = selectedRelease();
    const pluginId = `occ-plugin:${release.nativeId}`;
    // The nearest forbidden case: the same package and version from ClawHub, admitted
    // with a digest the published archive does not have. To the Pod this is the same
    // as the registry serving different content under an approved version.
    const mismatched = {
      ...release,
      integrity: otherDigest(`mismatched ${release.packageName}@${release.version}`),
    };
    const fixture = await createClawHubFixture(context, [mismatched]);
    const { agent, modelSecret } = await createAgentSelecting(fixture, mismatched);

    const { deployed } = await fixture.requestDeployment(agent);
    assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
    assert.deepEqual(deployed.data.plugins?.releases, { [pluginId]: mismatched });

    // The Pod fetches the real archive, then compares OpenClaw's install record with
    // the admitted digest. A mismatch stops the startup wrapper before it spawns the
    // native gateway, so plugin code never loads in a gateway and the Pod is never Ready.
    await assertStartupRefused(fixture, agent, deployed.data.id, modelSecret);
  },
);

test(
  "a mismatched digest is refused before the gateway starts when the Pod reinstalls over a persisted record",
  realLane,
  async (context) => {
    const release = selectedRelease();
    const pluginId = `occ-plugin:${release.nativeId}`;
    const fixture = await createClawHubFixture(context, [release]);
    const { agent, modelSecret } = await createAgentSelecting(fixture, release);
    const admitted = await fixture.deployAndWait(agent);
    assert.deepEqual(admitted.revision.plugins?.releases, { [pluginId]: release });
    // The Agent's state volume now holds OpenClaw's install record for the release.
    assert.deepEqual(await fixture.readOpenClawPersistedInstallRecord(agent, release.nativeId), {
      source: "clawhub",
      clawhubPackage: release.packageName,
      version: release.version,
      integrity: release.integrity,
    });

    // The administrator changes the approved digest; a new revision of the same Agent
    // binds it. Its Pod mounts the same state volume, so startup meets the persisted
    // record, removes it, installs the real archive fresh, and must still refuse it.
    const mismatched = {
      ...release,
      integrity: otherDigest(`mismatched ${release.packageName}@${release.version}`),
    };
    await fixture.restartControllers({
      pluginDriverConfiguration: { approvedPlugins: [mismatched] },
    });
    const { deployed } = await fixture.requestDeployment(agent);
    assert.equal(deployed.status, 202, JSON.stringify(deployed.error));
    assert.deepEqual(deployed.data.plugins?.releases, { [pluginId]: mismatched });
    await assertStartupRefused(fixture, agent, deployed.data.id, modelSecret);
  },
);

test(
  "a new revision starts with no install record retained from an earlier release",
  { ...realLane, timeout: 1_200_000 },
  async (context) => {
    const release = selectedRelease();
    const fixture = await createClawHubFixture(context, [release]);
    const { agent } = await createAgentSelecting(fixture, release, { alsoAllow: ["diffs"] });
    await fixture.deployAndWait(agent);
    assert.deepEqual(
      (await fixture.readOpenClawPersistedInstallRecord(agent, release.nativeId))?.integrity,
      release.integrity,
    );

    // The next revision drops the approved release and selects bundled Diffs. Its Pod
    // mounts the same state volume, which still holds the earlier release's record.
    // OpenClaw picks a record by the staged manifest's plugin ID, so startup must drop
    // every retained record, not only those of plugins it installs now.
    await fixture.removePluginSelection(agent.id, `occ-plugin:${release.nativeId}`);
    await fixture.selectPlugin(agent.id, {
      pluginId: "occ-plugin:diffs",
      enabled: true,
      toolDefaults: { approval: "none" },
    });
    // The first gateway drains in-flight work for up to the 330 s stop timeout first.
    const next = await fixture.deployAndWait(agent, { timeoutMs: 600_000 });
    assert.equal(next.revision.plugins?.releases, undefined);
    assert.equal(
      await fixture.readOpenClawPersistedInstallRecord(agent, release.nativeId),
      null,
      "the earlier release's install record must be gone once the new revision runs.",
    );
    assert.equal(
      (await fixture.readOpenClawPersistedInstallRecord(agent, "diffs"))?.source,
      "npm",
      "the new revision installed Diffs fresh.",
    );
  },
);

// A community (non-official) ClawHub release that declares its tools for OpenClaw
// 2026.9.8. OpenClaw refuses a noninteractive install of a non-official plugin unless
// the caller accepts its declared capabilities.
const communityRelease = {
  nativeId: "stella-timeline-plugin",
  name: "Stella Timeline",
  source: "clawhub",
  packageName: "stella-timeline-plugin",
  version: "2.8.10",
  integrity: "sha256-yS6GoOKd5nOULL2fL11e/6lOc5Tyz8c3RbyQTKB2F1g=",
  toolNames: ["timeline_resolve", "timeline_transition"],
};

test(
  "an Installation-approved community ClawHub release installs with the administrator's capability consent",
  realLane,
  async (context) => {
    const pluginId = `occ-plugin:${communityRelease.nativeId}`;
    const fixture = await createClawHubFixture(context, [communityRelease]);
    const { agent, allowedPlugins } = await createAgentSelecting(fixture, communityRelease);

    // The deployment succeeds only if the Pod passed OpenClaw's capability consent for
    // this non-official release and the install record matches the approval.
    const deployed = await fixture.deployAndWait(agent);
    assert.deepEqual(deployed.revision.plugins?.releases, { [pluginId]: communityRelease });
    assert.deepEqual(deployed.status.warnings, []);
    assert.deepEqual(
      await fixture.readOpenClawPluginInstall(agent, communityRelease.nativeId),
      installRecordFor(communityRelease),
    );
    const policy = await fixture.readOpenClawPluginPolicy(agent, communityRelease.nativeId);
    assert.deepEqual(policy.plugins, { allow: allowedPlugins, enabled: true });
    assert.deepEqual(policy.tools.allow, ["read", communityRelease.nativeId]);
    // The native gateway names the plugins it loaded when it starts serving.
    const listening = proofLines(await fixture.readGatewayLog(agent)).find((line) =>
      line.includes("http server listening"),
    );
    assert.match(listening ?? "", new RegExp(`plugins?: [^)]*\\b${communityRelease.nativeId}\\b`));
  },
);
