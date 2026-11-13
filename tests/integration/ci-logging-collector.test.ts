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
} from "../helpers/ci-logging.ts";
import { waitFor } from "../helpers/wait-for.mjs";

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
    const result = await prepareLogging({
      laneName: "logging-collector",
      directory: root,
      env: process.env,
      execFile: execute,
      registerResource: async (kind, details) => ({
        id: "resource-1",
        kind,
        owner: "openclaw-ci-local-test",
        ...details,
      }),
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
        "Collector file exporter JSONL output",
        async () =>
          payloadContains(canary, await readJsonlPayloads(result.artifacts.logsJsonl))
            ? true
            : undefined,
        { timeoutMs: 30_000, intervalMs: 250 },
      );
    } finally {
      if (result.resource) {
        await cleanupLogging(result.resource, { execFile: execute });
      }
    }
  },
);
