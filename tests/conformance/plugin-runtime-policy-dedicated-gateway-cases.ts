import assert from "node:assert/strict";

import test from "node:test";

import vm from "node:vm";
import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";
import {
  GATEWAY_DID_NOT_START,
  gatewayConfigurationHoldLine,
  invalidGatewayConfiguration,
  invalidGatewayConfigurationLine,
  invalidGatewayConfigurationSecret,
  openClawConfigValidationRefusal,
} from "../helpers/openclaw-config-validation.mjs";
import {
  GATEWAY_LOCAL_CODEX_TOOLS,
  codexGatewayConfig,
  configPath,
  launchGateway,
  readConfig,
  field,
  record,
  stringList,
  type GatewayOptions,
  type RuntimeInterval,
} from "./plugin-runtime-policy-fixture.ts";

// `openclaw config validate --json` output for a configuration read OpenClaw refused,
// as the pinned OpenClaw prints it (exit status 1).
function configReadRefusal(error: string) {
  return openClawConfigValidationRefusal(
    [{ path: "<root>", message: `read failed at /home/node/.openclaw/openclaw.json: ${error}` }],
    "Resolve the read error shown above, then retry.",
  );
}
const configReadPermissionDenied =
  "EACCES: permission denied, open '/home/node/.openclaw/openclaw.json'";
// Captured from a dedicated Gateway container started again after its native Gateway was
// killed (SIGKILL): the new PID namespace cannot verify the recorded holder (finding 2864).
const gatewayLockNamespaceRefusal =
  "GatewayLockNamespaceError: cannot verify Gateway ownership from this process; heartbeat age" +
  " does not prove that the holder stopped. holder 608 at 54b9b0fe1247/pid-ns 4026536051, last" +
  " renewed 14 s ago. Run this command inside the Gateway container or with a shared PID" +
  " namespace; if the holder has stopped, run `openclaw gateway recover-lock` to inspect and" +
  " explicitly recover the unchanged owner.";
const heldStatusEnvironment = {
  OPENCLAW_RUNTIME_STATUS_PORT: "18791",
  OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
};
const invalidRuntimeProvenanceLine =
  "The dedicated Gateway cannot verify its runtime provenance: it is missing, unreadable, or malformed. It remains unready; use the OCE runtime image matching the controller.";
const mismatchedRuntimeProvenanceLine =
  "The dedicated Gateway runtime provenance does not match the controller's pinned OpenClaw source/revision. It remains unready; use the OCE runtime image matching the controller.";
type GatewayRefusal = [
  name: string,
  options: GatewayOptions & { provenanceReadError?: string },
  held?: "gateway-tool-policy" | "gateway-state-lock" | "gateway-config",
  line?: string,
];

const gatewayToolPolicyRefusalLine =
  "The dedicated Gateway cannot apply its required tool policy. It remains unready; use the supporting OCE runtime image and a valid Gateway tool allowlist.";

const dedicatedGatewayLaunchers: (GatewayOptions & {
  name: string;
  env: NonNullable<GatewayOptions["env"]>;
})[] = [
  {
    name: "Kubernetes dedicated OpenClaw",
    env: {
      OPENCLAW_NATIVE_WORKER_PROFILE: "oce-native",
      OPENCLAW_WORKSPACE_NODE_ID: "a".repeat(64),
    },
  },
  {
    name: "Kubernetes dedicated Codex",
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
  },
  {
    name: "Docker dedicated Codex",
    launcher: "docker",
    env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
  },
];

