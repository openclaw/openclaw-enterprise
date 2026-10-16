// Portable producer/owner contract check for UUIDv7 replay admission. There is no provider send.
// The existing supplier fixture owns a real signed gRPC exchange and fixture installation evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { staticEgressFixture } from "../../../tests/helpers/static-egress.mjs";

const root = new URL("../../../", import.meta.url);
const proto = "apps/controller/src/drivers/egress-proxy/proto/supervisor_middleware.proto";
const require = createRequire(new URL("apps/controller/package.json", root));
const loader = require("@grpc/proto-loader");
const codec = loader.loadSync(fileURLToPath(new URL(proto, root)), {
  keepCase: true,
  longs: String,
  enums: Number,
  defaults: false,
  oneofs: true,
})["openshell.middleware.v1.HttpCredentialResolveRequest"];

test("supplier refuses a UUIDv4 use before material, then accepts Strands' actual UUIDv7 and deadline in a signed opening", async (t) => {
  const f = await staticEgressFixture(t);
  const before = f.secretReads;
  const old = f.capture();
  old.request.context.request_id = randomUUID();
  const negative = await f.resolve(old);
  assert.equal(negative.refused?.code, 5, "supplier's deadline_exceeded refusal, before material");
  assert.equal(f.secretReads, before);

  const temp = mkdtempSync(join(tmpdir(), "strands-operation-wire-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const wire = join(temp, "operation.pb");
  execFileSync(
    "cargo",
    ["test", "--profile", "distribution", "--locked", "operation_context_and_deadline_share"],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, STRANDS_TEST_OPERATION_WIRE: wire },
      stdio: "pipe",
    },
  );
  // Preserve the fixture's enrolled sandbox and custody. Substitute the exact request ID and
  // deadline from the production Rust operation producer, then assert the values actually signed.
  const produced = codec.deserialize(readFileSync(wire));
  const captured = f.capture();
  captured.request.context.request_id = produced.request.context.request_id;
  captured.deadline = produced.deadline;
  const exchange = await f.beginExchange();
  const opening = exchange.opening(captured);
  const sent = codec.deserialize(opening.open.resolve_request);
  assert.equal(sent.request.context.request_id, produced.request.context.request_id);
  assert.deepEqual(sent.deadline, produced.deadline);
  exchange.stream.write(opening);
  const { resolved } = await exchange.next();
  assert.ok(
    resolved.ready,
    "actual signed opening admitted by the owning Credential Proxy verifier and replay rule",
  );
  assert.equal(f.secretReads, before + 1);
  assert.equal(
    f.providerRequests.length,
    0,
    "this admission check never authorizes or starts a provider send",
  );
  exchange.stream.end();
});
