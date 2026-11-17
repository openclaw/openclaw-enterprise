import assert from "node:assert/strict";
import test from "node:test";
import { createAlternateProcessFixture } from "../fixtures/repository-credentials/alternate-process.ts";

test(
  "process shutdown reports unresolved ownership and exits within grace",
  // Leave time for the elapsed assertion to diagnose an incorrect 10 s last-write window.
  { timeout: 20_000 },
  async (t) => {
    const fixture = await createAlternateProcessFixture(t, { shutdownGraceMs: 100 });
    const service = fixture.start("unresolved-rotation");
    await service.ready;

    const started = performance.now();
    const outcome = await service.stop("SIGTERM");
    const elapsed = performance.now() - started;
    assert.equal(outcome.code, 1);
    assert.equal(outcome.signal, null);
    // Unresolved custody must exit within the 100 ms grace, with room here for a loaded runner.
    assert.ok(elapsed < 2000, `shutdown took ${elapsed.toFixed(0)} ms`);

    const records = service
      .output()
      .flatMap((output) => output.split("\n").filter((line) => line.startsWith("{")));
    const summary = records
      .map((line): unknown => {
        try {
          return JSON.parse(line);
        } catch {
          assert.fail("alternate service emitted an invalid JSON record");
        }
      })
      .find(
        (record) =>
          record !== null &&
          typeof record === "object" &&
          "event" in record &&
          record.event === "shutdown",
      );
    assert.ok(
      summary !== null &&
        typeof summary === "object" &&
        "graceExpired" in summary &&
        summary.graceExpired === true,
      "missing shutdown grace expiry",
    );
    assert.ok(
      ("unresolved" in summary && summary.unresolved === true) ||
        ("pendingActions" in summary &&
          typeof summary.pendingActions === "number" &&
          summary.pendingActions > 0),
      "shutdown did not report unresolved ownership",
    );
    assert.ok(!("bearer" in summary), "shutdown summary exposed a bearer");
  },
);
