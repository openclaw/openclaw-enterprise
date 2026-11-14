import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { Check } from "typebox/value";

import {
  AgentRuntimeLogsResponse,
  type AgentRuntimeLogChunk,
  type AgentRuntimeLogPageWire,
  type RuntimeLogStream,
  type RuntimeLogRecord,
} from "../../packages/contracts/src/index.ts";
import type { RuntimeLogPage } from "../../packages/occ/src/runtime-logs/read.ts";
import {
  runtimeLogEvidence,
  sanitizeRuntimeLogChunk,
} from "../../packages/occ/src/runtime-logs/sanitize.ts";
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

type LogRoute = Awaited<ReturnType<typeof logsRoute>>;
type LogQuery = NonNullable<Parameters<LogRoute["read"]>[0]>;
type LogLine = AgentRuntimeLogChunk["lines"][number];
type PageRecords = Pick<RuntimeLogPage | AgentRuntimeLogPageWire, "records">;
type PageRecord = PageRecords["records"][number];

const lineRecords = (page: PageRecords) =>
  page.records.filter((record: PageRecord) => record.type === "line");
type GapReason = Extract<RuntimeLogRecord, { type: "gap" }>["reason"];

const gapCount = (page: PageRecords, reason: GapReason) =>
  page.records.filter((record) => record.type === "gap" && record.reason === reason).length;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);
// The `row=<n>` index of each delivered line, from JSON messages or `[info]` text lines.
const rowIds = (page: PageRecords) =>
  lineRecords(page).map(({ message }) => {
    const match = /^(?:\[info\] )?row=(\d+);/.exec(message);
    assert.ok(match, `not a row line: ${message.slice(0, 80)}`);
    return Number(match[1]);
  });
// Raw bytes plus 32 bytes of timestamp per line: what the kubelet's 1 MiB read covers.
const rawBytes = (lines: readonly LogLine[]) =>
  lines.reduce((bytes, line) => bytes + Buffer.byteLength(line.raw) + 32, 0);
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

async function readPage(route: LogRoute, query: LogQuery, message?: string) {
  const response = await route.read(query);
  assert.equal(response.status, 200, message ?? response.text.slice(0, 200));
  const { body } = response;
  assert.ok(Check(AgentRuntimeLogsResponse, body), "expected a runtime log response");
  return { ...response, body, data: body.data };
}

type WireResponse = Awaited<ReturnType<typeof readPage>>;

// One page of the route's response, within the 512 KiB response bound.
async function boundedPage(route: LogRoute, query: LogQuery, message?: string) {
  const response = await readPage(route, query, message);
  assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
  return response;
}
// A first page that the response bound cut.
async function cutPage(route: LogRoute, query: LogQuery) {
  const response = await boundedPage(route, query);
  assert.equal(response.data.truncated, true);
  return response;
}
// Follows a view until a page is not truncated (at most 10 pages).
async function drain(
  route: LogRoute,
  {
    tailLines,
    cursor,
    message,
    onPage,
  }: {
    tailLines: number;
    cursor?: string | null;
    message?: string;
    onPage?: (response: WireResponse, page: number) => void;
  },
) {
  const lines: ReturnType<typeof lineRecords> = [];
  let pages = 0;
  while (pages < 10) {
    const response = await boundedPage(route, { tailLines, cursor }, message);
    onPage?.(response, pages);
    lines.push(...lineRecords(response.data));
    cursor = response.data.cursor;
    pages += 1;
    if (!response.data.truncated) {
      break;
    }
  }
  return {
    lines,
    cursor,
    pages,
    get rows() {
      return rowIds({ records: lines });
    },
  };
}
// Every truncated page delivers at least one line.
function advances(response: WireResponse) {
  if (response.data.truncated) {
    assert.ok(lineRecords(response.data).length > 0, "a byte-cut page must advance");
  }
}

test("runtime container wire pages include escaped messages, cursor and HTTP metadata in the limit", async () => {
  const route = await logsRoute({ label: "wire-budget" });
  const started = Date.now() - 1000;
  route.state.lines = Array.from({ length: 70 }, (_, index) => ({
    time: iso(started + index),
    raw: gatewayJson(`row=${index}; 网络🙂 process arguments: ${'--option="value" '.repeat(500)}`),
  }));
  const { rows, cursor, pages } = await drain(route, {
    tailLines: 200,
    onPage(response, page) {
      assert.equal(response.body.meta.requestId.length, 40);
      assert.equal(
        Buffer.byteLength(response.text, "utf8"),
        Buffer.byteLength(JSON.stringify(response.body), "utf8"),
        "the actual formatter matches measured JSON, including Unicode",
      );
      if (page === 0) {
        const firstCount = lineRecords(response.data).length;
        assert.ok(firstCount > 0 && firstCount < 70);
        assert.equal(response.data.truncated, true);
      }
      advances(response);
    },
  });
  assert.ok(pages > 0, "expected a first page");
  assert.deepEqual(rows, range(70));
  const replay = await readPage(route, { cursor });
  assert.deepEqual(replay.data.records, []);
  assert.equal(
    route.calls.filter((call) => call.operation === "read").length,
    pages + 1,
    "prefix builds do not read the Driver again",
  );
  assert.equal(
    route.fixture.auditSink.events.filter(
      ({ action }) => action === "openclaw.agents.runtime_logs.view",
    ).length,
    1,
    "prefix builds and continuation do not open extra views",
  );
  const download = await route.read({ download: true });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-type") ?? "", /^text\/plain\b/);
  assert.ok(Buffer.byteLength(download.text, "utf8") <= 512 * 1024);
});

