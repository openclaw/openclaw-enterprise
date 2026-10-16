// Exact production body+header projection -> authentic signed OCE resolution/final check/protection.
// Installation and the actual TLS origin are the supplier's fixture; this is not installed containment.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { staticEgressFixture } from "../../../tests/helpers/static-egress.mjs";

test("only the matching optional workspace telemetry is removed before the signed Responses operation and TLS origin", async (t) => {
  const key = "x-codex-turn-metadata";
  const marker = "synthetic-private-workspace-marker";
  const dir = mkdtempSync(join(tmpdir(), "strands-workspace-projection-peer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = new URL("../", import.meta.url);
  const manifest = execFileSync(
    "cargo",
    ["test", "--profile", "distribution", "--locked", "--no-run", "--message-format", "json"],
    { cwd, encoding: "utf8", maxBuffer: 8_000_000 },
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  const { executable } = manifest.find(
    (m) => m.profile?.test && m.executable && m.target.name === "strands-credential-proxy",
  );
  function request(extra = {}) {
    const metadata = JSON.stringify({
      turn_id: "fixture",
      request_kind: "turn",
      ...extra,
      workspaces: { ["/checkout/" + marker]: { has_changes: false } },
    });
    return {
      body: JSON.stringify({
        model: "fixture-model",
        input: "hello",
        store: false,
        client_metadata: { [key]: metadata },
      }),
      headers: [
        ["content-type", "application/json"],
        [key, metadata],
      ],
    };
  }
  function project(peer, label) {
    const input = join(dir, label + ".in");
    const output = join(dir, label + ".out");
    writeFileSync(input, JSON.stringify(peer), { mode: 0o600 });
    execFileSync(
      executable,
      ["--ignored", "--exact", "responses_capture::tests::portable_workspace_projection_peer"],
      {
        env: {
          ...process.env,
          STRANDS_WORKSPACE_PROJECTION_INPUT: input,
          STRANDS_WORKSPACE_PROJECTION_OUTPUT: output,
        },
      },
    );
    return JSON.parse(readFileSync(output));
  }
  const f = await staticEgressFixture(t);
  function capture(peer) {
    const c = f.capture();
    c.request.body = Buffer.from(peer.body);
    c.request.headers = peer.headers.map(([name, value]) => ({ name, value }));
    return c;
  }
  const raw = request();
  const before = f.secretReads;
  assert.ok(
    (await f.resolve(capture(raw))).refused,
    "unprojected native workspace not admissible by the real owner",
  );
  const unknown = project(request({ unapproved_synthetic_field: true }), "unknown");
  assert.match(unknown.body, /unapproved_synthetic_field/);
  assert.ok(
    (await f.resolve(capture(unknown))).refused,
    "projection cannot smuggle an independent unknown field through the signed owner",
  );
  assert.equal(f.secretReads, before);
  assert.equal(f.providerRequests.length, 0);

  const p = project(raw, "matching");
  const c = capture(p);
  const ready = (await f.resolve(c)).ready;
  assert.ok(ready, "real authority admitted the projected operation");
  assert.ok(
    (await f.authorize(f.permitRequest(c, ready))).allowed,
    "same operation freshly checked for one send",
  );
  const origin = await f.send(c, ready);
  const safe = await f.protect(c, origin);
  assert.ok(safe.response_complete);
  assert.equal(f.providerRequests.length, 1);
  const received = f.providerRequests[0];
  const turn = received.body.client_metadata[key];
  assert.equal(
    received.headers[key],
    turn,
    "the actual origin did not receive a stale workspace-bearing header",
  );
  assert.deepEqual(JSON.parse(turn), { request_kind: "turn", turn_id: "fixture" });
  assert.equal(
    JSON.stringify({ body: received.body, headers: received.headers }).includes(marker),
    false,
  );
});
