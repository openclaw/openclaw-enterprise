import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { text } from "node:stream/consumers";
import test from "node:test";

import type { AgentRevisionWire, AgentWire } from "../../packages/contracts/src/api/resources.ts";

test(
  "an active stock Strands Box revision answers a fresh Codex model turn",
  { skip: process.env.OCC_TEST_STRANDS_STOCK_MODEL !== "1", timeout: 600_000 },
  async (t) => {
    const origin = new URL(process.env.OCC_URL ?? "");
    assert.ok(
      origin.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(origin.hostname) &&
        origin.href === origin.origin + "/",
      "Use a numeric loopback OCC origin.",
    );
    const namespace = process.env.OCC_NAMESPACE ?? "";
    const agent = process.env.OCC_TEST_PROVIDER_AGENT ?? "";
    assert.match(namespace, /^ns_[a-f0-9-]{36}$/);
    assert.match(agent, /^agt_[a-f0-9-]{36}$/);
    const sourceId = process.env.OCC_TEST_STRANDS_STOCK_SOURCE_ID;
    if (sourceId !== undefined) {
      assert.match(sourceId, /^cs_[a-f0-9-]{36}$/);
    }
    const keyFile = process.env.OCC_SERVICE_KEY_FILE;
    assert.ok(keyFile);
    let key: string;
    try {
      const value: unknown = JSON.parse(await readFile(keyFile, "utf8")).data?.key;
      assert.ok(
        typeof value === "string" && /^occ_(?:[A-Za-z0-9_-]{43}|[A-Za-z]{64})$/.test(value),
      );
      key = value;
    } catch {
      throw new Error("Expected an OCC service-key response file.");
    }

    async function request(path: string, body?: unknown) {
      const url = new URL(path, origin);
      assert.equal(url.origin, origin.origin);
      // A one-use HTTP agent ignores the global proxy and does not follow redirects.
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        httpRequest(
          url,
          {
            agent: false,
            method: body === undefined ? "GET" : "POST",
            headers: { "x-api-key": key, "content-type": "application/json" },
            signal: AbortSignal.timeout(body === undefined ? 30_000 : 480_000),
          },
          resolve,
        )
          .on("error", reject)
          .end(JSON.stringify(body));
      });
      if (response.statusCode !== 200) {
        response.destroy();
        assert.fail(`Unexpected OCC status ${response.statusCode}`);
      }
      return JSON.parse(await text(response));
    }

    const path = `/namespaces/${namespace}/agents/${agent}`;
    async function activeRevision() {
      const { data }: { data: AgentWire } = await request(path);
      assert.equal(data.desiredRuntimeState, "running");
      assert.ok(data.activeRevisionId);
      return data.activeRevisionId;
    }
    const id = await activeRevision();
    const { data: revision }: { data: AgentRevisionWire } = await request(
      `${path}/revisions/${id}`,
    );
    assert.equal(revision.harness.id, "codex");
    assert.equal(revision.harness.mode, "dedicated");
    if (sourceId === undefined) {
      assert.equal(
        revision.sandboxDriverId,
        "strands-box-sandbox-stock-model-credential-preview-v1",
      );
      assert.equal(revision.harnessAuth.method, "api_key");
    } else {
      assert.equal(revision.sandboxDriverId, "strands-box-sandbox-stock-model-source-v1");
      assert.deepEqual(revision.harnessAuth, { method: "credential_source", sourceId });
    }

    // A new conversation excludes previous replies and keeps the prepared Agent's sessions intact.
    const nonce = `BOX_LAB_CHALLENGE_${randomBytes(12).toString("hex")}`;
    t.diagnostic(`Challenge SHA-256 ${createHash("sha256").update(nonce).digest("hex")}`);
    const reply = await request(`/agents/${agent}/chat`, {
      user: nonce,
      messages: [{ role: "user", content: `Reply with exactly ${nonce}.` }],
      stream: false,
    });
    const message = reply.choices[0]?.message;
    assert.ok(message?.role === "assistant" && message.content?.trim() === nonce);
    assert.equal(await activeRevision(), id);
  },
);