test("runtime container checkpoint suffixes survive append-only growth to a full tail", async () => {
  for (const { tail, identical } of [
    { tail: 100, identical: false },
    { tail: 300, identical: false },
    { tail: 100, identical: true },
  ]) {
    const cursorSecret = randomBytes(32).toString("hex");
    const route = await logsRoute({
      label: "wire-budget-growing-tail",
      agentRuntimeLogs: { enabled: true, cursorSecret },
    });
    const time = iso(Date.now() - 1000);
    const row = (index: number, large = false) => ({
      time,
      raw:
        large && tail === 300
          ? `[info] row=${index}; process arguments: ${'"'.repeat(3000)}`
          : gatewayJson(
              `row=${identical ? 7 : index}; ${large || identical ? '--option="value" '.repeat(500) : "anchor"}`,
            ),
    });
    route.state.lines = Array.from({ length: 20 }, (_, index) => row(index));
    const prime = await readPage(route, { tailLines: tail });
    assert.equal(prime.status, 200);
    const seen = rowIds(prime.data);
    assert.equal(seen.length, 20, "the baseline exceeds the retained frontier hash history");
    route.state.lines.push(
      ...Array.from({ length: tail - 21 }, (_, index) => row(index + 20, true)),
    );
    assert.ok(rawBytes(route.state.lines) < 1024 * 1024);
    let cursor = prime.data.cursor;
    let cuts = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await boundedPage(route, { tailLines: tail, cursor });
      assert.ok(response.data.cursor && response.data.cursor.length <= 2048);
      seen.push(...rowIds(response.data));
      cuts += response.data.truncated ? 1 : 0;
      cursor = response.data.cursor;
      if (identical && page > 0) {
        assert.ok(
          gapCount(response.data, "window_exceeded") > 0,
          "full identical-value windows retain the conservative gap even when their checkpoint drains",
        );
      }
      if (page === 0) {
        assert.equal(
          response.data.truncated,
          true,
          "the short window must cut the serialized page",
        );
        if (tail === 100 && !identical) {
          // The previous compact cursor had ten window entries and no inherited proof.
          const payload = cursorPayload(cursor);
          assert.ok(typeof payload === "object" && payload !== null && "cw" in payload);
          assert.ok(Array.isArray(payload.cw));
          const window: unknown[] = payload.cw;
          if (window.length === 11) {
            window.pop();
          }
          const legacyPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
          const mac = createHmac("sha256", cursorSecret)
            .update("occ-runtime-logs-cursor\0v2\0")
            .update(legacyPayload)
            .digest("base64url");
          const legacy = await readPage(route, {
            tailLines: 100,
            cursor: `v2.${legacyPayload}.${mac}`,
          });
          assert.equal(
            legacy.status,
            200,
            "legacy windows remain usable on their stable short source",
          );
          assert.deepEqual(
            rowIds(legacy.data),
            Array.from({ length: 99 - seen.length }, (_, index) => index + seen.length),
          );
        }
        route.state.lines.push(row(tail - 1, true));
      }
      if (!response.data.truncated) {
        break;
      }
    }
    assert.deepEqual(
      seen,
      range(tail).map((index) => (identical ? 7 : index)),
    );
    const replay = await readPage(route, { tailLines: tail, cursor });
    assert.equal(replay.status, 200);
    assert.deepEqual(rowIds(replay.data), []);
    if (tail === 300) {
      assert.ok(cuts >= 2, "positional proof survives multiple full-tail cuts");
    }
  }
});

