import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { Check } from "typebox/value";

import {
  AgentRuntimeLogsResponse,
  type AgentRuntimeLogChunk,
} from "../../packages/contracts/src/index.ts";
import { RUNTIME_LOG_CURSOR_TTL_MS } from "../../packages/occ/src/runtime-logs/cursor.ts";
import type { RuntimeLogPage } from "../../packages/occ/src/runtime-logs/read.ts";
import {
  assertTailMasked,
  cursorPayload,
  gatewayJson,
  logsRoute,
  messages,
  pemBegin,
  pemEnd,
  pollReader,
  syntheticPemTail,
} from "../helpers/runtime-logs-content.ts";
import {
  registerRuntimeLogCursorCodecCases,
  signRuntimeLogCursorPayload,
} from "./runtime-logs-cursor-codec-cases.ts";

type LogLines = AgentRuntimeLogChunk["lines"];
type PollOptions = NonNullable<Parameters<ReturnType<typeof pollReader>["poll"]>[1]>;
type RoutePollOptions = {
  tailLines?: string | number | undefined;
  truncated?: boolean | undefined;
};

// A view that has delivered a PEM BEGIN line at second 0.
async function pemOpenReader(options?: Parameters<typeof pollReader>[0]) {
  const reader = pollReader(options);
  await reader.poll([timedLog(pemBegin, 0)]);
  return reader;
}
function timedLog(raw: string, second: number | null) {
  return {
    raw,
    time:
      second === null
        ? null
        : new Date(Date.parse("2026-09-30T12:00:00Z") + second * 1000).toISOString(),
  };
}
// Gap reasons and line messages, in page order.
function summary(page: RuntimeLogPage) {
  return page.records.map((record) => (record.type === "line" ? record.message : record.reason));
}
function assertTailShown(page: RuntimeLogPage) {
  assert.ok(messages(page).includes(syntheticPemTail));
}
// Lines larger than the page budget leaves for them: 70 of these cut a page.
function largeDiagnostics(count: number, firstSecond: number) {
  return Array.from({ length: count }, (_, i) =>
    timedLog(gatewayJson("ordinary diagnostic ".repeat(500)), firstSecond + i),
  );
}
function workers(count: number, second = 0) {
  return Array.from({ length: count }, (_, index) => timedLog(`worker ${index} ready`, second));
}
const retrying = (second: number) => timedLog("retrying in 5s", second);

// The same polls through the controller's logs route: the cursor is serialized and
// parsed again on every request.
async function runtimeLogRoutePoller() {
  const route = await logsRoute();
  // Keep the supplied array in fixture state until the Driver reads it.
  const state: { lines: LogLines; truncated: boolean } = route.state;
  let cursor: string | undefined;
  let response: Awaited<ReturnType<typeof route.read>> | undefined;
  return {
    startView() {
      cursor = undefined;
    },
    // The last response, with its headers and serialized text.
    get response() {
      return response;
    },
    async poll(lines: LogLines, { tailLines = "1000", truncated = false }: RoutePollOptions = {}) {
      state.lines = lines;
      state.truncated = truncated;
      response = await route.read({ tailLines, cursor });
      assert.equal(response.status, 200, response.text);
      const { body } = response;
      assert.ok(Check(AgentRuntimeLogsResponse, body), "expected a runtime log response");
      assert.ok(typeof body.data.cursor === "string");
      cursor = body.data.cursor;
      return body.data;
    },
    async shown(lines: LogLines, options?: RoutePollOptions) {
      return messages(await this.poll(lines, options));
    },
  };
}

// About 8 KiB per line: some tens of these fill a 512 KiB page.
function bigLine(text: string, second: number) {
  return timedLog(gatewayJson(`${text} ${"x ".repeat(4096)}`), second);
}

