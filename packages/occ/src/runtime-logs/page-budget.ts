import type { RuntimeLogPage } from "./read.ts";

const MAX_RESPONSE_BYTES = 512 * 1024;
// The runtime-log route wraps the page with { data, meta: { requestId } }.
// createFastifyApp disables supplied IDs and generates req_ followed by a UUID;
// runtimeLogPageBody retains precisely the RuntimeLogPage fields. Size that frame
// with the real ID shape, independently of the page and its signed cursor.
const ENVELOPE_BYTES =
  Buffer.byteLength(
    JSON.stringify({ data: null, meta: { requestId: "req_00000000-0000-4000-8000-000000000000" } }),
    "utf8",
  ) - Buffer.byteLength("null", "utf8");
// Room the estimate leaves for what grows between the empty prefix and a longer
// one: frontier hashes and times in the signed cursor (48 hashes are about 1 KiB
// once encoded), a dated cut gap, an overflow or stalled-read gap, withheld digits.
const ESTIMATE_SLACK_BYTES = 4 * 1024;

function pageBytes(page: Readonly<RuntimeLogPage>): number {
  return Buffer.byteLength(JSON.stringify(page), "utf8") + ENVELOPE_BYTES;
}

function fits(page: Readonly<RuntimeLogPage>): boolean {
  return pageBytes(page) <= MAX_RESPONSE_BYTES;
}

/**
 * Serialized bytes each raw line adds, read off the full page: a line record is
 * one line, a withheld run is `count` lines (its record is charged to the first),
 * a gap is none. Undefined when the records do not account for `count` lines.
 */
function lineCosts(full: Readonly<RuntimeLogPage>, count: number): number[] | undefined {
  const costs: number[] = [];
  for (const record of full.records) {
    if (record.type === "gap") {
      continue;
    }
    // One comma separates each record from the next.
    costs.push(Buffer.byteLength(JSON.stringify(record), "utf8") + 1);
    if (record.type === "withheld") {
      for (let index = 1; index < record.count; index += 1) {
        costs.push(0);
      }
    }
  }
  return costs.length === count ? costs : undefined;
}

/**
 * Select a fitting raw prefix; all builds are pure and reuse one admitted read.
 * Builds share one sanitization (`createRuntimeLogSanitizeMemo`), so a prefix
 * build costs serialization, not redaction.
 */
export function boundedRuntimeLogPage(
  count: number,
  build: (end: number) => Readonly<RuntimeLogPage>,
): Readonly<RuntimeLogPage> {
  const full = build(count);
  if (fits(full)) {
    return full;
  }
  let lower = 0;
  let upper = count;
  let page = build(0);
  if (!fits(page)) {
    throw new Error("Runtime log response metadata exceeds the page limit.");
  }
  // Estimate the longest prefix from the full page's record sizes over the empty
  // page, and keep it if one build confirms that it fits. The estimate only picks
  // the first candidate: a page is returned only after it was measured.
  const costs = lineCosts(full, count);
  if (costs !== undefined) {
    let room = MAX_RESPONSE_BYTES - pageBytes(page) - ESTIMATE_SLACK_BYTES;
    let estimate = 0;
    while (estimate < count && costs[estimate]! <= room) {
      room -= costs[estimate]!;
      estimate += 1;
    }
    if (estimate > 0 && estimate < count) {
      const candidate = build(estimate);
      if (fits(candidate)) {
        return candidate;
      }
      upper = estimate;
    }
  }
  // At most ceil(log2(1001)) further builds. Withheld grouping and masking can
  // change prefix costs, so this promises a fitting page, not maximum filling.
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = build(middle);
    if (fits(candidate)) {
      lower = middle;
      page = candidate;
    } else {
      upper = middle;
    }
  }
  if (lower === 0 && count !== 0) {
    // Never return a non-advancing successful page for an unrepresentable record.
    throw new Error("A runtime log record exceeds the response page limit.");
  }
  return page;
}