test("container byte-cut checkpoints retain untimed progress or advance mixed windows", async () => {
  for (const mixed of [false, true]) {
    const route = await logsRoute({ label: "container-untimed-driver-cut" });
    const count = 330;
    const started = Date.now() - 40_000;
    route.state.lines = [
      ...Array.from({ length: count }, (_, index) => ({
        time: mixed && index > 0 ? iso(started + index * 118) : null,
        raw: `[info] row=${index}; process arguments: ${'"'.repeat(3000)}`,
      })),
      { time: null, raw: "partial trailing row" },
    ];
    route.state.truncated = true;
    assert.ok(rawBytes(route.state.lines) < 1024 * 1024);
    const seen: number[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    let drained: AgentRuntimeLogPageWire | undefined;
    while (seen.length < count && pages < 10) {
      const response = await boundedPage(route, { tailLines: 1000, cursor });
      assert.equal(response.data.truncated, true, "the underlying Driver cut remains visible");
      const rows = rowIds(response.data);
      assert.ok(rows.length > 0, "each wire cut advances through the complete fetched prefix");
      seen.push(...rows);
      cursor = response.data.cursor;
      drained = response.data;
      pages += 1;
    }
    assert.ok(pages > 1);
    assert.deepEqual(seen, range(count));
    if (mixed) {
      assert.ok(drained);
      assert.ok(
        gapCount(drained, "window_exceeded") > 0,
        "timed advancement explicitly resets the uncertain window",
      );
      const next = await readPage(route, { tailLines: 1000, cursor });
      assert.equal(next.status, 200);
      const resumedRead = route.calls.filter((call) => call.operation === "read").at(-1);
      assert.ok(resumedRead?.sinceSeconds !== undefined);
      assert.ok(
        Number.isInteger(resumedRead.sinceSeconds) && resumedRead.sinceSeconds <= 10,
        "the supported Driver receives a recent floor instead of rereading the entire old byte-cut window",
      );
      continue;
    }
    for (let poll = 0; poll < 2; poll += 1) {
      const replay = await readPage(route, { tailLines: 1000, cursor });
      assert.equal(replay.status, 200);
      assert.equal(
        messages(replay.data).length,
        0,
        "a stable byte-truncated window cannot replay its consumed untimed prefix",
      );
      assert.equal(replay.data.truncated, true);
      cursor = replay.data.cursor;
    }
  }
});

test("runtime container wire budgeting handles empty, single and grouped withheld pages", async () => {
  const route = await logsRoute({ label: "wire-budget-boundaries" });
  const row = (raw: string, index = 0) => ({ raw, time: iso(Date.now() - 1000 + index) });
  for (const lines of [
    [],
    [row(gatewayJson(`single 网络🙂 ${'--option="value" '.repeat(500)}`))],
  ]) {
    route.state.lines = lines;
    const response = await boundedPage(route, { tailLines: 200 });
    assert.equal(response.data.truncated, false);
    assert.equal(lineRecords(response.data).length, lines.length);
  }
  route.state.lines = Array.from({ length: 80 }, (_, index) =>
    row(JSON.stringify({ ordinary_metadata: "diagnostic ".repeat(900) }), index),
  );
  const withheld = await boundedPage(route, { tailLines: 200 });
  assert.equal(
    withheld.data.truncated,
    false,
    "a compact withheld run fits even when its input is large",
  );
  assert.equal(withheld.data.withheld, 80);
  const [record] = withheld.data.records;
  assert.ok(record?.type === "withheld");
  assert.equal(record.count, 80);
  const replay = await readPage(route, { cursor: withheld.data.cursor });
  assert.deepEqual(replay.data.records, []);
});

test("a full 1 MiB container window is cut after sanitizing it once", async (t) => {
  // With tailLines=1000 a chatty container fills the kubelet's 1 MiB read on every
  // poll: twice what one 512 KiB page may carry. Choosing the cut must not sanitize
  // the window again for each candidate prefix (a binary search did about five
  // window sanitizations per poll). Sanitizing a line classifies it (one JSON.parse of
  // the raw line) and redacts its message (one argv split of the message text), so
  // call-through spies on both count per-line work without depending on runner load.
  // Every spied call returns the real result.
  const started = Date.parse("2026-09-30T12:00:00Z");
  const lines = Array.from({ length: 1000 }, (_, index) => ({
    time: iso(started + index),
    raw: gatewayJson(`row=${index}; ${"diagnostic detail ".repeat(56)}`),
  }));
  assert.ok(lines.reduce((sum, { raw }) => sum + Buffer.byteLength(raw), 0) > 1024 * 1024);
  const stream: RuntimeLogStream = {
    source: "gateway",
    pod: "gateway-test-0",
    container: "gateway",
  };
  const raws = new Set(lines.map(({ raw }) => raw));
  const texts = new Set(
    lines.map(({ raw }) => {
      const value: unknown = JSON.parse(raw);
      assert.ok(typeof value === "object" && value !== null && "message" in value);
      assert.equal(typeof value.message, "string");
      return value.message;
    }),
  );
  const parse = t.mock.method(JSON, "parse");
  const split = t.mock.method(String.prototype, "split");
  const work = async (run: () => unknown) => {
    parse.mock.resetCalls();
    split.mock.resetCalls();
    await run();
    return {
      classified: parse.mock.calls.filter(
        ({ arguments: [text] }) => typeof text === "string" && raws.has(text),
      ).length,
      redacted: split.mock.calls.filter((call) => texts.has(String(call.this))).length,
    };
  };
  // The Driver's byte cut drops the final, partial line before any classification.
  const complete = lines.slice(0, -1);
  const evidence = await work(() => runtimeLogEvidence(complete));
  const once = await work(() => sanitizeRuntimeLogChunk({ stream, lines, truncated: true }));
  // The proxies hold: one sanitization classifies and redacts each complete line once,
  // and the evidence pass classifies without redacting.
  assert.deepEqual(once, { classified: complete.length, redacted: complete.length });
  assert.equal(evidence.redacted, 0);
  let page: RuntimeLogPage | undefined;
  const cut = await work(async () => {
    page = await pollReader().poll(lines, { truncated: true });
  });
  assert.ok(page);
  const delivered = lineRecords(page).length;
  assert.equal(page.truncated, true);
  assert.ok(delivered > 300 && delivered < 999, `${delivered} lines delivered`);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 512 * 1024);
  // The fetched safety evidence classifies every complete line once; the prefix
  // builds then share one sanitization. Both bounds are exact today: classifying or
  // redacting even the delivered prefix once more adds at least 300 lines.
  assert.ok(
    cut.classified <= evidence.classified + once.classified,
    `the cut page classified ${cut.classified} window lines; the evidence pass and one sanitization classify ${evidence.classified + once.classified}`,
  );
  assert.ok(
    cut.redacted <= once.redacted,
    `the cut page redacted ${cut.redacted} window messages; one sanitization redacts ${once.redacted}`,
  );
});

