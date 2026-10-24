import { isDeepStrictEqual } from "node:util";
import { createOccLogger, emitOccLogEvent } from "../../apps/controller/src/logging.ts";
import { jsonChunkDestination } from "./json-lines.mjs";

// The worker, the API and the maintenance scripts log events through the production logger,
// which keeps only bounded fields it allows. A test that asserts an event before the logger can
// pass while the field never reaches the log (findings 2244, 2245); these log it the same way.
const lines: Record<string, unknown>[] = [];
const logger = createOccLogger({
  component: "occ-worker",
  level: "debug",
  destination: jsonChunkDestination(lines),
});

/** The line the production logger writes for this event. */
export function occLogLine(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  emitOccLogEvent(logger, event);
  return lines.pop() ?? {};
}

/** The event's fields the production logger drops or changes. */
export function unloggedFields(event: Readonly<Record<string, unknown>>): string[] {
  const line = occLogLine(event);
  return Object.keys(event).filter((key) => !isDeepStrictEqual(line[key], event[key]));
}
