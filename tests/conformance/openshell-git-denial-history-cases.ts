import assert from "node:assert/strict";
import test from "node:test";
import { openShellGitDenialFailureStage } from "../helpers/openshell-git-denial.mjs";
import {
  denial,
  fixture,
  interval,
  line,
  marker,
  refusalAt,
  warning,
} from "./openshell-git-denial-receipt-fixture.ts";

export function registerGitDenialHistoryCases() {
  test("Git denial receipt tolerates ring rollover only with unchanged retained history", async () => {
    // Keeping the original anchor is insufficient when an intermediate poll's
    // appended record disappears before the purported proof arrives.
    const rewritten = fixture([line(1)]);
    const rewrittenBefore = await rewritten.observer.snapshot();
    let reads = 0;
    rewritten.afterRead(() => {
      reads += 1;
      rewritten.set(reads === 1 ? [line(1), line("removed")] : [line(1), warning, denial]);
    });
    await assert.rejects(
      rewritten.observer.expectAfter(rewrittenBefore, interval),
      refusalAt("log-history", /Git denial (baseline anchor|log history)/),
    );
    // A repeated post-boundary record cannot be reinterpreted as its identical
    // pre-boundary copy when a later full ring rewrites the observed suffix.
    const repeated = line("repeated");
    const unique = line("unique-boundary");
    const aliased = fixture([repeated, unique]);
    const aliasedBefore = await aliased.observer.snapshot();
    let aliasedReads = 0;
    aliased.afterRead(() => {
      aliasedReads += 1;
      aliased.set(
        aliasedReads === 1
          ? [repeated, unique, repeated]
          : [
              repeated,
              unique,
              ...Array.from({ length: 1996 }, (_, index) => line(`replacement-${index}`)),
              warning,
              denial,
            ],
      );
    });
    await assert.rejects(
      aliased.observer.expectAfter(aliasedBefore, interval),
      refusalAt("log-history", /Git denial (baseline anchor|log history)/),
    );
    const baseline = Array.from({ length: 2000 }, (_, index) => line(index));
    const f = fixture(baseline);
    const before = await f.observer.snapshot();
    f.set([...baseline.slice(3), warning, denial, marker]);
    assert.equal((await f.observer.expectAfter(before, interval)).count, 1);

    const lastLine = baseline.at(-1);
    assert.ok(lastLine);
    for (const changed of [
      [line("reset"), warning, denial],
      [lastLine, warning, denial],
      [...baseline.slice(3), lastLine, warning, denial],
      [line("rewritten"), ...baseline.slice(3), warning, denial],
    ]) {
      f.set(changed);
      await assert.rejects(
        f.observer.expectAfter(before, interval),
        /Git denial (baseline anchor|log history)/,
      );
    }
  });

  test("Git denial receipt refuses foreign, incomplete, and ambiguous log histories", async () => {
    const privateError = Object.assign(new Error("private transport failure"), {
      stage: "private stage must not escape",
    });
    assert.equal(openShellGitDenialFailureStage(privateError), undefined);
    const unavailable = fixture([line(1)]);
    const unavailableBefore = await unavailable.observer.snapshot();
    unavailable.afterRead(() => {
      throw privateError;
    });
    await assert.rejects(
      unavailable.observer.expectAfter(unavailableBefore, interval),
      (error: unknown) => {
        assert.equal(error, privateError);
        assert.equal(openShellGitDenialFailureStage(error), "log-read");
        return true;
      },
    );
    const f = fixture([line(1)]);
    const before = await f.observer.snapshot();
    f.set([line(1), warning, { ...denial, sandboxId: "sandbox-two" }]);
    await assert.rejects(f.observer.expectAfter(before, interval), /different Sandbox/);
    f.set([line(1), warning, denial, { ...marker, sandboxId: "sandbox-two" }]);
    await assert.rejects(f.observer.expectAfter(before, interval), /different Sandbox/);
    f.set([line(1), warning, denial], 4);
    await assert.rejects(f.observer.expectAfter(before, interval), /incomplete/);
    f.set([line(1), line(1)]);
    await assert.rejects(f.observer.snapshot(), /ambiguous/);
    await assert.rejects(f.observer.expectAfter({}, interval), /own baseline/);

    const empty = fixture([]);
    const emptyBefore = await empty.observer.snapshot();
    empty.set([...Array.from({ length: 1998 }, (_, index) => line(index)), warning, denial]);
    await assert.rejects(
      empty.observer.expectAfter(emptyBefore, interval),
      /lost its empty baseline/,
    );
  });

  test("Git denial receipt rejects normalized or noncanonical event dates", async () => {
    const f = fixture([line(1)]);
    const before = await f.observer.snapshot();
    for (const time of [null, "2026-11-05T12:00:00.002Z", "2026-11-31T12:00:00.002000000Z"]) {
      f.set([line(1), warning, { ...denial, time }]);
      await assert.rejects(
        f.observer.expectAfter(before, interval),
        refusalAt("event-time", /event time/),
      );
      f.set([line(1), { ...warning, time }, denial]);
      await assert.rejects(
        f.observer.expectAfter(before, interval),
        refusalAt("event-time", /event time/),
      );
    }
  });

  test("Git denial receipt refuses a replaced supervisor before or during the read", async () => {
    for (const duringRead of [false, true]) {
      const f = fixture([line(1)]);
      const before = await f.observer.snapshot();
      f.set([line(1), warning, denial]);
      if (duringRead) {
        f.afterRead(() => f.replaceSupervisor());
      } else {
        f.replaceSupervisor();
      }
      await assert.rejects(
        f.observer.expectAfter(before, interval),
        refusalAt("supervisor-identity", /supervisor identity changed/),
      );
    }
  });
}