test("the page budget measures every page it returns, whatever its prefix estimate", async () => {
  const { boundedRuntimeLogPage } =
    await import("../../packages/occ/src/runtime-logs/page-budget.ts");
  const stream: RuntimeLogStream = {
    source: "gateway",
    pod: "gateway-test-0",
    container: "gateway",
  };
  const [record] = sanitizeRuntimeLogChunk({
    stream,
    lines: [{ time: null, raw: "sample diagnostic" }],
    truncated: false,
  }).records;
  assert.ok(record?.type === "line");
  const line = (index: number) => ({ ...record, message: `${index}`.padEnd(1000, "x") });
  // `grow` bytes of cursor per delivered line defeat the estimate, which reads only
  // record sizes; `skip` drops records so they no longer account for every line.
  const budget = ({
    count,
    grow = 0,
    skip = false,
  }: {
    count: number;
    grow?: number;
    skip?: boolean;
  }) => {
    let builds = 0;
    const page = boundedRuntimeLogPage(count, (end) => {
      builds += 1;
      return {
        revisionId: "revision-test",
        source: "gateway",
        stream,
        observedAt: "2026-09-30T12:10:00.000Z",
        records: Array.from({ length: end }, (_, index) => line(index)).filter(
          (_, index) => !skip || index % 2 === 0,
        ),
        withheld: 0,
        truncated: end < count,
        cursor: "c".repeat(64 + grow * end),
      };
    });
    return { page, builds, bytes: Buffer.byteLength(JSON.stringify(page), "utf8") };
  };
  const estimated = budget({ count: 1000 });
  const missed = budget({ count: 1000, grow: 64 });
  const unaccounted = budget({ count: 1000, skip: true });
  // A sound estimate costs the full, empty and estimated builds.
  assert.equal(estimated.builds, 3);
  for (const { page, builds, bytes } of [estimated, missed, unaccounted]) {
    assert.ok(bytes <= 512 * 1024 - 64, `${bytes} bytes`);
    assert.ok(page.records.length > 0 && page.truncated);
    assert.ok(builds <= 13, `${builds} builds`);
  }
  // A missed estimate falls back to the search below it rather than returning it.
  assert.ok(missed.builds > 3);
  assert.ok(missed.page.records.length < estimated.page.records.length);
});

// 60 rows of about 8.5 KiB at one time (or untimed): a 60-line tail is cut.
function wireContainerRows(time: string | null, count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    time,
    raw: gatewayJson(wireContainerMessage(index)),
  }));
}
function wireContainerMessage(index: number) {
  return `row=${index}; diagnostic ${'--option="value" '.repeat(500)}`;
}
const recently = () => iso(Date.now() - 1000);

test("container byte-window checkpoints drain full same-time and untimed tails", async () => {
  for (const time of [recently(), null]) {
    const route = await logsRoute({ label: "container-window" });
    route.state.lines = wireContainerRows(time);
    const { rows, cursor, pages } = await drain(route, {
      tailLines: 60,
      onPage(response, page) {
        if (page === 0) {
          const firstCount = lineRecords(response.data).length;
          assert.ok(firstCount > 16 && firstCount < 60);
          assert.equal(response.data.truncated, true);
        }
        advances(response);
      },
    });
    assert.ok(pages > 0, "expected a first page");
    assert.deepEqual(rows, range(60));
    const replay = await readPage(route, { tailLines: 60, cursor });
    assert.equal(lineRecords(replay.data).length, 0);
  }
});

test("container byte-window changes expose a fresh snapshot and fitting untimed progress", async () => {
  for (const changed of ["value", "tail", "buffer"]) {
    const route = await logsRoute({ label: "container-window-change" });
    route.state.lines = wireContainerRows(null);
    const first = await cutPage(route, { tailLines: 60 });
    if (changed === "value") {
      route.state.lines[59] = {
        time: null,
        raw: JSON.stringify({ level: "info", message: "changed suffix" }),
      };
    }
    if (changed === "buffer") {
      route.state.lines.splice(25);
    }
    const tailLines = changed === "tail" ? 25 : 60;
    const next = await boundedPage(route, { tailLines, cursor: first.data.cursor });
    assert.ok(gapCount(next.data, "window_exceeded") > 0, changed);
    assert.ok(lineRecords(next.data).length > 0, changed);
    if (changed !== "value") {
      assert.equal(next.data.truncated, false);
      const replay = await readPage(route, { tailLines, cursor: next.data.cursor });
      assert.equal(lineRecords(replay.data).length, 0, changed);
    }
  }
});

