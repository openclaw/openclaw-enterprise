import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import {
  AgentAutomationSchema,
  AgentAutomationRunsPageSchema,
  type AgentAutomationData,
  type AgentAutomationCreateInput,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createConsoleFixtureTransport } from "./console-fixture-transport.ts";
import type { createQaInstallation, createQaAgent } from "./qa-installation.mjs";
import { registerQaSecret } from "./qa-secrets.ts";
import { verifyQaToolAction } from "./qa-tool-action.ts";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

/** Real OCC routes and native scheduler; the independent workload read proves the tool effect. */
export async function verifyQaAgentAutomations(f: Fixture, agent: Agent): Promise<void> {
  const transport = createConsoleFixtureTransport(f.consoleUrl, f.apiUrl);
  const session = await signInWithEmailPassword({
    ...f.credentials,
    origin: f.consoleUrl,
    headers: { origin: f.consoleUrl },
    fetch: transport.fetchThroughLoopback,
  });
  registerQaSecret(session.cookie);
  const headers = authenticatedHeaders(session, { origin: f.consoleUrl });
  const base = `/namespaces/${agent.namespaceId}/agents/${agent.id}/automations`;
  const pending = new Set<string>();
  async function call(
    method: string,
    suffix: string,
    body: unknown = undefined,
    expected = 200,
    selectedHeaders: Record<string, string> = headers,
  ) {
    const response = await transport.rawRequest(method, base + suffix, {
      headers: selectedHeaders,
      body,
      timeout: 40_000,
    });
    assert.equal(
      response.response.status,
      expected,
      `Automation ${method}: expected ${expected}, received ${response.response.status}`,
    );
    return response.text ? asRecord(JSON.parse(response.text)) : undefined;
  }
  function job(value: unknown): AgentAutomationData {
    assert.ok(Check(AgentAutomationSchema, value), "OCC returns the supported automation contract");
    return value;
  }
  async function get(id: string) {
    return job((await call("GET", `/${id}`))?.data);
  }
  async function create(input: AgentAutomationCreateInput) {
    const created = job((await call("POST", "", input, 201))?.data);
    pending.add(created.id);
    return created;
  }
  async function runs(id: string) {
    const value = (await call("GET", `/${id}/runs?offset=0&limit=20`))?.data;
    assert.ok(Check(AgentAutomationRunsPageSchema, value));
    return value;
  }
  try {
    const schedules: AgentAutomationCreateInput["schedule"][] = [
      { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      { kind: "every", everyMs: 86_400_000 },
      { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    ];
    const created: AgentAutomationData[] = [];
    for (const schedule of schedules) {
      const saved = await create({
        name: `QA ${schedule.kind}`,
        enabled: false,
        schedule,
        prompt: "Report the current task status.",
      });
      assert.equal(saved.schedule.kind, schedule.kind);
      if (saved.schedule.kind === "every") {
        assert.ok(
          Number.isSafeInteger(saved.schedule.anchorMs),
          "native interval normalization supplies the anchor",
        );
      }
      assert.deepEqual(await get(saved.id), saved);
      created.push(saved);
    }
    const first = created[0]!;
    const enabled = job(
      (
        await call("PATCH", `/${first.id}`, {
          enabled: true,
          expectedConfigRevision: first.configRevision,
        })
      )?.data,
    );
    assert.equal(enabled.enabled, true);
    const paused = job(
      (
        await call("PATCH", `/${first.id}`, {
          enabled: false,
          name: "Paused by OCC",
          expectedConfigRevision: enabled.configRevision,
        })
      )?.data,
    );
    assert.equal(paused.enabled, false);
    await call(
      "PATCH",
      `/${first.id}`,
      { enabled: true, expectedConfigRevision: first.configRevision },
      409,
    );
    await call(
      "DELETE",
      `/${first.id}?expectedConfigRevision=${encodeURIComponent(first.configRevision)}`,
      undefined,
      409,
    );
    assert.equal(
      (await get(first.id)).configRevision,
      paused.configRevision,
      "stale mutations have no effect",
    );
    const inventory = asRecord((await call("GET", "?offset=0&limit=1"))?.data);
    assert.ok(inventory && Array.isArray(inventory.jobs));
    assert.equal(inventory.jobs.length, 1);
    assert.equal(inventory.total, 3);
    assert.equal(inventory.nextOffset, 1);
    await call(
      "POST",
      "",
      { name: "Denied origin", enabled: false, schedule: schedules[0], prompt: "No dispatch" },
      403,
      { ...headers, origin: "https://other.example.test", "sec-fetch-site": "cross-site" },
    );
    await call("GET", "", undefined, 403, { "x-api-key": f.serviceKey });

    async function scheduledToolEffect(label: string): Promise<string> {
      const marker = `automation-${randomUUID()}`;
      let id: string | undefined;
      await verifyQaToolAction(f, agent, marker, async (file) => {
        const scheduled = await create({
          name: label,
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 30_000).toISOString() },
          prompt: `Use your command execution tool to write exactly ${marker} to ${file}. Then reply DONE.`,
        });
        id = scheduled.id;
        const history = await f.waitFor(
          "scheduled Agent tool turn",
          async () => {
            const history = await runs(scheduled.id);
            return history.runs.length > 0 && history;
          },
          600_000,
        );
        assert.equal(history.runs[0]?.status, "ok");
        assert.equal(history.runs[0]?.completionStatus, "succeeded");
      });
      assert.ok(id);
      await call("GET", `/${id}`, undefined, 404);
      assert.ok(
        (await runs(id)).runs[0]?.runId,
        "retained ownership admits history after one-shot deletion",
      );
      pending.delete(id);
      return id;
    }
    const completedId = await scheduledToolEffect("Scheduled tool proof before replacement");

    // A new deployed revision preserves native jobs and their OCC ownership records.
    await f.deployAndWait(agent);
    assert.equal((await get(paused.id)).enabled, false);
    assert.ok((await runs(completedId)).runs[0]?.runId);
    await scheduledToolEffect("Scheduled tool proof after replacement");
    const revision = await get(paused.id);
    await call(
      "DELETE",
      `/${paused.id}?expectedConfigRevision=${encodeURIComponent(revision.configRevision)}`,
      undefined,
      204,
    );
    pending.delete(paused.id);
    await call("GET", `/${paused.id}`, undefined, 404);
    await call("GET", `/${paused.id}/runs`, undefined, 404);
    await f.record(`automations-${agent.preset}`, {
      agentId: agent.id,
      revisionId: agent.revision.id,
      completedJobId: completedId,
      scheduledToolEffectsVerified: 2,
      historyAfterDeletionVerified: true,
    });
  } finally {
    for (const id of pending) {
      const response = await transport.rawRequest("GET", `${base}/${id}`, { headers });
      if (response.response.status === 404) {
        continue;
      }
      assert.equal(response.response.status, 200, "automation cleanup must resolve current state");
      const current = job(asRecord(JSON.parse(response.text))?.data);
      await call(
        "DELETE",
        `/${id}?expectedConfigRevision=${encodeURIComponent(current.configRevision)}`,
        undefined,
        204,
      );
    }
  }
}
