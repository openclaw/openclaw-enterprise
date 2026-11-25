import assert from "node:assert/strict";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

export function captureLogs(
  component: string,
  level?: Parameters<typeof createOccLogger>[0]["level"],
) {
  const lines: Record<string, unknown>[] = [];
  const logger = createOccLogger({
    component,
    ...(level === undefined ? {} : { level }),
    destination: {
      write(chunk: unknown) {
        for (const line of String(chunk).split("\n")) {
          if (line.length > 0) {
            const parsed: unknown = JSON.parse(line);
            const record = asRecord(parsed);
            assert.ok(record, "the logger emits JSON objects");
            lines.push(record);
          }
        }
        return true;
      },
    },
  });
  return { logger, lines };
}

export function logAt(
  lines: readonly Record<string, unknown>[],
  index: number,
): Record<string, unknown> {
  const line = lines.at(index);
  assert.ok(line, `missing log at index ${index}`);
  return line;
}
