import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../../apps/controller/plugins/oce-slack-search/bin/oce-slack-search.ts", import.meta.url));
const placeholder = "openshell:resolve:env:s" + "1".repeat(64) + "_SLACK_SEARCH_TOKEN";

// Capture the worker CLI's outbound request on a separate fd and answer as Slack would.
function run(args: string[], token?: string, reply?: unknown) {
  const transport = `import { writeSync } from "node:fs";
    globalThis.fetch = async (url, init) => {
      const req = new Request(url, init);
      writeSync(3, JSON.stringify({url: req.url, method: req.method, redirect: req.redirect,
        authorization: req.headers.get("authorization"), body: await req.json()}));
      return Response.json(${JSON.stringify(reply ?? {})});
    };`;
  const result = spawnSync(
    process.execPath,
    ["--import", "data:text/javascript," + encodeURIComponent(transport), command, ...args],
    {
      encoding: "utf8",
      env: token ? { SLACK_SEARCH_TOKEN: token } : {},
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  assert.ifError(result.error);
  const wire = result.output[3];
  return { ...result, request: wire ? JSON.parse(wire) : undefined };
}

test("worker Slack search calls the public message API and preserves the matching thread link", () => {
  const permalink =
    "https://example.slack.com/archives/C0123/p1700000001000001?thread_ts=1700000000.000001&cid=C0123";
  const query = 'in:<#C0123> "release plan"';
  const result = run([query], placeholder, {
    ok: true,
    results: { messages: [{ content: "Release plan approved.", permalink }] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.request, {
    url: "https://slack.com/api/assistant.search.context",
    method: "POST",
    redirect: "error",
    authorization: "Bearer " + placeholder,
    body: { query, channel_types: ["public_channel"], content_types: ["messages"] },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    messages: [{ text: "Release plan approved.", permalink }],
  });
});

test("worker Slack search can show usage before setup and requires a scoped placeholder to send", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: oce-slack-search/);
  assert.equal(help.request, undefined);
  for (const token of [
    undefined,
    "xoxp-fixture",
    "openshell:resolve:env:SLACK_SEARCH_TOKEN",
    placeholder.replace("SLACK_SEARCH", "GITHUB"),
  ]) {
    const result = run(["release"], token);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires the Agent's managed Slack user connection/);
    assert.equal(result.request, undefined);
  }
});

test("worker Slack search surfaces Slack refusals and rejects links outside Slack", () => {
  const refusal = run(["release"], placeholder, { ok: false, error: "missing_scope" });
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /Slack search failed \(missing_scope\)/);
  const invalid = run(["release"], placeholder, {
    ok: true,
    results: {
      messages: [
        { content: "Found it", permalink: "https://slack.com.example.test/archives/C01/p123" },
      ],
    },
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Slack permalink/);
});
