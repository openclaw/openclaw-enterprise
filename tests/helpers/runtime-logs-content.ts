import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import type {
  AgentRuntimeDescription,
  AgentRuntimeLogChunk,
  AgentRuntimeLogRequest,
  AgentRuntimeLogPageWire,
} from "../../packages/contracts/src/index.ts";
import {
  createRuntimeLogCursorCodec,
  type RuntimeLogCursorBinding,
} from "../../packages/occ/src/runtime-logs/cursor.ts";
import {
  readRuntimeLogPage,
  type RuntimeLogPage,
  type RuntimeLogQuery,
} from "../../packages/occ/src/runtime-logs/read.ts";
import { createRuntimeLogComputeDriver, createRuntimeLogFixture } from "./runtime-logs.ts";

export function gatewayJson(message: string) {
  return JSON.stringify({ level: "info", subsystem: "gateway", message });
}

type LogDriver = ReturnType<typeof createRuntimeLogComputeDriver>;
type LogRouteOptions = Omit<
  NonNullable<Parameters<typeof createRuntimeLogFixture>[0]>,
  "computeDriver"
> & {
  label?: string;
  state?: Partial<LogDriver["state"]>;
  wrap?: (driver: LogDriver) => LogDriver;
};
type LogRouteQuery = Record<string, string | number | boolean | null | undefined>;

// Serve one deployed Agent through the production controller app with controlled Driver output.
export async function logsRoute({ label, state, wrap, ...options }: LogRouteOptions = {}) {
  const driver = createRuntimeLogComputeDriver(state === undefined ? {} : { state });
  const fixture = await createRuntimeLogFixture({
    ...options,
    computeDriver: wrap === undefined ? driver : wrap(driver),
  });
  const target = await fixture.deployAgent(label);
  return {
    fixture,
    target,
    state: driver.state,
    calls: driver.calls,
    get: (path: string) => fixture.request("GET", path),
    // GET the gateway source's logs; undefined query values are left out.
    read(query: LogRouteQuery = {}) {
      const params = new URLSearchParams({ source: "gateway" });
      for (const [name, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(name, String(value));
        }
      }
      return fixture.request("GET", target.logsPath(params.toString()));
    },
  };
}

type PollOptions = {
  pod?: Partial<AgentRuntimeDescription["sources"][number]["pods"][number]>;
  query?: Partial<Omit<RuntimeLogQuery, "cursor">> & { cursor?: string | undefined };
  binding?: RuntimeLogCursorBinding;
  elapsed?: number;
  stream?: Partial<AgentRuntimeLogChunk["stream"]>;
  truncated?: boolean;
};

// Controlled Driver output; the reader, authenticated cursor and sanitizer are real.
// These source tests do not qualify a Kubernetes/provider deployment.
export function pollReader({ secret = randomBytes(32).toString("hex") } = {}) {
  const binding: RuntimeLogCursorBinding = {
    principalId: "synthetic-person",
    agentId: "agent-test",
    revisionId: "revision-test",
    source: "gateway",
  };
  const pod = {
    name: "gateway-test-0",
    uid: "synthetic-pod-0",
    container: "gateway",
    restartCount: 0,
  };
  const codec = createRuntimeLogCursorCodec(secret);
  let cursor: string | null = null;
  let reads = 0;
  let admissions = 0;
  const requests: AgentRuntimeLogRequest[] = [];
  const now = Date.parse("2026-09-30T12:10:00Z");
  return {
    codec,
    binding,
    requests,
    get cursor() {
      return cursor;
    },
    // The signed position of the current cursor.
    get position() {
      assert.ok(cursor);
      const decoded = codec.decode(cursor, binding);
      assert.ok(decoded.status !== "invalid");
      return decoded.position;
    },
    get reads() {
      return reads;
    },
    get admissions() {
      return admissions;
    },
    async poll(lines: AgentRuntimeLogChunk["lines"], options: PollOptions = {}) {
      const selected = { ...pod, ...options.pod };
      const description: AgentRuntimeDescription = {
        revisionId: binding.revisionId,
        observedAt: new Date(now).toISOString(),
        pods: [],
        sources: [
          {
            id: "gateway",
            kind: "container",
            available: true,
            pods: [selected],
            retention: "Kubernetes keeps the current and the previous instance.",
          },
        ],
      };
      const { cursor: requestedCursor, ...query } = {
        source: "gateway" as const,
        previous: false,
        tailLines: 1000,
        cursor: cursor ?? undefined,
        ...options.query,
      };
      const result = await readRuntimeLogPage({
        description,
        query: { ...query, ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }) },
        codec,
        binding: options.binding ?? binding,
        signal: new AbortController().signal,
        now: () => now + (options.elapsed ?? 0),
        admitView: async () => {
          admissions += 1;
        },
        readLogs: async (request) => {
          reads += 1;
          requests.push(request);
          return {
            stream: {
              source: "gateway",
              pod: selected.name,
              podUid: selected.uid,
              container: "gateway",
              restartCount: selected.restartCount,
              ...options.stream,
            },
            lines,
            observedAt: description.observedAt,
            truncated: options.truncated ?? false,
          };
        },
      });
      cursor = result.cursor;
      return result;
    },
    // The messages of the delivered lines.
    async shown(lines: AgentRuntimeLogChunk["lines"], options?: PollOptions) {
      return messages(await this.poll(lines, options));
    },
  };
}

export const pemBegin = "-----BEGIN PRIVATE KEY-----";
export const pemEnd = "-----END PRIVATE KEY-----";
export const syntheticPemTail = Buffer.from("synthetic-tail-data").toString("base64");

export function messages(page: Pick<RuntimeLogPage | AgentRuntimeLogPageWire, "records">) {
  return page.records.filter((record) => record.type === "line").map((record) => record.message);
}

export function assertTailMasked(page: Pick<RuntimeLogPage | AgentRuntimeLogPageWire, "records">) {
  assert.equal(JSON.stringify(page.records).includes(syntheticPemTail), false);
  assert.ok(messages(page).some((message) => message.includes("[redacted:pem]")));
}

export function cursorPayload(cursor: string | null): unknown {
  assert.ok(cursor);
  const [, encoded] = cursor.split(".");
  assert.ok(encoded);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}
