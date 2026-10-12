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

function fits(page: Readonly<RuntimeLogPage>): boolean {
  return Buffer.byteLength(JSON.stringify(page), "utf8") + ENVELOPE_BYTES <= MAX_RESPONSE_BYTES;
}

/** Select a fitting raw prefix; all builds are pure and reuse one admitted read. */
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