test("container byte-window checkpoints retain the pre-cut deduplication baseline", async () => {
  const route = await logsRoute({ label: "container-window-baseline" });
  const time = recently();
  const anchor = { time, raw: gatewayJson("previous diagnostic") };
  route.state.lines = [anchor];
  const initial = await readPage(route, { tailLines: 100 });
  assert.deepEqual(messages(initial.data), ["previous diagnostic"]);
  route.state.lines = [anchor, ...wireContainerRows(iso(Date.parse(time) + 1))];
  const { rows } = await drain(route, {
    tailLines: 100,
    cursor: initial.data.cursor,
    onPage(response) {
      assert.ok(messages(response.data).every((message) => message !== "previous diagnostic"));
    },
  });
  assert.deepEqual(rows, range(60));
});

test("container byte-window progress does not cross UID or restart changes", async () => {
  for (const changed of ["uid", "restart"]) {
    const route = await logsRoute({ label: "container-window-instance" });
    route.state.lines = wireContainerRows(recently());
    const first = await cutPage(route, { tailLines: 60 });
    if (changed === "uid") {
      route.state.podUid = randomUUID();
    } else {
      route.state.restartCount += 1;
    }
    const next = await readPage(route, { tailLines: 60, cursor: first.data.cursor });
    assert.equal(next.status, 200);
    assert.ok(gapCount(next.data, "stream_replaced") > 0);
    assert.ok(messages(next.data).some((message) => message.startsWith("row=0;")));
  }
});

test("container changed byte-windows keep PEM masking conservative", async () => {
  const route = await logsRoute({ label: "container-window-pem" });
  const time = recently();
  route.state.lines = wireContainerRows(time);
  const first = await cutPage(route, { tailLines: 60 });
  route.state.lines[30] = { time, raw: pemBegin };
  route.state.lines[31] = { time, raw: syntheticPemTail };
  const replacement = await readPage(route, { tailLines: 60, cursor: first.data.cursor });
  assert.equal(replacement.status, 200);
  assert.ok(gapCount(replacement.data, "window_exceeded") > 0);
  assertTailMasked(replacement.data);
  route.state.lines = [{ time: iso(Date.parse(time) + 1), raw: syntheticPemTail }];
  const carried = await readPage(route, { tailLines: 60, cursor: replacement.data.cursor });
  assertTailMasked(carried.data);
});

test("container byte-window baselines reset when the Driver observes an instance change during read", async () => {
  for (const changed of ["uid", "restart"]) {
    const route = await logsRoute({ label: "container-window-reread" });
    const { state } = route;
    const time = recently();
    state.lines = [
      {
        time: iso(Date.parse(time) + 100),
        raw: JSON.stringify({ level: "info", message: "prior instance" }),
      },
    ];
    const initial = await readPage(route, { tailLines: 60 });
    state.lines = wireContainerRows(time);
    if (changed === "uid") {
      state.readPodUid = randomUUID();
    } else {
      state.readRestartCount = 1;
    }
    const replaced = await readPage(route, { tailLines: 60, cursor: initial.data.cursor });
    assert.equal(replaced.data.truncated, true);
    assert.ok(gapCount(replaced.data, "stream_replaced") > 0);
    if (changed === "uid") {
      assert.ok(state.readPodUid);
      state.podUid = state.readPodUid;
    } else {
      assert.ok(state.readRestartCount !== undefined);
      state.restartCount = state.readRestartCount;
    }
    const rest = await readPage(route, { tailLines: 60, cursor: replaced.data.cursor });
    assert.equal(rest.status, 200);
    assert.deepEqual([...rowIds(replaced.data), ...rowIds(rest.data)], range(60));
  }
});

test("container expanded byte-windows preserve valid conservative PEM cursors", async () => {
  for (const changed of ["expanded", "empty"]) {
    const route = await logsRoute({ label: "container-window-recovery" });
    const time = recently();
    route.state.lines = [{ time: iso(Date.parse(time) - 2000), raw: pemEnd }];
    const prime = await readPage(route, { tailLines: 60 });
    const older = Array.from({ length: 100 }, (_, i) => ({
      time: iso(Date.parse(time) - 1000),
      raw: `[info] older row=${i}; diagnostic ${'"a" '.repeat(1000)}`,
    }));
    const current = wireContainerRows(time);
    route.state.lines = [...older, ...current];
    const first = await readPage(route, { tailLines: 60, cursor: prime.data.cursor });
    assert.equal(first.data.truncated, true);
    if (changed === "empty") {
      route.state.lines = [];
    }
    const { lines, cursor } = await drain(route, {
      tailLines: 160,
      cursor: first.data.cursor,
      message: "recovery must not poison the next signed cursor",
    });
    const seen = lines.map(({ message }) => message.split(";", 1)[0]);
    if (changed === "expanded") {
      assert.deepEqual(seen, [
        ...older.map(({ raw }) => raw.split(";", 1)[0]),
        ...current.map((_, index) => wireContainerMessage(index).split(";", 1)[0]),
      ]);
    } else {
      assert.equal(seen.length, 0);
    }
    const replay = await readPage(route, { tailLines: 160, cursor });
    assert.equal(replay.status, 200);
    assert.equal(lineRecords(replay.data).length, 0);
  }
});

