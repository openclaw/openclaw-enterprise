import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  AgentRevisionWire,
  AgentRuntimeLogPageWire,
  AgentWire,
  CredentialSourceWire,
} from "../../packages/contracts/src/api/resources.ts";
import { waitUntil } from "../helpers/wait-for.ts";

const selection = "OCC_TEST_OPENSHELL_CREDENTIAL_SERVICE_PAT_AGENT";

test(
  "A dedicated Codex Agent uses its admitted CredentialService PAT Source for a live model turn",
  {
    skip: process.env[`${selection}_REAL`] !== "1" && "requires an owned active native PAT Agent",
    timeout: 10 * 60_000,
  },
  async () => {
    const origin = new URL(process.env.OCC_URL ?? "");
    assert.ok(
      origin.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) &&
        origin.href === origin.origin + "/",
      "Use a loopback OCC origin.",
    );
    const namespaceId = process.env[`${selection}_NAMESPACE_ID`] ?? "";
    const agentId = process.env[`${selection}_ID`] ?? "";
    assert.match(namespaceId, /^ns_[a-f0-9-]{36}$/);
    assert.match(agentId, /^agt_[a-f0-9-]{36}$/);
    const keyFile = process.env.OCC_SERVICE_KEY_FILE;
    assert.ok(keyFile, "Select the Installation service-key response file.");
    let serviceKey: string;
    try {
      const value: unknown = JSON.parse(await readFile(keyFile, "utf8")).data?.key;
      assert.ok(typeof value === "string" && /^\S+$/.test(value));
      serviceKey = value;
    } catch {
      throw new Error("Could not read the prepared Installation service-key response.");
    }

    async function request(path: string, body?: unknown): Promise<Response> {
      const url = new URL(path, origin);
      assert.equal(url.origin, origin.origin);
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(body === undefined ? 30_000 : 8 * 60_000),
        headers: { "x-api-key": serviceKey, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 200, "The live OCC request must succeed.");
      return response;
    }

    async function get<T>(path: string): Promise<T> {
      return ((await (await request(path)).json()) as { data: T }).data;
    }

    const base = `/namespaces/${namespaceId}`;
    const agentPath = `${base}/agents/${agentId}`;
    const agent = await get<AgentWire>(agentPath);
    const revisionId = agent.activeRevisionId;
    assert.ok(revisionId, "Use an active Agent with a settled PAT-backed revision.");
    const revision = await get<AgentRevisionWire>(`${agentPath}/revisions/${revisionId}`);
    assert.equal(revision.id, revisionId);
    assert.equal(revision.agentId, agentId);
    assert.equal(revision.namespaceId, namespaceId);
    assert.equal(revision.harness.id, "codex");
    assert.equal(revision.harness.mode, "dedicated");
    assert.ok(revision.harnessAuth.method === "credential_source");
    const { sourceId } = revision.harnessAuth;
    assert.ok(revision.credentialSources?.some((ref) => ref.sourceId === sourceId));
    const source = await get<CredentialSourceWire>(`${base}/credential-sources/${sourceId}`);
    assert.ok(source.id === sourceId && source.namespaceId === namespaceId);
    assert.ok(source.state === "ready" && source.type === "static");
    assert.equal(source.config.provider_preset, "codex-pat");

    const logsPath = `${agentPath}/deployments/${revisionId}/runtime/logs?source=sandbox&tailLines=1000`;
    let cursor: string | undefined;
    async function nextLogPage(): Promise<AgentRuntimeLogPageWire> {
      const query =
        cursor === undefined ? "sinceSeconds=1" : `cursor=${encodeURIComponent(cursor)}`;
      const page = await get<AgentRuntimeLogPageWire>(`${logsPath}&${query}`);
      assert.equal(page.revisionId, revisionId);
      assert.ok(page.cursor, "The Supervisor log must support cursor-based follow.");
      if (cursor !== undefined) {
        assert.ok(
          page.records.every((record) => record.type !== "gap" || record.reason === "truncated"),
          "The Supervisor log must remain continuous across the turn.",
        );
      }
      cursor = page.cursor;
      return page;
    }
    // Drain the entire initial window before chat, including any wire-size continuation pages.
    await waitUntil(
      "the pre-turn Supervisor log boundary",
      async () => !(await nextLogPage()).truncated,
    );
    const nonce = `PAT-${randomUUID()}`;
    const chat = await request(`/agents/${agentId}/chat`, {
      messages: [{ role: "user", content: `Reply with exactly ${nonce} and nothing else.` }],
      stream: false,
    });
    const { choices } = (await chat.json()) as {
      choices: { message: { role: string; content: string } }[];
    };
    assert.ok(
      choices[0]?.message.role === "assistant" && choices[0].message.content.trim() === nonce,
      "The live Agent must return the fresh nonce.",
    );
    await waitUntil(
      "a new allowed HTTPS model request on the PAT revision",
      async () => {
        const page = await nextLogPage();
        return page.records.some(
          (record) =>
            record.type === "line" &&
            record.kind === "sandbox" &&
            record.decision?.decision === "allowed" &&
            record.fields?.method === "POST" &&
            typeof record.fields.url === "string" &&
            URL.parse(record.fields.url)?.href ===
              "https://chatgpt.com/backend-api/codex/responses",
        );
      },
      { timeoutMs: 30_000, intervalMs: 1000 },
    );
    assert.equal((await get<AgentWire>(agentPath)).activeRevisionId, revisionId);
  },
);
