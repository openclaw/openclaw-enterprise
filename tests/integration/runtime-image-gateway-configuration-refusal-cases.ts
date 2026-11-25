import assert from "node:assert/strict";
import test from "node:test";
import { gatewayRuntimeEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { sanitizeRuntimeLogChunk } from "../../packages/occ/src/runtime-logs/sanitize.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.ts";
import {
  GATEWAY_DID_NOT_START,
  gatewayConfigurationHoldLine,
  gatewayExitedBeforeServing,
} from "../helpers/openclaw-config-validation.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { waitForContainerReady } from "../helpers/runtime-image-gateway-observations.ts";
import {
  createAdmittedRuntimeImageConfiguration,
  imageTestOptions,
  runGatewaySmoke,
  temporaryGatewayConfiguration,
} from "../helpers/runtime-image-startup.ts";

export function registerGatewayConfigurationRefusalCases(): void {
  // An embedded Gateway's OpenClaw exits at startup on the invalid entry with status 78 and names
  // each failing setting (finding 3043; the image's openclaw/openclaw#189392 patch). A dedicated
  // Codex Gateway's tool policy step validates the composed configuration before OpenClaw starts,
  // and holds the same check, not a tool policy failure (finding 3045).
  for (const { topology, harnessId, withAppServer, event } of [
    {
      topology: "an embedded",
      harnessId: "openclaw",
      withAppServer: false,
      event: gatewayExitedBeforeServing("exit-78"),
    },
    {
      topology: "a dedicated Codex",
      harnessId: "codex",
      withAppServer: true,
      event: GATEWAY_DID_NOT_START,
    },
  ]) {
    test(
      `runtime image holds ${topology} Kubernetes Gateway whose plugin configuration fails its schema`,
      imageTestOptions,
      async (t) => {
        // A beam plugin entry without its required mirror settings.
        const admitted = createAdmittedRuntimeImageConfiguration(harnessId);
        const plugins = asRecord(admitted.plugins);
        const configuration = {
          ...admitted,
          plugins: {
            ...plugins,
            entries: {
              ...asRecord(plugins?.entries),
              beam: { enabled: true, config: { mirror: { token: "synthetic-beam-token-value" } } },
            },
          },
        };
        const configurationPath = await temporaryGatewayConfiguration(t, harnessId, configuration);
        const startedAt = Date.now();
        const { containerName } = await runGatewaySmoke(t, harnessId, {
          configurationPath: "/etc/openclaw/openclaw.json",
          entrypoint: gatewayRuntimeEntrypoint(false),
          volumes: [`${configurationPath}:/etc/openclaw/openclaw.json:ro`],
          withAppServer,
          waitUntilReady: false,
          extraEnvironment: [
            "OPENCLAW_RUNTIME_STATUS_PORT=18791",
            "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
            "OPENCLAW_AGENT_REVISION_ID=rev_gateway-config",
            "OPENCLAW_POD_UID=pod_gateway-config",
          ],
        });
        // The wrapper keeps running, so the container is not restarted into the same refusal,
        // and serves the held check on the status port Compute reads. Commands run in the
        // container read that port from the container's own environment.
        await waitForContainerReady(containerName, {
          label: "Held Gateway configuration failure",
          request:
            '() => fetch("http://127.0.0.1:" + process.env.OPENCLAW_RUNTIME_STATUS_PORT + "/openclaw/runtime/status", { signal: AbortSignal.timeout(5000) }).then((response) => response.json()).then((status) => (status.runtimeFailure === undefined ? 503 : 200))',
          timeoutMs: 120_000 * imageSmokeTimeoutMultiplier,
        });
        t.diagnostic(`held ${Date.now() - startedAt} ms after the container started`);
        const { stdout } = await runDocker([
          "exec",
          containerName,
          "node",
          "-e",
          'const status = "http://127.0.0.1:" + process.env.OPENCLAW_RUNTIME_STATUS_PORT; Promise.all([fetch(status + "/openclaw/runtime/status").then((response) => response.json()), fetch(status + "/readyz").then((response) => response.status)]).then(([held, ready]) => process.stdout.write(JSON.stringify({ status: held, ready })))',
        ]);
        const observed: unknown = JSON.parse(stdout);
        const response = asRecord(observed);
        const status = asRecord(response?.status);
        const failure = asRecord(status?.runtimeFailure);
        assert.ok(failure, "expected a runtime failure on the Gateway status port");
        const { checkedAt, ...held } = failure;
        assert.ok(typeof checkedAt === "string");
        assert.ok(!Number.isNaN(Date.parse(checkedAt)));
        assert.deepEqual(held, {
          component: "gateway",
          check: "gateway-config",
          code: "UNAVAILABLE",
        });
        assert.equal(response?.ready, 503);
        // The log names the failing settings with OpenClaw's schema messages, never their
        // values, on one line that runtime logs keep.
        const logs = await runDocker(["logs", containerName]);
        const output = `${logs.stdout}\n${logs.stderr}`;
        if (!withAppServer) {
          // OpenClaw's own refusal, in its JSON console records, names the plugin setting instead
          // of reporting a config change.
          const openClawLines = output.split("\n").flatMap((line) => {
            try {
              const entry: unknown = JSON.parse(line);
              const message = asRecord(entry)?.message;
              return typeof message === "string" ? message.split("\n") : [];
            } catch {
              return [];
            }
          });
          assert.ok(
            openClawLines.includes(
              "  - plugins.entries.beam.config.mirror.endpoint: invalid config: must have required property 'endpoint'",
            ),
            output,
          );
        }
        const line = gatewayConfigurationHoldLine(event, [
          "plugins.entries.beam.config.mirror.endpoint: must have required property 'endpoint'",
          "plugins.entries.beam.config.mirror.catalogs: must have required property 'catalogs'",
        ]);
        assert.ok(output.split("\n").includes(line), output);
        assert.doesNotMatch(
          output,
          /synthetic-beam-token-value|required tool policy|config validity changed/,
        );
        const { records } = sanitizeRuntimeLogChunk({
          stream: { source: "gateway", pod: "gateway-0", container: "gateway" },
          truncated: false,
          lines: logs.stderr.split("\n").map((raw) => ({ time: null, raw })),
        });
        assert.ok(
          records.some((record) => record.type === "line" && record.message.includes(line)),
          JSON.stringify(records.slice(-5)),
        );
      },
    );
  }
}
