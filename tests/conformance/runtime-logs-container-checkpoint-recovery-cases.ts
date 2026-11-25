import assert from "node:assert/strict";
import test from "node:test";

import { gatewayJson, logsRoute } from "../helpers/runtime-logs-content.ts";
import {
  boundedPage,
  cutPage,
  gapCount,
  iso,
  lineRecords,
  range,
  readPage,
  rowIds,
  type LogLine,
} from "./runtime-logs-container-wire-fixture.ts";

// Rows of about 7 KiB, one second apart from `start`: a 100-line tail is cut.
function ordinaryRow(start: number, index: number, name = "row") {
  return {
    time: iso(start + index * 1000),
    raw: gatewayJson(`${name}=${index}; ${"ordinary diagnostic ".repeat(350)}`),
  };
}

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

// Ordinary rows whose rows from `from` on share one timestamp group.
function groupedRows(start: number, from: number) {
  return range(80).map((index) => ({
    ...ordinaryRow(start, index),
    ...(index >= from && { time: iso(start + from * 1000) }),
  }));
}

function changedFrontier(lines: LogLine[]) {
  const groupStart = lines[3];
  assert.ok(groupStart);
  return [
    ...lines.slice(1, 3),
    { time: groupStart.time, raw: gatewayJson("changed group row") },
    ...lines.slice(3),
  ];
}

export function registerContainerCheckpointRecoveryCases() {
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
      changedFrontier,
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
      (lines) => [...changedFrontier(lines), ordinaryRow(start, 80)],
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
}
