import assert from "node:assert/strict";
import test from "node:test";
import {
  denial,
  endedAt,
  executable,
  fixture,
  interval,
  line,
  marker,
  refusalAt,
  startedAt,
  warning,
} from "./openshell-git-denial-receipt-fixture.ts";

export function registerGitDenialPolicyCases() {
  test("Git denial receipt requires fresh evidence and retains the final millisecond bucket", async () => {
    const baseline = [warning, denial, line(1)];
    const f = fixture(baseline);
    const before = await f.observer.snapshot();
    assert.deepEqual(before, {});
    f.set([...baseline, warning, denial, marker]);
    assert.deepEqual(await f.observer.expectAfter(before, interval), {
      count: 1,
      reason: "transparent_tcp_policy_denied",
      policyReason: "endpoint-not-admitted",
      marker: "policy-dns-ineligible",
      executable,
      host: "github.com",
      port: 443,
      startedAt,
      endedAt,
    });
    f.set([
      ...baseline,
      { ...warning, fields: { ...warning.fields, destination: "[fd23:6f70:656e::1]:443" } },
      denial,
      { ...marker, time: "2026-11-05T12:00:00.004999999Z" },
    ]);
    assert.equal((await f.observer.expectAfter(before, interval)).count, 1);

    // A valid trailing warning may arrive before its OCSF record. Do not accept
    // the first complete pair until every observed staged denial is paired.
    const split = fixture([line(1)]);
    const splitBefore = await split.observer.snapshot();
    let reads = 0;
    split.afterRead(() => {
      reads += 1;
      split.set(
        reads === 1
          ? [line(1), warning, denial, warning]
          : [line(1), warning, denial, warning, denial, marker],
      );
    });
    assert.equal((await split.observer.expectAfter(splitBefore, interval)).count, 2);
    assert.equal(reads, 2);
  });

  test(
    "Git denial receipt requires the adjacent endpoint-not-admitted warning",
    { timeout: 5000 },
    async () => {
      // A complete first batch must not hide a later evaluator-error batch from
      // the same command. The scoped DNS marker closes the observation window.
      const late = fixture([line(1)]);
      const lateBefore = await late.observer.snapshot();
      let lateReads = 0;
      late.afterRead(() => {
        lateReads += 1;
        late.set(
          lateReads === 1
            ? [line(1), warning, denial]
            : [
                line(1),
                warning,
                denial,
                {
                  ...warning,
                  fields: { ...warning.fields, reason: "policy evaluation failed: runtime error" },
                },
                denial,
                marker,
              ],
        );
      });
      await assert.rejects(
        late.observer.expectAfter(lateBefore, interval),
        refusalAt("policy-pair", /competing or unpaired/),
      );
      // Two concurrent denials must not lend each other their warning reason.
      const interleaved = fixture([line(1)]);
      const interleavedBefore = await interleaved.observer.snapshot();
      interleaved.set([
        line(1),
        {
          ...warning,
          fields: { ...warning.fields, reason: "policy evaluation failed: runtime error" },
        },
        warning,
        denial,
        { ...denial, message: denial.message.replace(executable, "/usr/bin/curl") },
      ]);
      await assert.rejects(
        interleaved.observer.expectAfter(interleavedBefore, interval),
        /competing or unpaired/,
      );
      const alteredWarnings = [
        { source: "gateway" },
        { level: "INFO" },
        { target: "other" },
        { message: "different warning" },
        { fields: { ...warning.fields, reason: "policy evaluation failed: runtime error" } },
        { fields: { ...warning.fields, destination: "198.18.0.1:80" } },
        { fields: { ...warning.fields, destination: "github.com:443" } },
        { fields: { ...warning.fields, destination: "999.18.0.1:443" } },
        { fields: { ...warning.fields, destination: "[invalid]:443" } },
        { fields: { ...warning.fields, destination: 443 } },
        { time: "2026-11-05T11:59:59.999999999Z" },
        { time: "2026-11-05T12:00:00.003000000Z" },
      ];
      const sequences = [
        [denial],
        [denial, warning],
        [warning, line("intervening"), denial],
        ...alteredWarnings.map((change) => [{ ...warning, ...change }, denial]),
        // Within one millisecond bucket, the OCSF record still cannot precede WARN.
        [
          { ...warning, time: "2026-11-05T12:00:00.002999999Z" },
          { ...denial, time: "2026-11-05T12:00:00.002000000Z" },
        ],
      ];
      for (const sequence of sequences) {
        const f = fixture([line(1)]);
        const before = await f.observer.snapshot();
        f.set([line(1), ...sequence]);
        await assert.rejects(f.observer.expectAfter(before, interval), /competing or unpaired/);
      }
      // A fresh OCSF line cannot borrow its warning from the pre-attempt baseline.
      const f = fixture([line(1), warning]);
      const before = await f.observer.snapshot();
      f.set([line(1), warning, denial]);
      await assert.rejects(f.observer.expectAfter(before, interval), /competing or unpaired/);
    },
  );

  test(
    "Git denial receipt refuses stale and differently attributed log records",
    { timeout: 5000 },
    async () => {
      const mismatches = [
        { source: "gateway" },
        { level: "INFO" },
        { target: "other" },
        { message: denial.message.replace(executable, "/usr/bin/curl") },
        { message: denial.message.replace("github.com", "other.invalid") },
        { message: denial.message.replace("policy_denied", "identity_unavailable") },
        { message: denial.message.replace("(0)", "(123)") },
        { time: "2026-11-05T11:59:59.999999999Z" },
        { time: "2026-11-05T12:00:00.003000000Z" },
      ];
      for (const mismatch of mismatches) {
        const baseline = [warning, denial, line(1)];
        const f = fixture(baseline);
        const before = await f.observer.snapshot();
        f.set([...baseline, warning, { ...denial, ...mismatch }]);
        await assert.rejects(f.observer.expectAfter(before, interval), /competing or unpaired/);
      }
      const stale = fixture([warning, denial, line(1)], AbortSignal.timeout(100));
      const before = await stale.observer.snapshot();
      await assert.rejects(stale.observer.expectAfter(before, interval), { name: "AbortError" });

      // A missing or different DNS marker cannot close the attempt, even when a
      // complete Git pair has arrived. A baseline marker is not fresh evidence.
      for (const observed of [
        [],
        [{ ...marker, message: marker.message.replace("11111111", "22222222") }],
      ]) {
        const f = fixture([marker, line(1)], AbortSignal.timeout(100));
        const before = await f.observer.snapshot();
        f.set([marker, line(1), warning, denial, ...observed]);
        await assert.rejects(f.observer.expectAfter(before, interval), { name: "AbortError" });
      }
      for (const change of [
        { source: "gateway" },
        { level: "INFO" },
        { target: "other" },
        { time: "2026-11-05T12:00:00.001000000Z" },
        { time: "2026-11-05T12:00:00.005000000Z" },
        // The millisecond is eligible, but nanosecond order precedes Git's event.
        { time: "2026-11-05T12:00:00.002000000Z" },
      ]) {
        const f = fixture([line(1)]);
        const before = await f.observer.snapshot();
        f.set([line(1), warning, denial, { ...marker, ...change }]);
        await assert.rejects(
          f.observer.expectAfter(before, interval),
          refusalAt("dns-marker", /DNS marker/),
        );
      }
      for (const sequence of [
        [marker, warning, denial],
        [warning, denial, marker, warning, denial],
        [warning, denial, marker, marker],
      ]) {
        const f = fixture([line(1)]);
        const before = await f.observer.snapshot();
        f.set([line(1), ...sequence]);
        await assert.rejects(
          f.observer.expectAfter(before, interval),
          refusalAt("dns-marker", /DNS marker/),
        );
      }
    },
  );
}