test("container empty checkpoint recovery suppresses the next single untimed snapshot", async () => {
  const route = await logsRoute({ label: "container-empty-window" });
  route.state.lines = wireContainerRows(null);
  const first = await cutPage(route, { tailLines: 60 });
  route.state.lines = [];
  const empty = await readPage(route, { tailLines: 60, cursor: first.data.cursor });
  assert.equal(empty.status, 200);
  route.state.lines = [{ time: null, raw: gatewayJson("worker ready") }];
  const single = await readPage(route, { tailLines: 60, cursor: empty.data.cursor });
  assert.equal(lineRecords(single.data).length, 1);
  const replay = await readPage(route, { tailLines: 60, cursor: single.data.cursor });
  assert.equal(lineRecords(replay.data).length, 0);
});

// The Driver fakes below cut lines against the clock, as kubelet `sinceSeconds` does. The
// clock is frozen so the windows do not depend on how long the host takes between reads.
function freezeClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
}

test("container checkpoints preserve the existing overlap through backend processing delay", async (t) => {
  freezeClock(t);
  let calls = 0;
  const route = await logsRoute({
    label: "container-processing-delay",
    wrap: (underlying) => {
      assert.ok(underlying.readAgentRuntimeLogs);
      const read = underlying.readAgentRuntimeLogs.bind(underlying);
      return {
        ...underlying,
        async readAgentRuntimeLogs(binding, request) {
          assert.ok(request.sinceSeconds !== undefined);
          calls += 1;
          if (calls === 1) {
            underlying.state.lines = wireContainerRows(
              iso(Date.now() - request.sinceSeconds * 1000 + 500),
            );
          }
          const chunk = await read(binding, request);
          // Equivalent backend processing time, without changing the reader.
          const floor = Date.now() + (calls === 1 ? 0 : 1800) - request.sinceSeconds * 1000;
          return {
            ...chunk,
            lines: chunk.lines.filter(({ time }) => time !== null && Date.parse(time) >= floor),
          };
        },
      };
    },
  });
  const first = await cutPage(route, { tailLines: 200, sinceSeconds: 60 });
  const next = await readPage(route, { tailLines: 200, cursor: first.data.cursor });
  assert.equal(next.status, 200);
  assert.deepEqual([...rowIds(first.data), ...rowIds(next.data)], range(60));
});

test("container checkpoint windows remain stable when relative seconds round outward", async (t) => {
  freezeClock(t);
  for (const skew of [0, 2000]) {
    const route = await logsRoute({
      label: "container-relative-window",
      wrap: (underlying) => {
        assert.ok(underlying.readAgentRuntimeLogs);
        const read = underlying.readAgentRuntimeLogs.bind(underlying);
        return {
          ...underlying,
          async readAgentRuntimeLogs(binding, request) {
            const chunk = await read(binding, request);
            if (request.sinceSeconds === undefined) {
              return chunk;
            }
            const floor = Date.now() - skew - request.sinceSeconds * 1000;
            return {
              ...chunk,
              lines: chunk.lines.filter(({ time }) => time === null || Date.parse(time) >= floor),
            };
          },
        };
      },
    });
    const now = Date.now();
    const rows = wireContainerRows(iso(now - (skew === 0 ? 1000 : 11000)));
    route.state.lines = [
      { time: iso(now - skew - 10050), raw: gatewayJson("older than original window") },
      ...rows,
    ];
    const first = await readPage(route, { tailLines: 61, sinceSeconds: 10 });
    assert.equal(first.data.truncated, true);
    // A fraction of a second passes, so the resumed relative window rounds outward.
    t.mock.timers.tick(400);
    const rest = await readPage(route, { tailLines: 61, cursor: first.data.cursor });
    assert.equal(rest.status, 200);
    assert.equal(rest.data.truncated, false);
    assert.deepEqual([...rowIds(first.data), ...rowIds(rest.data)], range(60));
    assert.equal(gapCount(rest.data, "window_exceeded"), 0);
  }
});

test("container wire-prefix builds retain fetched masking evidence without advancing PEM state", async () => {
  const route = await logsRoute({ label: "container-mask-evidence" });
  const start = Date.now() - 1000;
  route.state.lines = [
    ...wireContainerRows(null, 50),
    ...Array.from({ length: 300 }, () => ({ time: null, raw: "QUJD" })),
    { time: null, raw: pemEnd },
  ].map((line, index) => ({ ...line, time: iso(start + index) }));
  const first = await cutPage(route, { tailLines: 1000 });
  assert.ok(!messages(first.data).includes("QUJD"));
  const payload = cursorPayload(first.data.cursor);
  assert.ok(typeof payload === "object" && payload !== null);
  assert.equal("po" in payload, false, "an undelivered END must not advance persistent PEM state");
  const rest = await readPage(route, { tailLines: 1000, cursor: first.data.cursor });
  assert.equal(rest.status, 200);
  assert.ok(!messages(rest.data).includes("QUJD"));
});

