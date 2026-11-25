import assert from "node:assert/strict";

import { Check } from "typebox/value";

import {
  AgentRuntimeLogsResponse,
  type AgentRuntimeLogChunk,
  type AgentRuntimeLogPageWire,
  type RuntimeLogRecord,
} from "../../packages/contracts/src/index.ts";
import type { RuntimeLogPage } from "../../packages/occ/src/runtime-logs/read.ts";
import type { logsRoute } from "../helpers/runtime-logs-content.ts";

export type LogRoute = Awaited<ReturnType<typeof logsRoute>>;
type LogQuery = NonNullable<Parameters<LogRoute["read"]>[0]>;
export type LogLine = AgentRuntimeLogChunk["lines"][number];
type PageRecords = Pick<RuntimeLogPage | AgentRuntimeLogPageWire, "records">;
type PageRecord = PageRecords["records"][number];

export const lineRecords = (page: PageRecords) =>
  page.records.filter((record: PageRecord) => record.type === "line");
type GapReason = Extract<RuntimeLogRecord, { type: "gap" }>["reason"];

export const gapCount = (page: PageRecords, reason: GapReason) =>
  page.records.filter((record) => record.type === "gap" && record.reason === reason).length;
export const range = (count: number) => Array.from({ length: count }, (_, index) => index);
// The `row=<n>` index of each delivered line, from JSON messages or `[info]` text lines.
export const rowIds = (page: PageRecords) =>
  lineRecords(page).map(({ message }) => {
    const match = /^(?:\[info\] )?row=(\d+);/.exec(message);
    assert.ok(match, `not a row line: ${message.slice(0, 80)}`);
    return Number(match[1]);
  });
export const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

export async function readPage(route: LogRoute, query: LogQuery, message?: string) {
  const response = await route.read(query);
  assert.equal(response.status, 200, message ?? response.text.slice(0, 200));
  const { body } = response;
  assert.ok(Check(AgentRuntimeLogsResponse, body), "expected a runtime log response");
  return { ...response, body, data: body.data };
}

export type WireResponse = Awaited<ReturnType<typeof readPage>>;

// One page of the route's response, within the 512 KiB response bound.
export async function boundedPage(route: LogRoute, query: LogQuery, message?: string) {
  const response = await readPage(route, query, message);
  assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
  return response;
}
// A first page that the response bound cut.
export async function cutPage(route: LogRoute, query: LogQuery) {
  const response = await boundedPage(route, query);
  assert.equal(response.data.truncated, true);
  return response;
}