export function registerRuntimeLogCursorCases() {
  test("runtime log cursor carries PEM context over three polls and empty polls", async () => {
    const reader = pollReader();
    await reader.poll([timedLog(pemBegin, 0), timedLog(randomBytes(48).toString("base64"), 1)]);
    const beforeEmpty = reader.position;
    await reader.poll([]);
    const afterEmpty = reader.position;
    assert.equal(afterEmpty.pemOpen, beforeEmpty.pemOpen);
    assert.equal(afterEmpty.pemAfterTime, beforeEmpty.pemAfterTime);
    assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 2)]));
    const final = await reader.poll([timedLog(pemEnd, 3), retrying(4)]);
    assert.ok(messages(final).includes("retrying in 5s"));
    assertTailShown(await reader.poll([timedLog(syntheticPemTail, 5)]));
    assert.equal(reader.admissions, 1);
  });

  test("a cursor from a page with no lines reads only output newer than that page", async () => {
    const reader = pollReader();
    // `occ agent logs --since 1m --follow` on a quiet container: the first page is empty.
    await reader.poll([], { query: { sinceSeconds: 60 } });
    // Follow polls send only the cursor; the read must not fall back to the whole tail.
    await reader.poll([], { elapsed: 4_000 });
    await reader.poll([], { elapsed: 9_000 });
    assert.deepEqual(
      reader.requests.map(({ sinceSeconds }) => sinceSeconds),
      [60, 6, 7],
    );
    // The first line the view sees is delivered once, and a full tail is labelled.
    const burst = Array.from({ length: 3 }, (_, i) => timedLog(`retrying in ${i}s`, 600 + i));
    const full = await reader.poll(burst, { elapsed: 10_000, query: { tailLines: 3 } });
    assert.deepEqual(summary(full), [
      "window_exceeded",
      "retrying in 0s",
      "retrying in 1s",
      "retrying in 2s",
    ]);
    const again = await reader.poll(burst, { elapsed: 11_000 });
    assert.deepEqual(messages(again), []);
    assert.equal(reader.admissions, 1);

    // A burst of long lines on another quiet view: the Driver applies the tail before
    // its byte cut, so a cut page holds fewer than `tailLines` lines but may still
    // have lost the oldest lines of the burst.
    const cutReader = pollReader();
    await cutReader.poll([], { query: { sinceSeconds: 60 } });
    const cut = await cutReader.poll(
      [timedLog("retrying in 600s", 600), timedLog("retrying in 601s", 601), timedLog("retr", 602)],
      { elapsed: 10_000, truncated: true, query: { tailLines: 5 } },
    );
    assert.deepEqual(summary(cut), [
      "window_exceeded",
      "retrying in 600s",
      "retrying in 601s",
      "truncated",
    ]);
  });

  test("a resumed page cut by the byte limit still reports lines lost before it", async () => {
    const reader = pollReader();
    await reader.poll([timedLog("retrying in 0s", 0), timedLog("retrying in 1s", 1)]);
    // A burst of long lines: the tail dropped second 1, then the byte limit cut the page
    // to fewer than `tailLines` lines, ending in a partial line.
    const cut = await reader.poll(
      [timedLog("retrying in 600s", 600), timedLog("retrying in 601s", 601), timedLog("retr", 602)],
      { elapsed: 600_000, truncated: true },
    );
    assert.deepEqual(summary(cut), [
      "window_exceeded",
      "retrying in 600s",
      "retrying in 601s",
      "truncated",
    ]);
    // A cut page that still re-reads the last delivered line lost nothing before it.
    const overlap = await reader.poll(
      [timedLog("retrying in 601s", 601), timedLog("retrying in 700s", 700), timedLog("retr", 701)],
      { elapsed: 700_000, truncated: true },
    );
    assert.deepEqual(summary(overlap), ["retrying in 700s", "truncated"]);
    // One line longer than the byte limit fills the page; its leading time still dates the
    // loss, and the view skips past it (one gap, not a "request fewer lines" truncation).
    const single = await reader.poll([timedLog("retr", 900)], {
      elapsed: 900_000,
      truncated: true,
    });
    assert.deepEqual(
      single.records.map((record) => [
        record.type === "line" ? record.message : record.reason,
        record.time,
      ]),
      [["window_exceeded", timedLog("", 900).time]],
    );
  });

  test("a resumed view moves past a line longer than the read limit", async () => {
    const reader = pollReader();
    const gaps = (page: RuntimeLogPage) =>
      page.records
        .filter((record) => record.type === "gap")
        .map(({ reason, time, remedy }) => ({ reason, time, remedy }));
    // The view delivers second 0 with a PEM block open; `now` is second 600.
    await reader.poll([timedLog(pemBegin, 0)]);
    // Every resumed read starts before the cursor time, so it re-reads the overlap line and
    // then a line over 1 MiB fills the byte limit: nothing new is delivered.
    const stuck = [timedLog(pemBegin, 0), timedLog("retr", 599)];
    // Within about 3 s of the read the view stays put; the gap does not ask for fewer lines.
    const recent = await reader.poll(stuck, { elapsed: 1_000, truncated: true });
    assert.deepEqual(
      gaps(recent).map(({ reason }) => reason),
      ["truncated"],
    );
    const [recentGap] = gaps(recent);
    assert.ok(recentGap);
    assert.match(recentGap.remedy, /longer than the rest of the 1 MiB read limit/);
    assert.equal(reader.position.lastTime, timedLog("", 0).time);
    // Once the line is older than where the next read starts, the view skips past it and
    // says that lines were lost behind it.
    const skipped = await reader.poll(stuck, { elapsed: 3_000, truncated: true });
    assert.deepEqual(
      gaps(skipped).map(({ reason, time }) => [reason, time]),
      [["window_exceeded", timedLog("", 599).time]],
    );
    const [skippedGap] = gaps(skipped);
    assert.ok(skippedGap);
    assert.match(skippedGap.remedy, /longer than the rest of the 1 MiB read limit/);
    assert.doesNotMatch(JSON.stringify(skipped.records), /fewer lines/);
    const position = reader.position;
    assert.equal(position.lastTime, null);
    // The cursor cannot keep a delivered PEM frontier, so the open block stays masked.
    assert.equal(position.pemOpen, true);
    assert.equal(position.pemAfterTime, null);
    // The next read starts from the previous read, past the oversized line, not from second 0.
    const next = await reader.poll(
      [timedLog(syntheticPemTail, 604), timedLog("retrying in 604s", 604)],
      { elapsed: 5_000 },
    );
    const nextRequest = reader.requests.at(-1);
    assert.ok(nextRequest);
    assert.equal(nextRequest.sinceSeconds, 4);
    assertTailMasked(next);
    assert.ok(messages(next).includes("retrying in 604s"));
    assert.deepEqual(gaps(next), []);
    // Resume after small lines is unchanged: overlap de-duplication, and a byte cut after a
    // new line keeps the cursor on that line with the usual remedy.
    const resumed = await reader.poll(
      [timedLog("retrying in 604s", 604), timedLog("retrying in 606s", 606), timedLog("retr", 607)],
      { elapsed: 7_000, truncated: true },
    );
    const resumedRequest = reader.requests.at(-1);
    assert.ok(resumedRequest);
    assert.equal(resumedRequest.sinceSeconds, 5);
    assert.deepEqual(summary(resumed), ["retrying in 606s", "truncated"]);
    const [resumedGap] = gaps(resumed);
    assert.ok(resumedGap);
    assert.match(resumedGap.remedy, /Request fewer lines/);
    assert.equal(reader.position.lastTime, timedLog("", 606).time);
    assert.equal(reader.admissions, 1);
  });

  test("a resumed view skips a stalled read only when every poll would stall", async () => {
    const reader = pollReader();
    const stalls = (page: RuntimeLogPage) =>
      page.records.map((record) => [
        record.type === "line" ? record.message : record.reason,
        ...(record.type === "gap" ? [/fewer lines/.test(record.remedy)] : []),
      ]);
    // `now` is second 600; the view has delivered second 596.
    await reader.poll([timedLog("retrying in 590s", 590), timedLog("retrying in 596s", 596)]);
    // A line older than the overlap every read covers is re-read only on some polls, so a
    // later poll may get past the cut: keep the frontier and the usual remedy.
    const partial = await reader.poll(
      [timedLog("retrying in 593s", 593), timedLog("retrying in 596s", 596), timedLog("retr", 606)],
      { elapsed: 8_000, truncated: true },
    );
    assert.deepEqual(stalls(partial), [["truncated", true]]);
    assert.equal(reader.position.lastTime, timedLog("", 596).time);
    // Exactly at the guard the view stays put.
    const atGuard = await reader.poll([timedLog("retrying in 596s", 596), timedLog("retr", 605)], {
      elapsed: 8_000,
      truncated: true,
    });
    assert.deepEqual(stalls(atGuard), [["truncated", false]]);
    assert.equal(reader.position.lastTime, timedLog("", 596).time);
    // A cut line at the cursor time also stalls every poll; untimed lines are not progress.
    const sameTime = await reader.poll(
      [timedLog("retrying in 596s", 596), timedLog("untimed", null), timedLog("retr", 596)],
      { elapsed: 8_001, truncated: true },
    );
    assert.deepEqual(stalls(sameTime), [["untimed"], ["window_exceeded", false]]);
    const lastRecord = sameTime.records.at(-1);
    assert.ok(lastRecord);
    assert.equal(lastRecord.time, timedLog("", 596).time);
    assert.equal(reader.position.lastTime, null);

    // A stream replaced during the read is not a stalled read.
    const replaced = pollReader();
    await replaced.poll([timedLog("retrying in 0s", 0)]);
    const page = await replaced.poll([timedLog("retr", 500)], {
      elapsed: 2_000,
      truncated: true,
      stream: { restartCount: 1 },
    });
    assert.deepEqual(stalls(page), [
      ["stream_replaced", false],
      ["truncated", true],
    ]);
  });

  test("runtime log cursor does not let an evicted same-time old END erase a later BEGIN", async () => {
    const reader = pollReader();
    const overlap = [
      pemEnd,
      ...Array.from({ length: 20 }, (_, i) => `retrying worker ${i}`),
      pemBegin,
    ].map((raw) => timedLog(raw, 0));
    await reader.poll(overlap);
    // END was evicted from the 16 retained hashes; BEGIN is deduplicated. Neither
    // replayed END nor another unseen same-time line proves forward progress.
    assertTailMasked(await reader.poll([...overlap, timedLog(syntheticPemTail, 0)]));
    assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 1)]));
    await reader.poll([timedLog(pemEnd, 2)]);
    assertTailShown(await reader.poll([timedLog(syntheticPemTail, 3)]));
  });

  test("runtime log cursor retains uncertain context after an untimestamped BEGIN", async () => {
    const reader = pollReader();
    await reader.poll([timedLog("started worker", 0), timedLog(pemBegin, null)]);
    const page = await reader.poll([
      timedLog(pemEnd, 1),
      retrying(2),
      timedLog(syntheticPemTail, null),
    ]);
    assertTailMasked(page);
    assert.ok(messages(page).includes("retrying in 5s"));
  });

  test("runtime log cursor ignores an undelivered byte-cut END", async () => {
    const reader = await pemOpenReader();
    assertTailMasked(
      await reader.poll([timedLog(syntheticPemTail, 1), timedLog(pemEnd, 2)], { truncated: true }),
    );
    assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 3)]));
  });

  test("runtime log cursor context stops at the page byte bound before a future END", async () => {
    const reader = pollReader();
    const page = await reader.poll([
      timedLog(pemBegin, 0),
      ...largeDiagnostics(70, 1),
      timedLog(pemEnd, 72),
    ]);
    assert.equal(page.truncated, true);
    assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 100)]));
  });

  test("runtime log cursor verifies context authentication before any Driver read", async () => {
    const reader = await pemOpenReader();
    const cursor = reader.cursor;
    assert.ok(cursor);
    const [version, , mac] = cursor.split(".");
    const payload = cursorPayload(cursor);
    assert.ok(typeof payload === "object" && payload !== null);
    const tampered = Buffer.from(JSON.stringify({ ...payload, po: false })).toString("base64url");
    const before = reader.reads;
    for (const options of [
      { query: { cursor: `${version}.${tampered}.${mac}` } },
      { binding: { ...reader.binding, principalId: "other-person" } },
    ]) {
      await assert.rejects(reader.poll([], options), { reason: "cursor_invalid" });
      assert.equal(reader.reads, before);
    }
  });

  test("runtime log cursor context resets for changed stream, view, expiry and mid-read replacement", async (t) => {
    for (const [name, options] of [
      ["pod UID", { pod: { uid: "new-pod" } }],
      ["restart", { pod: { restartCount: 1 } }],
      ["pod choice", { pod: { name: "gateway-test-1" }, query: { pod: "gateway-test-1" } }],
      ["previous instance", { query: { previous: true } }],
      ["new view", { query: { cursor: undefined } }],
      ["expired", { elapsed: RUNTIME_LOG_CURSOR_TTL_MS + 1 }],
      ["mid-read UID", { stream: { podUid: "new-pod" } }],
      ["mid-read restart", { stream: { restartCount: 1 } }],
    ] satisfies [string, PollOptions][]) {
      await t.test(name, async () => {
        const reader = await pemOpenReader();
        // A new/unknown tail cannot infer a BEGIN from the old stream/view.
        assertTailShown(await reader.poll([timedLog(syntheticPemTail, 1)], options));
      });
    }
  });

  test("runtime log route polling preserves identical same-time line occurrences", async () => {
    const reader = await runtimeLogRoutePoller();
    const repeated = retrying(0);
    // The Driver contract supplies raw lines without requiring unique timestamps.
    // A later poll must subtract the two delivered occurrences, not all equal text.
    assert.deepEqual(await reader.shown([repeated, repeated]), [
      "retrying in 5s",
      "retrying in 5s",
    ]);
    const burst = [repeated, repeated, repeated, timedLog("worker connected", 0)];
    assert.deepEqual(await reader.shown(burst), ["retrying in 5s", "worker connected"]);
    assert.deepEqual(
      await reader.shown(burst),
      [],
      "replaying the whole overlap must show no duplicate",
    );
    assert.deepEqual(await reader.shown([...burst, retrying(1)]), ["retrying in 5s"]);

    // A new view can deliver more occurrences than its bounded cursor remembers.
    // An incomplete count cannot establish a new copy on unchanged follow polls.
    reader.startView();
    const saturated = Array.from({ length: 17 }, () => retrying(0));
    assert.equal((await reader.shown(saturated)).length, 17);
    for (const message of [
      "a saturated frontier must not replay old copies",
      "repeated unchanged polls must remain empty",
    ]) {
      assert.deepEqual(await reader.shown(saturated), [], message);
    }
    assert.deepEqual(await reader.shown([...saturated, timedLog("worker connected", 1)]), [
      "worker connected",
    ]);
  });

  test("runtime log route polling keeps a cut timestamp group conservative when the tail expands", async () => {
    const reader = await runtimeLogRoutePoller();
    const old = Array.from({ length: 3 }, () => retrying(0));
    const connected = timedLog("worker connected", 1);
    assert.equal((await reader.shown(old, { tailLines: "2" })).length, 2);
    assert.deepEqual(
      await reader.shown(old),
      [],
      "expanding the tail does not make an old copy new",
    );
    assert.deepEqual(
      await reader.shown([...old, retrying(0)]),
      [],
      "an incomplete frontier cannot distinguish another identical copy",
    );
    assert.deepEqual(await reader.shown([...old, connected]), ["worker connected"]);
    assert.deepEqual(await reader.shown([...old, connected, connected]), ["worker connected"]);

    reader.startView();
    assert.equal((await reader.shown(old, { truncated: true })).length, 2);
    assert.deepEqual(
      await reader.shown(old),
      [],
      "a Driver byte cut cannot establish a complete first timestamp group",
    );
  });

  test("runtime log route polling counts undelivered copies after its page byte cut", async () => {
    const reader = await runtimeLogRoutePoller();
    const padding = Array.from({ length: 20 }, (_, index) => bigLine(`line ${index}`, 0));
    const repeated = bigLine("retrying", 1);
    const lines = [...padding, ...Array.from({ length: 80 }, () => repeated)];
    const first = await reader.poll(lines);
    assert.equal(first.truncated, true);
    const delivered = messages(first).length;
    assert.ok(delivered > padding.length && delivered < lines.length);
    assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= 512 * 1024);
    const next = await reader.poll(lines);
    assert.equal(
      messages(next).length,
      lines.length - delivered,
      "a page cut leaves the remaining copies to deliver at the complete frontier",
    );
    assert.deepEqual(await reader.shown(lines), []);
  });

  test("runtime log cursor keeps legacy frontier counts conservative", async () => {
    const reader = pollReader();
    const repeated = retrying(0);
    await reader.poll([repeated, repeated]);
    // @ts-expect-error Exercise explicit undefined at the legacy JavaScript encoder boundary.
    const cursor = reader.codec.encode(reader.binding, {
      ...reader.position,
      frontierComplete: undefined,
    });
    assert.deepEqual(await reader.shown([repeated, repeated, repeated], { query: { cursor } }), []);
    assert.deepEqual(await reader.shown([repeated, repeated, retrying(1)]), ["retrying in 5s"]);
  });

  test("runtime log polling delivers a timestamp group larger than the hash history once", async () => {
    for (const size of [16, 17, 20]) {
      for (const lead of [[timedLog("boot", -1)], []]) {
        const reader = pollReader();
        const label = `${size} distinct lines${lead.length === 0 ? " without an earlier line" : ""}`;
        const lines = [...lead, ...workers(size)];
        assert.equal((await reader.shown(lines)).length, lines.length, label);
        for (let poll = 0; poll < 3; poll += 1) {
          assert.deepEqual(await reader.shown(lines), [], `${label}: poll ${poll} replays`);
        }
        lines.push(timedLog("worker late ready", 0), timedLog("worker 0 ready", 0));
        assert.deepEqual(
          await reader.shown(lines),
          ["worker late ready", "worker 0 ready"],
          `${label}: later lines at the same time`,
        );
        assert.deepEqual(await reader.shown(lines), [], `${label}: after later lines`);
        lines.push(timedLog("worker connected", 1));
        assert.deepEqual(await reader.shown(lines), ["worker connected"], label);
      }
    }
  });

  test("runtime log polling counts mixed identical and distinct lines at one timestamp", async () => {
    const reader = pollReader();
    const lines = [timedLog("boot", -1)];
    for (let index = 0; index < 12; index += 1) {
      lines.push(retrying(0), timedLog(`attempt ${index}`, 0));
    }
    assert.equal((await reader.shown(lines)).length, 25);
    assert.deepEqual(await reader.shown(lines), []);
    lines.push(retrying(0), timedLog("attempt 0", 0), retrying(0));
    assert.deepEqual(await reader.shown(lines), ["retrying in 5s", "attempt 0", "retrying in 5s"]);
    assert.deepEqual(await reader.shown(lines), []);
  });

  test("runtime log polling pages through a large timestamp group and ends", async () => {
    const reader = pollReader();
    const lines = [
      timedLog("boot", -1),
      ...Array.from({ length: 200 }, (_, index) => bigLine(`line ${index}`, 0)),
    ];
    const seen: string[] = [];
    let polls = 0;
    for (; polls < 20; polls += 1) {
      const page = await reader.shown(lines);
      if (page.length === 0) {
        break;
      }
      seen.push(...page);
    }
    assert.ok(polls < 20, "pagination must end");
    assert.equal(seen.length, 201);
    assert.equal(new Set(seen).size, 201, "no line is delivered twice");
    assert.deepEqual(await reader.shown(lines), []);
  });

  test("runtime log polling suppresses a forgotten timestamp group when completeness is unknown", async () => {
    const reader = pollReader();
    const all = workers(30);
    // The requested tail clips the group, so the cursor cannot count it from its start.
    const tail = all.slice(-20);
    const query = { tailLines: 20 };
    assert.equal((await reader.shown(tail, { query })).length, 20);
    assert.deepEqual(await reader.shown(tail, { query }), []);
    assert.deepEqual(await reader.shown(all), [], "an expanded tail adds no old line");
    assert.deepEqual(await reader.shown([...all, timedLog("worker connected", 1)]), [
      "worker connected",
    ]);
  });

  // A frontier line that de-duplication cannot prove delivered is withheld until time
  // advances, and is unreadable after that. The page that moves the frontier must say
  // so with a gap dated at the old frontier, once.
  test("runtime log polling reports withheld frontier lines once the frontier moves past them", async () => {
    const frontierGap = ["window_exceeded", retrying(0).time];
    const gaps = (page: RuntimeLogPage) =>
      page.records
        .filter((record) => record.type === "gap")
        .map(({ reason, time }) => [reason, time]);

    // Identical text: the first poll's tail clipped the group, so copies past the two it
    // delivered may be old or new. Later reads start a second earlier; the gap is dated
    // at the frontier, not at the read's start.
    const repeats = pollReader();
    const old = Array.from({ length: 3 }, () => retrying(0));
    await repeats.poll(old.slice(-2), { query: { tailLines: 2 } });
    const boot = timedLog("boot", -1);
    const joined = timedLog("worker joined", 0);
    // New text at the frontier time is shown; the extra identical copies are not.
    const withheld = await repeats.poll([boot, ...old, retrying(0), joined]);
    assert.deepEqual(summary(withheld), ["worker joined"], "no gap while time is unchanged");
    const connected = timedLog("worker connected", 1);
    const moved = await repeats.poll([boot, ...old, retrying(0), joined, connected]);
    assert.deepEqual(summary(moved), ["window_exceeded", "worker connected"]);
    assert.deepEqual(gaps(moved), [frontierGap]);
    const later = [boot, ...old, retrying(0), joined, connected, timedLog("worker idle", 2)];
    assert.deepEqual(summary(await repeats.poll(later)), ["worker idle"], "no gap without one");

    // More than 16 lines at one time: the cursor's hashes forgot the group's start, and
    // rotation removed it from the read, so new text at that time cannot be told apart.
    const group = pollReader();
    const workersAtZero = workers(20);
    assert.equal((await group.shown([timedLog("boot", -1), ...workersAtZero])).length, 21);
    const rejoined = Array.from({ length: 5 }, (_, index) =>
      timedLog(`worker ${index} rejoined`, 0),
    );
    const rotated = [...workersAtZero.slice(5), ...rejoined];
    assert.deepEqual(summary(await group.poll(rotated)), []);
    const advanced = await group.poll([...rotated, connected]);
    assert.deepEqual(summary(advanced), ["window_exceeded", "worker connected"]);
    assert.deepEqual(gaps(advanced), [frontierGap]);

    // The page that moves the frontier is cut by the page budget: its continuation page
    // does not repeat the gap.
    const paged = pollReader();
    await paged.poll(old.slice(-2), { query: { tailLines: 2 } });
    const big = Array.from({ length: 100 }, (_, index) => bigLine(`line ${index}`, index + 1));
    const first = await paged.poll([...old, retrying(0), ...big]);
    assert.equal(first.truncated, true);
    assert.deepEqual(
      gaps(first).filter(([reason]) => reason === "window_exceeded"),
      [frontierGap],
    );
    const rest = await paged.poll([...old, retrying(0), ...big]);
    assert.deepEqual(
      gaps(rest).filter(([reason]) => reason === "window_exceeded"),
      [],
      "the continuation page already moved past the frontier",
    );
    assert.equal(messages(first).length + messages(rest).length, big.length);
  });

  test("runtime log polling checks a counted timestamp group against its hashes", async () => {
    const reader = pollReader();
    const group = workers(10);
    assert.equal((await reader.shown([timedLog("boot", -1), ...group])).length, 11);
    // Rotation removed the start of the group; a short page no longer begins with it.
    const fresh = Array.from({ length: 5 }, (_, index) => timedLog(`worker ${index} joined`, 0));
    assert.deepEqual(
      await reader.shown([...group.slice(5), ...fresh]),
      fresh.map(({ raw }) => raw),
    );
    assert.deepEqual(await reader.shown([...group.slice(5), ...fresh]), []);
  });

  test("runtime log polling counts a timestamp group past an untimed line", async () => {
    const reader = pollReader();
    const lines = [timedLog("boot", -1), ...workers(20)];
    assert.equal((await reader.shown(lines)).length, 21);
    lines.push(timedLog("untimed", null), timedLog("worker late ready", 0));
    assert.deepEqual(await reader.shown(lines), ["untimed", "worker late ready"]);
    assert.deepEqual(await reader.shown(lines), ["untimed"]);
  });

  test("runtime log polling stops counting by position after tail-clipped polls", async () => {
    const reader = pollReader();
    const group = workers(25);
    const [first] = group;
    assert.ok(first);
    const seen = await reader.shown([timedLog("boot", -1), first]);
    assert.equal(seen.length, 2);
    // The view's tail changes between polls, so some polls cannot see the group start.
    for (const tailLines of [4, 20, 1000]) {
      const lines = [timedLog("boot", -1), ...group].slice(-tailLines);
      seen.push(...(await reader.shown(lines, { query: { tailLines } })));
    }
    assert.equal(new Set(seen).size, seen.length, "no line is delivered twice");
    assert.deepEqual(await reader.shown([timedLog("boot", -1), ...group]), []);
  });

  test("runtime log cursor without a frontier count keeps legacy cursors usable", async () => {
    const strip = (reader: ReturnType<typeof pollReader>) => {
      const { frontierCount: _count, ...position } = reader.position;
      return reader.codec.encode(reader.binding, position);
    };
    const full = pollReader();
    const lines = [timedLog("boot", -1), ...workers(20)];
    await full.poll(lines);
    assert.equal(full.position.frontierCount, 20);
    assert.deepEqual(await full.shown(lines, { query: { cursor: strip(full) } }), []);
    assert.deepEqual(await full.shown([...lines, timedLog("worker connected", 1)]), [
      "worker connected",
    ]);

    const short = pollReader();
    const few = [timedLog("boot", -1), retrying(0), retrying(0)];
    await short.poll(few);
    assert.deepEqual(
      await short.shown([...few, retrying(0)], { query: { cursor: strip(short) } }),
      ["retrying in 5s"],
    );

    const position = full.position;
    for (const change of [
      { lastHashes: ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"], frontierCount: 1 },
      { lastTime: null, lastHashes: [], frontierCount: 1 },
    ]) {
      const inconsistent = full.codec.encode(full.binding, { ...position, ...change });
      assert.equal(full.codec.decode(inconsistent, full.binding).status, "invalid");
    }
  });

  registerRuntimeLogCursorCodecCases(timedLog);

  test("runtime log route polling carries PEM masking through the serialized cursor", async () => {
    const reader = await runtimeLogRoutePoller();
    const lines = [
      timedLog(pemBegin, 0),
      timedLog(randomBytes(48).toString("base64"), 1),
      timedLog(syntheticPemTail, 2),
      timedLog(pemEnd, 3),
      retrying(4),
    ];
    for (const count of [2, 3, 5]) {
      const page = await reader.poll(lines.slice(0, count));
      const response = reader.response;
      assert.ok(response);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(
        response.text.includes(syntheticPemTail),
        false,
        "the actual handler must not serialize the middle-poll fragment",
      );
      if (count === 5) {
        assert.ok(
          page.records.some(
            (record) => record.type === "line" && record.message === "retrying in 5s",
          ),
        );
      }
    }
  });

  test("runtime log cursor keeps an ambiguous same-time close conservative", async () => {
    const reader = await pemOpenReader();
    await reader.poll([timedLog(pemEnd, 0), retrying(0)]);
    assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 1)]));
    await reader.poll([retrying(2)]);
    assertTailShown(await reader.poll([timedLog(syntheticPemTail, 3)]));
  });

  test("runtime log cursor retains uncertainty for missing, malformed and reordered times", async (t) => {
    for (const [name, lines] of [
      ["missing", [timedLog(pemEnd, null), timedLog(syntheticPemTail, 1)]],
      ["malformed", [{ raw: pemEnd, time: "not-a-time" }, timedLog(syntheticPemTail, 1)]],
      ["reordered", [timedLog(pemEnd, 3), timedLog(syntheticPemTail, 2)]],
    ] satisfies [string, LogLines][]) {
      await t.test(name, async () => {
        const reader = await pemOpenReader();
        assertTailMasked(await reader.poll(lines));
        // Later timestamps cannot reconstruct the missing chronology of this view.
        await reader.poll([timedLog(pemEnd, 4)]);
        assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 5)]));
      });
    }
  });

  test("runtime log cursor keeps a later BEGIN on the same line as END", async () => {
    const reader = await pemOpenReader();
    await reader.poll([timedLog(`${pemEnd} ${pemBegin}`, 1)]);
    assertTailMasked(await reader.poll([timedLog(syntheticPemTail, 2)]));
  });

  test("runtime log cursor rejects malformed or inconsistent signed PEM field pairs before reading", async () => {
    const secret = randomBytes(32).toString("hex");
    const reader = await pemOpenReader({ secret });
    const original = reader.cursor;
    assert.ok(original);
    const payload = cursorPayload(original);
    assert.ok(typeof payload === "object" && payload !== null);
    assert.equal(signRuntimeLogCursorPayload(secret, payload), original);
    for (const change of [
      { po: undefined },
      { pt: undefined },
      { po: "true" },
      { po: null },
      { pt: 123 },
      { pt: "invalid" },
      { pt: "2026-02-31T12:00:00Z" },
      { pt: timedLog("", 1).time },
      { t: null },
    ]) {
      // Exercise authenticated schema validation, separately from MAC tampering.
      const cursor = signRuntimeLogCursorPayload(secret, { ...payload, ...change });
      const before = reader.reads;
      await assert.rejects(reader.poll([], { query: { cursor } }), { reason: "cursor_invalid" });
      assert.equal(reader.reads, before);
    }
  });

  test("runtime log cursor preserves legacy absent context as unknown", async () => {
    const reader = pollReader();
    await reader.poll([retrying(0)]);
    // @ts-expect-error Exercise explicit undefined at the legacy JavaScript encoder boundary.
    const legacy = reader.codec.encode(reader.binding, {
      ...reader.position,
      pemOpen: undefined,
      pemAfterTime: undefined,
    });
    const decoded = reader.codec.decode(legacy, reader.binding);
    assert.ok(decoded.status !== "invalid");
    assert.equal(decoded.position.pemOpen, undefined);
    // No observed BEGIN and no END: short arbitrary text remains best-effort.
    assertTailShown(
      await reader.poll([timedLog(syntheticPemTail, 1)], { query: { cursor: legacy } }),
    );
    assert.equal(reader.position.pemOpen, undefined);
  });

  test("runtime log cursor keeps the frontier stable on replay and does not inspect undelivered lookahead", async () => {
    const reader = pollReader();
    const begin = timedLog(pemBegin, 0);
    await reader.poll([begin]);
    const prior = reader.position;
    await reader.poll([begin]);
    const replay = reader.position;
    assert.equal(replay.pemOpen, true);
    assert.equal(replay.pemAfterTime, prior.pemAfterTime);
    // A malformed future line beyond the response cut is not consumed evidence.
    const page = await reader.poll([...largeDiagnostics(70, 1), { raw: pemEnd, time: null }]);
    assert.equal(page.truncated, true);
    const frontier = reader.position;
    assert.equal(frontier.pemOpen, true);
    assert.notEqual(frontier.pemAfterTime, null);
    assert.equal(frontier.pemAfterTime, frontier.lastTime);
  });

  test("runtime log cursor detects reordered overlap even when deduplication removes the old frontier line", async () => {
    const reader = pollReader();
    const body = timedLog(randomBytes(48).toString("base64"), 1);
    await reader.poll([timedLog(pemBegin, 0), body]);
    assertTailMasked(await reader.poll([timedLog(pemEnd, 3), body, timedLog(syntheticPemTail, 4)]));
  });

  test("runtime log cursor preserves known-open context across a lost overlap window", async () => {
    const reader = await pemOpenReader();
    const page = await reader.poll([timedLog(syntheticPemTail, 100)], { query: { tailLines: 1 } });
    assert.ok(
      page.records.some((record) => record.type === "gap" && record.reason === "window_exceeded"),
    );
    assertTailMasked(page);
  });

  test("runtime log cursor preserves an observed BEGIN on uncertain initial and legacy pages", async (t) => {
    for (const legacy of [false, true]) {
      for (const beginTime of [3, null]) {
        await t.test(
          `${legacy ? "legacy" : "initial"} ${beginTime === null ? "null" : "reordered"}`,
          async () => {
            const reader = pollReader();
            if (legacy) {
              await reader.poll([retrying(0)]);
              assert.equal(reader.position.pemOpen, undefined);
            }
            // BEGIN is observed in this very page. Missing earlier cursor context does
            // not make this older END valid evidence of a close.
            await reader.poll([timedLog(pemBegin, beginTime), timedLog(pemEnd, 1)]);
            const context = reader.position;
            const next = await reader.poll([timedLog(syntheticPemTail, 4), retrying(5)]);
            assertTailMasked(next);
            assert.ok(messages(next).includes("retrying in 5s"));
            assert.equal(context.pemOpen, true);
            assert.equal(context.pemAfterTime, null);
          },
        );
      }
    }
  });
}
