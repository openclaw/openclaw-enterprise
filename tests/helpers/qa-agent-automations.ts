import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import {
  AgentAutomationSchema,
  AgentAutomationRunsPageSchema,
  type AgentAutomationCreateInput,
  type AgentAutomationData,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { GatewayClient } from "../../apps/controller/tests/fixtures/plugin-approval-client.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";
import { createConsoleFixtureTransport } from "./console-fixture-transport.ts";
import type { createQaInstallation, createQaAgent } from "./qa-installation.mjs";
import { registerQaSecret } from "./qa-secrets.ts";
import {
  qaCodexToolQualificationGaps,
  readQaAutomationRunEvidence,
  startQaCodexToolObservation,
} from "./qa-automation-evidence.ts";

type Fixture = Awaited<ReturnType<typeof createQaInstallation>>;
type Agent = Awaited<ReturnType<typeof createQaAgent>>;

/** Real OCC writes, native scheduling and runtime-owned evidence; no model/tool result is mocked. */
export async function verifyQaAgentAutomations(
  f: Fixture,
  agent: Agent,
): Promise<{ qualificationGaps: string[] }> {
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
  async function request(
    method: string,
    suffix = "",
    body?: unknown,
    selectedHeaders: Record<string, string> = headers,
  ) {
    const result = await transport.rawRequest(method, base + suffix, {
      headers: selectedHeaders,
      body,
      timeout: 40_000,
    });
    const envelope = result.text ? asRecord(JSON.parse(result.text)) : undefined;
    const location = result.response.headers.get("location");
    if (method === "POST" && location?.startsWith(base + "/")) {
      const id = location.slice(base.length + 1);
      if (/^[0-9a-f-]{36}$/u.test(id)) {
        pending.add(id);
      }
    }
    return { status: result.response.status, envelope };
  }
  async function call(
    method: string,
    suffix = "",
    body?: unknown,
    expected = 200,
    selectedHeaders: Record<string, string> = headers,
  ) {
    const result = await request(method, suffix, body, selectedHeaders);
    assert.equal(
      result.status,
      expected,
      `Automation ${method} returned ${result.status}; expected ${expected}`,
    );
    return result.envelope?.data;
  }
  function job(value: unknown): AgentAutomationData {
    assert.ok(
      Check(AgentAutomationSchema, value),
      "OCC must return its supported automation contract",
    );
    return value;
  }
  async function get(id: string) {
    return job(await call("GET", `/${id}`));
  }
  async function create(input: AgentAutomationCreateInput) {
    const saved = job(await call("POST", "", input, 201));
    pending.add(saved.id);
    return saved;
  }
  async function update(current: AgentAutomationData, patch: Record<string, unknown>) {
    return job(
      await call("PATCH", `/${current.id}`, {
        ...patch,
        expectedConfigRevision: current.configRevision,
      }),
    );
  }
  async function runs(id: string) {
    const result = await request("GET", `/${id}/runs?limit=20`);
    if (result.status === 404) {
      return undefined;
    }
    assert.equal(
      result.status,
      200,
      "native history must be readable through retained OCC ownership",
    );
    const data = result.envelope?.data;
    assert.ok(Check(AgentAutomationRunsPageSchema, data));
    return data;
  }
  async function openObserver() {
    const gateway = await f.gatewayUrl(agent);
    const connected = Promise.withResolvers<void>();
    const client = new GatewayClient({
      url: gateway.url.replace(/^http/u, "ws"),
      password: gateway.gatewayPassword,
      clientName: "gateway-client",
      mode: "backend",
      role: "operator",
      scopes: ["operator.admin"],
      deviceIdentity: null,
      hostDeps: { logError: () => {}, logDebug: () => {} },
      onHelloOk: () => connected.resolve(),
      onConnectError: () =>
        connected.reject(new Error("Native automation observer could not connect.")),
    });
    const timer = setTimeout(
      () => connected.reject(new Error("Native automation observer timed out.")),
      15_000,
    );
    try {
      client.start();
      await connected.promise;
    } catch (error) {
      client.stop();
      await gateway.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      client,
      async close() {
        client.stop();
        await client.stopAndWait({ timeoutMs: 1000 });
        await gateway.close();
      },
    };
  }
  let observer = await openObserver();
  async function nativeJob(id: string) {
    const page = await observer.client.request<{ jobs: unknown[] }>("cron.list", {
      includeDisabled: true,
      includeDeliveryPreviews: false,
      limit: 200,
      offset: 0,
    });
    assert.ok(Array.isArray(page.jobs));
    const found = page.jobs
      .map(asRecord)
      .filter((value) => value?.declarationKey === `occ-automation:${id}`);
    assert.equal(found.length, 1, "the exact OCC declaration must map to one native job");
    const value = found[0]!;
    assert.equal(typeof value.id, "string");
    assert.deepEqual(
      asRecord(value.payload)?.toolsAllow,
      [],
      "OCC must persist an explicit empty cap",
    );
    return value as Record<string, unknown> & { id: string };
  }
  async function waitRun(id: string, prior = new Set<string>()) {
    const result = await f.waitFor(
      "real scheduled model-only completion",
      async () => {
        const page = await runs(id);
        return page?.runs.find((run) => !prior.has(run.runId));
      },
      600_000,
    );
    assert.equal(result.status, "ok", "the scheduled model turn must complete successfully");
    assert.equal(result.completionStatus, "succeeded");
    return result;
  }
  async function oneShot(label: string) {
    const marker = `MODEL_ONLY_${randomUUID()}`;
    const saved = await create({
      name: label,
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() + 25_000).toISOString() },
      prompt: `Produce a completed text result. Put ${marker} in your final summary. Do not request any tools.`,
    });
    await nativeJob(saved.id);
    const run = await waitRun(saved.id);
    assert.ok(run.summary?.includes(marker), "history must retain the actual model result");
    await f.waitFor("native one-shot deletion", async () => {
      const response = await request("GET", `/${saved.id}`);
      assert.ok(response.status === 200 || response.status === 404);
      return response.status === 404;
    });
    assert.ok((await runs(saved.id))?.runs.some((value) => value.runId === run.runId));
    pending.delete(saved.id);
    return { id: saved.id, runId: run.runId };
  }
  async function policy(allow: string[]) {
    const path = `/namespaces/${agent.namespaceId}/configurations/${agent.configuration.id}`;
    const current = await f.api("GET", path);
    const values = structuredClone(current.values);
    values.tools = { ...values.tools, allow };
    delete values.tools.alsoAllow;
    agent.configuration = await f.api("PATCH", path, { values });
  }
  async function negativeTurn(current: AgentAutomationData, phase: string) {
    const marker = `MODEL_ONLY_NEGATIVE_${randomUUID()}`;
    const role = agent.preset === "Codex" ? "agent" : "gateway";
    const workspace =
      agent.preset === "Codex" ? "/home/node/workspace" : "/home/node/.openclaw/workspace";
    const file = `${workspace}/occ-model-only-${randomUUID()}`;
    const workload = await f.pod(agent, role);
    const identity = {
      uid: workload.metadata.uid,
      container: workload.status.containerStatuses.find(
        (value: { name: string }) => value.name === role,
      ).containerID,
    };
    async function fileCheck(action: "precheck" | "absent" | "cleanup") {
      const selected = await f.pod(agent, role);
      assert.equal(selected.metadata.uid, identity.uid);
      assert.equal(
        selected.status.containerStatuses.find((value: { name: string }) => value.name === role)
          .containerID,
        identity.container,
      );
      const script = `const fs=require('node:fs'); const file=${JSON.stringify(file)}; const action=${JSON.stringify(action)};
        if(action==='precheck'){if(fs.lstatSync(file,{throwIfNoEntry:false}))throw Error('proof path exists');fs.writeFileSync(file,'fixture-write-probe',{flag:'wx'});fs.unlinkSync(file);}
        if(action==='absent'&&fs.lstatSync(file,{throwIfNoEntry:false}))throw Error('scheduled model produced a forbidden file effect');
        if(action==='cleanup')fs.rmSync(file,{force:true,recursive:true});`;
      await f.execRole(agent, role, ["node", "-e", ...nodeProgramArguments(script)]);
    }
    await fileCheck("precheck");
    const previous = new Set((await runs(current.id))?.runs.map((run) => run.runId) ?? []);
    // A daily cron slot fires soon once, then cannot race evidence collection with
    // a second model run. A short interval could repeat before pause reaches native.
    const fireAt = new Date(Date.now() + 35_000);
    if (fireAt.getUTCSeconds() === 0) {
      fireAt.setUTCSeconds(1);
    }
    current = await update(current, {
      enabled: false,
      schedule: {
        kind: "cron",
        expr: `${fireAt.getUTCSeconds()} ${fireAt.getUTCMinutes()} ${fireAt.getUTCHours()} * * *`,
        tz: "UTC",
      },
      prompt: `This is a capability-boundary report. If any command, code, file-writing or delegation tool is available, use it to write exactly ${marker} to ${file}; do not merely describe an available tool. Do not contact people or external services. If tools are unavailable, do not simulate calls. Finish with a completed text summary containing ${marker}.`,
    });
    const native = await nativeJob(current.id);
    const live =
      agent.preset === "Codex" ? startQaCodexToolObservation(f, agent, marker) : undefined;
    try {
      current = await update(current, { enabled: true });
      const run = await waitRun(current.id, previous);
      current = await update(await get(current.id), { enabled: false });
      assert.ok(run.summary?.includes(marker));
      const nativeHistory = await observer.client.request<{ entries: unknown[] }>("cron.runs", {
        id: native.id,
        offset: 0,
        limit: 20,
      });
      const matched = nativeHistory.entries
        .map(asRecord)
        .find((entry) => entry?.runId === run.runId);
      assert.ok(
        matched && typeof matched.sessionId === "string" && typeof matched.sessionKey === "string",
        "native history must identify this completed run's exact session",
      );
      const evidence = await readQaAutomationRunEvidence(f, agent, {
        sessionKey: matched.sessionKey,
        sessionId: matched.sessionId,
        marker,
      });
      await fileCheck("absent");
      const nativePolicy = await live;
      await f.record(`automations-${agent.id}-${phase}`, {
        agentId: agent.id,
        revisionId: agent.revision.id,
        jobId: current.id,
        runId: run.runId,
        fixedEmptyCap: true,
        fileAbsent: true,
        ...evidence,
        nativePolicy,
        nativeInventoryScope:
          "Gateway direct/deferred; native dynamic declarations, feature-state diagnostics and per-thread MCP/app discovery metadata; native built-in inventory incomplete",
      });
      const qualificationGaps = nativePolicy
        ? qaCodexToolQualificationGaps(nativePolicy, evidence.native?.threadId)
        : [];
      return { job: current, runId: run.runId, qualificationGaps };
    } finally {
      await fileCheck("cleanup");
      await live?.catch(() => undefined);
    }
  }

  const failures: unknown[] = [];
  let outcome: { qualificationGaps: string[] } | undefined;
  try {
    const created: AgentAutomationData[] = [];
    for (const schedule of [
      { kind: "at" as const, at: new Date(Date.now() + 3_600_000).toISOString() },
      { kind: "every" as const, everyMs: 86_400_000 },
      { kind: "cron" as const, expr: "0 9 * * *", tz: "UTC" },
    ]) {
      const saved = await create({
        name: `Model-only ${schedule.kind}`,
        enabled: false,
        schedule,
        prompt: "Return a completed text status.",
      });
      assert.equal(saved.schedule.kind, schedule.kind);
      if (saved.schedule.kind === "every") {
        assert.ok("anchorMs" in saved.schedule && Number.isSafeInteger(saved.schedule.anchorMs));
      }
      assert.deepEqual(await get(saved.id), saved);
      await nativeJob(saved.id);
      created.push(saved);
    }
    const first = created[0]!;
    const enabled = await update(first, { enabled: true });
    const paused = await update(enabled, { enabled: false, name: "Paused model-only job" });
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
    assert.equal((await get(first.id)).configRevision, paused.configRevision);
    const inventory = asRecord(await call("GET", "?limit=1"));
    assert.equal(inventory?.total, 3);
    assert.equal(inventory?.nextOffset, 1);
    await call(
      "POST",
      "",
      {
        name: "Client policy rejected",
        enabled: false,
        schedule: first.schedule,
        prompt: "No dispatch",
        toolsAllow: ["*"],
      },
      400,
    );
    await call("GET", "", undefined, 403, { "x-api-key": f.serviceKey });
    await call(
      "POST",
      "",
      { name: "Origin rejected", enabled: false, schedule: first.schedule, prompt: "No dispatch" },
      403,
      { ...headers, origin: "https://other.example.test", "sec-fetch-site": "cross-site" },
    );
    const one = await oneShot("Model-only one-shot before replacement");

    // Create the recurring record before changing Agent policy; its fixed cap must
    // survive both a stricter policy and a later widening through the ordinary API.
    let recurring = await create({
      name: "Model-only policy proof",
      enabled: false,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      prompt: "Return a completed text status.",
    });
    const originalNativeId = (await nativeJob(recurring.id)).id;
    await policy(["read"]);
    await observer.close();
    await f.deployAndWait(agent);
    observer = await openObserver();
    const restricted = await negativeTurn(await get(recurring.id), "restricted");
    recurring = restricted.job;
    const previousPod = await f.pod(agent, "gateway");
    await policy(["*"]);
    await observer.close();
    await f.deployAndWait(agent);
    observer = await openObserver();
    assert.notEqual((await f.pod(agent, "gateway")).metadata.uid, previousPod.metadata.uid);
    assert.equal((await get(recurring.id)).enabled, false);
    assert.equal((await nativeJob(recurring.id)).id, originalNativeId);
    assert.ok((await runs(one.id))?.runs.some((run) => run.runId === one.runId));
    const widened = await negativeTurn(await get(recurring.id), "widened");
    assert.notEqual(widened.runId, restricted.runId);
    const after = await oneShot("Model-only one-shot after replacement");
    const qualificationGaps = [
      ...new Set([...restricted.qualificationGaps, ...widened.qualificationGaps]),
    ];
    await f.record(`automations-${agent.id}-completed`, {
      agentId: agent.id,
      revisionId: agent.revision.id,
      modelOnlyOneShots: [one, after],
      negativeRuns: [restricted.runId, widened.runId],
      historyAfterDeletionVerified: true,
      policyWideningVerified: true,
      nativeIdentityRetained: true,
      qualificationGaps,
      completeToolSurfaceQualified: qualificationGaps.length === 0,
    });
    outcome = { qualificationGaps };
  } catch (error) {
    failures.push(error);
  }
  {
    try {
      for (const id of pending) {
        const response = await request("GET", `/${id}`);
        if (response.status === 404) {
          continue;
        }
        assert.equal(response.status, 200, "cleanup must resolve current automation state");
        const current = job(response.envelope?.data);
        await call(
          "DELETE",
          `/${id}?expectedConfigRevision=${encodeURIComponent(current.configRevision)}`,
          undefined,
          204,
        );
      }
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await observer.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Automation proof or cleanup failed", {
      cause: failures[0],
    });
  }
  assert.ok(outcome);
  return outcome;
}
