import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  cleanupLogging,
  execute,
  fixture,
  payloadContains,
  prepareLogging,
  readJsonlPayloads,
  selectedCollectorSmoke,
  waitFor,
} from "../helpers/ci-logging.mjs";

test(
  "prepareLogging backend receives real OTLP/HTTP logs and writes JSONL",
  {
    skip: selectedCollectorSmoke
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for the real Docker Collector backend smoke.",
    timeout: 120_000,
  },
  async (t) => {
    const root = await fixture(t);
    let resource;
    const result = await prepareLogging({
      laneName: "logging-collector",
      directory: root,
      env: process.env,
      execFile: execute,
      registerResource: async (kind, details) => {
        resource = { id: "resource-1", kind, owner: "openclaw-ci-local-test", ...details };
        return resource;
      },
    });
    try {
      const canary = `ci-logging-smoke-${randomUUID()}`;
      const response = await fetch(result.artifacts.localEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: {
                attributes: [{ key: "service.name", value: { stringValue: "ci-logging-smoke" } }],
              },
              scopeLogs: [
                {
                  logRecords: [
                    {
                      timeUnixNano: String(Date.now() * 1_000_000),
                      severityText: "INFO",
                      body: { stringValue: canary },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 200);
      await waitFor(
        async () => payloadContains(canary, await readJsonlPayloads(result.artifacts.logsJsonl)),
        "Collector file exporter JSONL output",
      );
    } finally {
      if (resource) {
        await cleanupLogging(resource, { execFile: execute });
      }
    }
  },
);