test("container wire continuation retains fetched JSON withholding decisions", async () => {
  const route = await logsRoute({ label: "container-json-evidence" });
  const start = Date.now() - 1000;
  const rows = [
    ...range(42).map((index) => ({
      raw: gatewayJson(`row=${index}; diagnostic ${" ".repeat(500)}${'"a" '.repeat(2100)}`),
      time: null,
    })),
    { raw: "[", time: null },
    ...Array.from({ length: 15 }, () => [
      { raw: "1".repeat(32769) + ",", time: null },
      { raw: "  true,", time: null },
    ]).flat(),
    { raw: "]", time: null },
  ];
  const timedRows = rows.map((line, index) => ({ ...line, time: iso(start + index) }));
  route.state.lines = timedRows;
  assert.ok(
    timedRows.reduce(
      (bytes, line) => bytes + Buffer.byteLength(line.raw) + Buffer.byteLength(line.time) + 2,
      0,
    ) <=
      1024 * 1024,
    "the whole fetched fixture respects the Driver read bound",
  );
  let cut = false;
  await drain(route, {
    tailLines: 1000,
    onPage(response) {
      assert.ok(!messages(response.data).some((message) => message.trim() === "true,"));
      cut ||= response.data.truncated;
    },
  });
  assert.equal(cut, true);
});

// Rows of about 7 KiB, one second apart from `start`: a 100-line tail is cut.
function ordinaryRow(start: number, index: number, name = "row") {
  return {
    time: iso(start + index * 1000),
    raw: gatewayJson(`${name}=${index}; ${"ordinary diagnostic ".repeat(350)}`),
  };
}

test("container follows a growing full wire-cut tail without replaying its delivered prefix", async () => {
  const route = await logsRoute({ label: "full-growing-wire-tail" });
  const start = Date.now() - 120_000;
  route.state.lines = range(100).map((index) => ordinaryRow(start, index));
  let cursor: string | null | undefined;
  const seen: number[] = [];
  const counts: number[] = [];
  for (let poll = 0; poll < 6; poll += 1) {
    if (poll > 0) {
      const offset = route.state.lines.length;
      route.state.lines.push(...range(3).map((index) => ordinaryRow(start, offset + index)));
    }
    const response = await boundedPage(route, { tailLines: 100, cursor });
    const rows = rowIds(response.data);
    seen.push(...rows);
    counts.push(rows.length);
    if (poll === 0) {
      assert.equal(response.data.truncated, true);
    }
    cursor = response.data.cursor;
  }
  assert.deepEqual(seen, range(115));
  assert.deepEqual(counts.slice(2), [3, 3, 3, 3]);
  const replay = await readPage(route, { tailLines: 100, cursor });
  assert.deepEqual(lineRecords(replay.data), []);
});

// A cut first page of 80 or 100 ordinary rows, then the rows a rotation leaves behind.
// Returns both pages.
async function rotatedWindow(
  label: string,
  rows: LogLine[],
  rotate: (lines: LogLine[]) => LogLine[],
) {
  const route = await logsRoute({ label });
  route.state.lines = rows;
  const first = await cutPage(route, { tailLines: 100 });
  route.state.lines = rotate(route.state.lines);
  const second = await boundedPage(route, { tailLines: 100, cursor: first.data.cursor });
  return [first.data, second.data] as const;
}

test("container checkpoint recovery does not duplicate an observed window-loss gap", async () => {
  const start = Date.now() - 120_000;
  // The burst replaces the whole tail before the byte-cut snapshot drains.
  // Actual missing rows still require one window gap, not a second gap for the
  // discarded checkpoint alongside that same observed loss.
  const [, second] = await rotatedWindow(
    "wire-cut-burst-gap",
    range(100).map((index) => ordinaryRow(start, index)),
    (lines) => [...lines, ...range(100).map((index) => ordinaryRow(start, 100 + index))],
  );
  assert.equal(gapCount(second, "window_exceeded"), 1);
});