export function registerDedicatedGatewayCases() {
  for (const launcher of dedicatedGatewayLaunchers) {
    test(`${launcher.name} applies the reviewed tool ceiling before native startup`, async () => {
      const { config: baseConfig, codex } = codexGatewayConfig();
      baseConfig.tools = {
        profile: "coding",
        allow: ["read", "sessions"],
        alsoAllow: ["gateway", "diffs"],
        deny: ["sessions_send"],
        // Deployment admission restricts apply_patch to the workspace by default.
        exec: { applyPatch: { workspaceOnly: true } },
      };
      // A strict Configuration's explicit steering value reaches the Gateway unchanged.
      baseConfig.messages = { queue: { allowCollaborativeSteering: false } };
      baseConfig.agents = { defaults: { modelSelectionScope: "agent" } };
      baseConfig.cron = { enabled: true, triggers: { enabled: true } };
      codex.config.codexDynamicToolsExclude = ["web_search"];
      const { calls, files } = await launchGateway(undefined, [], {
        ...launcher,
        baseConfig,
      });
      const native = calls.findIndex(({ args }) => args?.[1] === "gateway");
      const validate = calls.findIndex(
        ({ args }) => args?.[1] === "config" && args[2] === "validate",
      );
      assert.ok(
        validate >= 0 && validate < native,
        "validate the final config before starting the native Gateway",
      );
      const effective = readConfig(
        files,
        configPath(calls[validate]?.options?.env?.OPENCLAW_CONFIG_PATH),
      );
      const { gatewayPolicy: policy, ...ordinaryTools } = record(effective.tools);
      const gatewayPolicy = record(policy);
      const approvedTools = stringList(gatewayPolicy.allow);
      const actions = record(gatewayPolicy.actions);
      assert.deepEqual(
        ordinaryTools,
        baseConfig.tools,
        "ordinary restrictions and plugin grants are retained",
      );
      assert.deepEqual(gatewayPolicy.allow, [
        "sessions",
        "sessions_list",
        "sessions_history",
        "sessions_search",
        "sessions_send",
        "sessions_spawn",
        "sessions_yield",
        "subagents",
        "session_status",
        "agents_list",
        "automations",
        "message",
        "ask_user",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "ls",
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
      ]);
      assert.equal(approvedTools.includes("gateway"), false);
      assert.equal(
        approvedTools.includes("diffs"),
        false,
        "a plugin tool grant is not policy approval",
      );
      assert.deepEqual(Object.keys(actions).sort(), [
        "automations",
        "message",
        "process",
        "sessions",
        "subagents",
      ]);
      assert.equal(stringList(actions.message).includes("send"), true);
      assert.equal(stringList(actions.message).includes("set-profile"), false);
      assert.deepEqual(gatewayPolicy.automations, { scope: "caller", allowCommandJobs: false });
      assert.deepEqual(effective.messages, baseConfig.messages);
      assert.equal(field(effective, "agents", "defaults", "modelSelectionScope"), "session");
      assert.deepEqual(effective.cron, { enabled: true, triggers: { enabled: false } });
      if (launcher.env.APP_SERVER_URL !== undefined) {
        assert.deepEqual(
          field(effective, "plugins", "entries", "codex", "config", "codexDynamicToolsExclude"),
          ["web_search", ...GATEWAY_LOCAL_CODEX_TOOLS],
        );
      }
      assert.deepEqual(
        field(effective, "gateway", "auth"),
        baseConfig.gateway.auth,
        "human Gateway authorization remains unchanged",
      );
      assert.deepEqual(
        readConfig(files, "/etc/openclaw/openclaw.json"),
        baseConfig,
        "the admitted revision is untouched",
      );
    });

    // A beam entry that fails its schema (finding 3045). Beside an issue on a setting the tool
    // policy step composes, the tool policy hold wins.
    const beamIssue = {
      path: "plugins.entries.beam.config.mirror.endpoint",
      message: "invalid config: must have required property 'endpoint'",
    };
    for (const [failure, options, held = "gateway-tool-policy", line] of [
      [
        "an older runtime with the known upstream source and a different commit",
        {
          files: [
            [
              "/opt/oce/runtime/provenance.json",
              JSON.stringify({
                source: "https://github.com/openclaw/openclaw",
                commit: "a".repeat(40),
              }),
            ],
          ],
        },
        "gateway-tool-policy",
        mismatchedRuntimeProvenanceLine,
      ],
      [
        "a different runtime source with the pinned commit",
        {
          files: [
            [
              "/opt/oce/runtime/provenance.json",
              JSON.stringify({
                source: "https://runtime.example.test/untrusted-source",
                commit: GATEWAY_TOOL_POLICY_SOURCE_COMMIT,
              }),
            ],
          ],
        },
        "gateway-tool-policy",
        mismatchedRuntimeProvenanceLine,
      ],
      ...["ENOENT", "EACCES"].map((code): GatewayRefusal => [
        `${code === "ENOENT" ? "missing" : "unreadable"} runtime provenance`,
        { provenanceReadError: code },
        "gateway-tool-policy",
        invalidRuntimeProvenanceLine,
      ]),
      ...(
        [
          ["invalid JSON", "invalid-provenance-bytes"],
          ["null", "null"],
          ["an array", "[]"],
          ["missing fields", "{}"],
          [
            "an invalid commit",
            JSON.stringify({
              source: "https://github.com/openclaw/openclaw",
              commit: "invalid-sha",
            }),
          ],
        ] as const
      ).map(([shape, contents]): GatewayRefusal => [
        `malformed runtime provenance (${shape})`,
        { files: [["/opt/oce/runtime/provenance.json", contents]] },
        "gateway-tool-policy",
        invalidRuntimeProvenanceLine,
      ]),
      [
        "valid runtime provenance with an invalid tool allowlist",
        {
          baseConfig: {
            ...codexGatewayConfig().config,
            tools: { gatewayPolicy: { allow: ["gateway"] } },
          },
        },
        "gateway-tool-policy",
        gatewayToolPolicyRefusalLine,
      ],
      [
        "schema validation refusal",
        {
          configValidationResponse: {
            status: 1,
            stdout: JSON.stringify({ valid: false }),
            stderr: "unsupported gatewayPolicy",
          },
        },
      ],
      // Another refused read of the configuration is not a lock: it keeps the tool policy hold.
      [
        "unreadable configuration",
        { configValidationResponse: configReadRefusal(`Error: ${configReadPermissionDenied}`) },
      ],
      [
        "Gateway state lock refusal",
        { configValidationResponse: configReadRefusal(gatewayLockNamespaceRefusal) },
        "gateway-state-lock",
      ],
      // Settings outside the tool policy are the Agent's configuration, not the policy. The hold
      // writes the line an embedded Gateway's gateway-config hold writes: the settings and the
      // remedy, never a configured value.
      [
        "invalid settings outside the tool policy",
        { configValidationResponse: invalidGatewayConfiguration },
        "gateway-config",
        invalidGatewayConfigurationLine(GATEWAY_DID_NOT_START),
      ],
      [
        "a refused key beside the settings the tool policy composes",
        {
          configValidationResponse: openClawConfigValidationRefusal([
            { path: "agents.defaults", message: 'Unrecognized key: "thinkingBudget"' },
          ]),
        },
        "gateway-config",
        gatewayConfigurationHoldLine(GATEWAY_DID_NOT_START, ["agents.defaults"]),
      ],
      // An issue on a setting the step composes keeps the tool policy hold, beside any other.
      [
        "an invalid composed tool policy",
        {
          configValidationResponse: openClawConfigValidationRefusal([
            beamIssue,
            { path: "tools.gatewayPolicy.actions.sessions", message: "Invalid input" },
          ]),
        },
      ],
      [
        "an invalid composed Codex tool exclusion",
        {
          configValidationResponse: openClawConfigValidationRefusal([
            {
              path: "plugins.entries.codex.config.codexDynamicToolsExclude.0",
              message: "invalid config: must be string",
            },
          ]),
        },
      ],
      // A runtime whose OpenClaw does not know a composed setting refuses its key one level up.
      [
        "a runtime that refuses the composed cron trigger switch",
        {
          configValidationResponse: openClawConfigValidationRefusal([
            { path: "cron.triggers", message: 'Unrecognized key: "enabled"' },
            beamIssue,
          ]),
        },
      ],
      [
        "a runtime that refuses the composed model selection scope",
        {
          configValidationResponse: openClawConfigValidationRefusal([
            { path: "agents.defaults", message: 'Unrecognized key: "modelSelectionScope"' },
          ]),
        },
      ],
      // A refusal that names no setting cannot be told apart from a policy refusal.
      [
        "an invalid report without issues",
        { configValidationResponse: openClawConfigValidationRefusal([]) },
      ],
    ] satisfies GatewayRefusal[]) {
      test(`${launcher.name} holds ${failure} unready without starting model work`, async (t) => {
        const messages: string[] = [];
        const intervals: RuntimeInterval[] = [];
        if (options.provenanceReadError !== undefined) {
          // The existing filesystem fixture reads this Map. Inject an I/O failure there;
          // the generated launcher must classify it without exposing the exception's path.
          const files: Map<unknown, unknown> = Map.prototype;
          const get = files.get;
          t.mock.method(files, "get", function (this: Map<unknown, unknown>, path: unknown) {
            if (path === "/opt/oce/runtime/provenance.json") {
              throw Object.assign(new Error("Cannot read /private/dummy-provenance-path"), {
                code: options.provenanceReadError,
              });
            }
            return get.call(this, path);
          });
        }
        const { calls, sandbox } = await launchGateway(undefined, [], {
          ...launcher,
          baseConfig: codexGatewayConfig().config,
          ...options,
          // The Docker launcher serves no status itself, so its published hold can be read here;
          // runtime-image-gateway-peer reads the Kubernetes Gateway's over its status port.
          env: {
            ...launcher.env,
            ...(launcher.launcher === "docker" ? heldStatusEnvironment : {}),
          },
          intervals,
          console: { error: (message) => messages.push(message) },
        });
        assert.equal(
          calls.some(({ args }) => args?.[1] === "gateway"),
          false,
        );
        assert.equal(
          messages.some((message) => message.includes("required tool policy")),
          held === "gateway-tool-policy" &&
            line !== invalidRuntimeProvenanceLine &&
            line !== mismatchedRuntimeProvenanceLine,
          messages.join("\n"),
        );
        if (held === "gateway-state-lock") {
          // The operator reads the cause and OpenClaw's holder description, not a policy hint.
          assert.ok(
            messages.some(
              (message) =>
                message.includes("still holds the Gateway state lock") &&
                message.includes("unverifiable state owner") &&
                message.includes("holder 608 at 54b9b0fe1247/pid-ns 4026536051"),
            ),
            messages.join("\n"),
          );
        }
        if (line !== undefined) {
          assert.deepEqual(messages, [line]);
        }
        if (line === invalidRuntimeProvenanceLine || line === mismatchedRuntimeProvenanceLine) {
          assert.equal(
            calls.some(({ args }) => args?.[1] === "config" && args[2] === "validate"),
            false,
            "refuse incompatible provenance before native configuration validation",
          );
          assert.doesNotMatch(
            messages.join("\n"),
            /untrusted-source|invalid-provenance-bytes|invalid-sha|dummy-provenance-path|provenance\.json|a{40}|tool allowlist/,
          );
        } else {
          assert.doesNotMatch(messages.join("\n"), /runtime provenance|pinned OpenClaw/);
          if (held === "gateway-tool-policy") {
            assert.deepEqual(messages, [gatewayToolPolicyRefusalLine]);
          }
        }
        assert.equal(messages.join("\n").includes(invalidGatewayConfigurationSecret), false);
        if (launcher.launcher === "docker") {
          const observed: unknown = vm.runInContext("runtimeStartupFailure", sandbox);
          const published = observed == null ? undefined : record(observed);
          assert.deepEqual(
            { check: published?.check, code: published?.code },
            {
              check: held,
              code: held === "gateway-tool-policy" ? "INCOMPATIBLE_RESPONSE" : "UNAVAILABLE",
            },
          );
        }
        assert.ok(
          intervals.some(({ ms }) => ms === 3_600_000),
          "keep the failed workload available for diagnosis",
        );
      });
    }
  }

  test("a dedicated Gateway permits concrete OCE tool additions and preserves empty or narrower policy", async () => {
    for (const gatewayPolicy of [
      { allow: [] },
      { allow: ["sessions", "diffs"], actions: { sessions: ["patch"] } },
    ]) {
      const { config: baseConfig } = codexGatewayConfig();
      baseConfig.tools = { alsoAllow: ["plugins"], gatewayPolicy };
      const { files } = await launchGateway(undefined, [], {
        env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
        baseConfig,
      });
      const effective = record(field(readConfig(files), "tools", "gatewayPolicy"));
      assert.deepEqual(effective.allow, gatewayPolicy.allow);
      assert.deepEqual(effective.actions, gatewayPolicy.actions ?? {});
      assert.deepEqual(effective.automations, { scope: "caller", allowCommandJobs: false });
    }
  });

  test("a dedicated Gateway takes approved tools from the immutable revision rather than native admin config", async () => {
    const { config: admitted } = codexGatewayConfig();
    admitted.tools = {
      gatewayPolicy: { allow: ["sessions", "read"], actions: { sessions: ["patch", "reset"] } },
    };
    const mutable = structuredClone(admitted);
    mutable.tools.gatewayPolicy = {
      allow: ["sessions", "plugins"],
      actions: { sessions: ["patch"] },
    };
    const { files } = await launchGateway(undefined, [], {
      env: {
        APP_SERVER_URL: "ws://harness.example.test:18790",
        OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
      },
      files: [
        ["/home/node/.openclaw/openclaw.json", JSON.stringify(mutable)],
        ["/etc/openclaw-managed/openclaw.json", JSON.stringify(admitted)],
      ],
    });
    assert.deepEqual(field(readConfig(files), "tools", "gatewayPolicy"), {
      allow: ["sessions"],
      actions: { sessions: ["patch"] },
      automations: { scope: "caller", allowCommandJobs: false },
    });
  });
}

export function registerEmbeddedDockerCase() {
  test("the embedded Docker launcher retains ordinary Gateway configuration", async () => {
    const baseConfig = {
      gateway: { mode: "local" },
      tools: { allow: ["gateway"] },
      cron: { triggers: { enabled: true } },
    };
    const { calls, files } = await launchGateway(undefined, [], {
      launcher: "docker",
      baseConfig,
    });
    assert.equal(calls.filter(({ args }) => args?.[1] === "gateway").length, 1);
    assert.equal(
      calls.some(({ args }) => args?.[1] === "config"),
      false,
    );
    assert.deepEqual(readConfig(files, "/etc/openclaw/openclaw.json"), baseConfig);
  });
}