test("container checkpoint recovery keeps an unknown-time reset visible", async () => {
  const start = Date.now() - 120_000;
  // The timed frontier cannot locate an unknown row in a changed snapshot.
  // Recovering timed rows must keep that reset visible, even on a short tail.
  const [, second] = await rotatedWindow(
    "wire-cut-unknown-reset",
    range(80).map((index) => ({
      ...ordinaryRow(start, index),
      ...(index === 0 && { time: null }),
    })),
    ([, ...rest]) => [{ time: null, raw: "changed unknown-time diagnostic" }, ...rest],
  );
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container shortened timed checkpoints disclose missing undelivered rows", async () => {
  const start = Date.now() - 120_000;
  // Rotation can leave a short surviving window in the same container. Its
  // later times establish progress, not continuity with the unread snapshot.
  const [, second] = await rotatedWindow(
    "wire-cut-shortened-timed-window",
    range(80).map((index) => ordinaryRow(start, index)),
    (lines) => lines.slice(-5),
  );
  assert.equal(lineRecords(second).length, 5);
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container same-size short replacements disclose missing undelivered rows", async () => {
  const start = Date.now() - 120_000;
  // Rotation retains the same row count but replaces the unread part with newer rows.
  const [, second] = await rotatedWindow(
    "wire-cut-same-size-short-window",
    range(80).map((index) => ordinaryRow(start, index, "old")),
    () =>
      range(80).map((index) => ({
        time: iso(start + (100 + index) * 1000),
        raw: gatewayJson(`new=${index}`),
      })),
  );
  assert.equal(lineRecords(second).length, 80);
  assert.equal(gapCount(second, "window_exceeded"), 1);
});

test("container checkpoint recovery that still covers the delivered frontier reports no loss", async () => {
  const start = Date.now() - 120_000;
  // Rotation drops only the oldest, already delivered row. The changed window still
  // starts before the delivered frontier, so every undelivered row survives.
  const [first, second] = await rotatedWindow(
    "wire-cut-covered-frontier",
    range(80).map((index) => ordinaryRow(start, index)),
    (lines) => lines.slice(1),
  );
  assert.deepEqual([...rowIds(first), ...rowIds(second)], range(80));
  assert.equal(gapCount(second, "window_exceeded"), 0);
});

// Ordinary rows whose rows from `from` on share one timestamp group.
function groupedRows(start: number, from: number) {
  return range(80).map((index) => ({
    ...ordinaryRow(start, index),
    ...(index >= from && { time: iso(start + from * 1000) }),
  }));
}

test("container checkpoint recovery discloses rows lost inside the frontier time group", async () => {
  const start = Date.now() - 120_000;
  // The surviving window starts at the delivered frontier time, so undelivered
  // rows of that group can sit before it; a later row lets time recovery start.
  const [first, second] = await rotatedWindow(
    "wire-cut-frontier-group-loss",
    groupedRows(start, 60),
    (lines) => [...lines.slice(-3), ordinaryRow(start, 80)],
  );
  const frontier = rowIds(first).at(-1);
  assert.ok(frontier !== undefined && frontier >= 60 && frontier < 76);
  assert.deepEqual(rowIds(second), [77, 78, 79, 80]);
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container checkpoint recovery discloses a reordered changed window", async () => {
  const start = Date.now() - 120_000;
  // An undelivered row now dates before the frontier, so time resumption drops it.
  const [, second] = await rotatedWindow(
    "wire-cut-reordered-window",
    range(80).map((index) => ordinaryRow(start, index)),
    (lines) => {
      const last = lines.at(-1);
      assert.ok(last);
      return [...lines.slice(1, -1), { ...last, time: iso(start) }];
    },
  );
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container checkpoint recovery discloses frontier rows its hash history cannot place", async () => {
  const start = Date.now() - 120_000;
  // The delivered group outgrows the frontier hashes and a changed row breaks the
  // positional proof, so undelivered rows of that group cannot be told apart.
  const [first, second] = await rotatedWindow(
    "wire-cut-frontier-history-loss",
    groupedRows(start, 3),
    (lines) => {
      const groupStart = lines[3];
      assert.ok(groupStart);
      return [
        ...lines.slice(1, 3),
        { time: groupStart.time, raw: gatewayJson("changed group row") },
        ...lines.slice(3),
      ];
    },
  );
  assert.ok(rowIds(first).length > 3 + 16);
  assert.ok(gapCount(second, "window_exceeded") > 0);
});

test("container checkpoint recovery reports a lost window and withheld frontier rows once", async () => {
  const start = Date.now() - 120_000;
  // As above, with a later row that moves the frontier past the withheld group rows.
  // The lost checkpoint and the unreadable frontier rows are one gap, not two.
  const [, second] = await rotatedWindow(
    "wire-cut-frontier-history-advance",
    groupedRows(start, 3),
    (lines) => {
      const groupStart = lines[3];
      assert.ok(groupStart);
      return [
        ...lines.slice(1, 3),
        { time: groupStart.time, raw: gatewayJson("changed group row") },
        ...lines.slice(3),
        ordinaryRow(start, 80),
      ];
    },
  );
  assert.deepEqual(rowIds(second), [80]);
  assert.equal(gapCount(second, "window_exceeded"), 1);
});

test("container checkpoint recovery discloses a window whose clock stepped back", async () => {
  const start = Date.now() - 120_000;
  // Rotation dropped the delivered frontier and the rows after it, and the node
  // clock stepped back: the new rows are ordered and all before the frontier.
  const [, second] = await rotatedWindow(
    "wire-cut-clock-step-back",
    range(80).map((index) => ordinaryRow(start, index)),
    () => range(6).map((index) => ordinaryRow(start, 40 + index, "after-step")),
  );
  assert.ok(gapCount(second, "window_exceeded") > 0);
});
