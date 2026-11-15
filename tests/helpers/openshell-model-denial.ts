import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  openShellSandboxLogReader,
  type OpenShellSandboxLogLine,
  type OpenShellSandboxLogReader,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

type Category =
  | "policy-deny-rule"
  | "policy-not-permitted"
  | "policy-denied"
  | "request-credential-denied"
  | "online-authorization-denied"
  | "middleware-denied"
  | "middleware-timeout"
  | "middleware-chain-timeout"
  | "middleware-failed"
  | "other"
  | "request-authority-mismatch"
  | "credential-endpoint-mismatch"
  | "credential-unavailable"
  | "credential-placement-mismatch";

type Denial = { scope: "model" | "sandbox"; category: Category };

type Summary = {
  state: "observed" | "unavailable";
  truncated: boolean;
  events: (Denial & { count: number })[];
};

const ringSize = 2000;

function eventTime(value: string | null): number {
  assert.ok(value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(value));
  const time = Date.parse(value);
  assert.ok(
    Number.isSafeInteger(time) &&
      time >= 0 &&
      new Date(time).toISOString() === value.slice(0, 23) + "Z",
  );
  return time;
}

function category(engine: string | undefined, reason: string, endpoint: URL): Category {
  if (engine === "l7") {
    const prefix =
      "L7_REQUEST deny POST " +
      endpoint.hostname +
      ":" +
      (endpoint.port || "443") +
      endpoint.pathname +
      " reason=";
    if (reason.startsWith(prefix)) {
      const detail = reason.slice(prefix.length);
      if (detail === "POST /v1/responses blocked by deny rule") {
        return "policy-deny-rule";
      }
      if (detail === "POST /v1/responses not permitted by policy") {
        return "policy-not-permitted";
      }
      return "policy-denied";
    }
  }
  if (engine === "middleware") {
    const denied = /^middleware_denied:[a-zA-Z0-9_-]+(?::([a-z0-9_]+))?$/.exec(reason);
    if (denied) {
      if (denied[1] === "request_credential_denied") {
        return "request-credential-denied";
      }
      if (denied[1] === "online_authorization_denied") {
        return "online-authorization-denied";
      }
      return "middleware-denied";
    }
    if (reason.startsWith("middleware_failed: ")) {
      if (reason === "middleware_failed: middleware_timeout") {
        return "middleware-timeout";
      }
      if (reason === "middleware_failed: middleware_chain_timeout") {
        return "middleware-chain-timeout";
      }
      return "middleware-failed";
    }
  }
  return "other";
}

function denial(line: OpenShellSandboxLogLine, endpoint: URL) {
  if (
    line.source !== "sandbox" ||
    line.level !== "OCSF" ||
    line.target !== "ocsf" ||
    Object.keys(line.fields).length !== 0
  ) {
    return undefined;
  }
  // The supplier pushes OCSF shorthand, not the structured destination. Its
  // method-only authority/credential denials can describe this Sandbox only.
  const match =
    /^HTTP:(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE) \[(MED|HIGH)\] DENIED (?:\S+\(\d+\) -> )?\1 (.*)$/.exec(
      line.message,
    );
  if (!match) {
    return undefined;
  }
  const tail = match[3] ?? "";
  const methodOnly =
    /^ \[policy:[^\]\r\n]* engine:(request-authority|credential-binding)\] \[reason:(request_authority_mismatch|credential_endpoint_mismatch|credential_unavailable|credential_placement_mismatch)\]$/.exec(
      tail,
    );
  if (methodOnly) {
    const reason = methodOnly[2];
    if (
      (methodOnly[1] === "request-authority") !== (reason === "request_authority_mismatch") ||
      match[2] !== (reason === "credential_unavailable" ? "MED" : "HIGH")
    ) {
      return undefined;
    }
    const categories: Record<string, Category> = {
      request_authority_mismatch: "request-authority-mismatch",
      credential_endpoint_mismatch: "credential-endpoint-mismatch",
      credential_unavailable: "credential-unavailable",
      credential_placement_mismatch: "credential-placement-mismatch",
    };
    return {
      scope: "sandbox" as const,
      category: categories[reason ?? ""] ?? "other",
      truncated: false,
    };
  }
  const parts = /^(\S+) (.*)$/.exec(tail);
  if (match[1] !== "POST" || match[2] !== "MED" || !parts?.[1]) {
    return undefined;
  }
  let observed: URL;
  try {
    observed = new URL(parts[1]);
  } catch {
    return undefined;
  }
  if (observed.href !== endpoint.href) {
    return undefined;
  }
  const context = parts[2] ?? "";
  const engine = /^\[policy:[^\]\r\n]* engine:([a-z0-9-]+)\]/.exec(context)?.[1];
  const reason = /\[(?:[^\]\r\n]* )?reason:([^\r\n]*)\]$/.exec(context)?.[1] ?? "";
  return {
    scope: "model" as const,
    category: category(engine, reason, endpoint),
    truncated: reason.endsWith("..."),
  };
}

/**
 * Best-effort diagnostic read of one selected Sandbox's bounded log ring. Counts
 * describe retained HTTP denial records, not requests or approval correlations.
 * Log delivery is best effort: an empty observed ring is not evidence of no denial.
 */
export async function collectOpenShellModelDenials({
  gatewayClient,
  workspace,
  sandbox,
  sandboxId,
  modelEndpoint,
  startedAt,
  endedAt,
  readSupervisor,
  signal,
}: {
  gatewayClient: OpenShellSandboxLogReader;
  workspace: string;
  sandbox: string;
  sandboxId: string;
  modelEndpoint: string;
  startedAt: number;
  endedAt: number;
  readSupervisor: (signal: AbortSignal) => Promise<{ readonly sandboxId: string }>;
  signal: AbortSignal;
}): Promise<Summary> {
  let truncated = false;
  try {
    assert.ok(workspace && sandbox && sandboxId);
    assert.ok(
      Number.isSafeInteger(startedAt) &&
        Number.isSafeInteger(endedAt) &&
        startedAt >= 0 &&
        endedAt >= startedAt,
    );
    const endpoint = new URL(modelEndpoint);
    assert.ok(
      endpoint.protocol === "https:" &&
        !endpoint.username &&
        !endpoint.password &&
        !endpoint.search &&
        !endpoint.hash &&
        endpoint.pathname === "/v1/responses",
    );
    // The callback must honor this same deadline; do not race uncancelled work.
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    readSignal.throwIfAborted();
    const identity = structuredClone(await readSupervisor(readSignal));
    assert.equal(identity.sandboxId, sandboxId);
    const { lines, bufferTotal } = await openShellSandboxLogReader(gatewayClient).getSandboxLogs(
      { workspace, sandbox, lines: ringSize },
      readSignal,
    );
    truncated = lines.length === ringSize || bufferTotal !== lines.length;
    assert.ok(
      lines.length <= ringSize &&
        Number.isSafeInteger(bufferTotal) &&
        bufferTotal >= lines.length &&
        bufferTotal <= ringSize,
    );
    const counts = new Map<string, Denial & { count: number }>();
    for (const line of lines) {
      assert.equal(line.sandboxId, sandboxId);
      const time = eventTime(line.time);
      if (time < startedAt || time > endedAt) {
        continue;
      }
      const observed = denial(line, endpoint);
      if (observed) {
        const key = observed.scope + ":" + observed.category;
        counts.set(key, {
          scope: observed.scope,
          category: observed.category,
          count: (counts.get(key)?.count ?? 0) + 1,
        });
        truncated ||= observed.truncated;
      }
    }
    assert.ok(isDeepStrictEqual(await readSupervisor(readSignal), identity));
    readSignal.throwIfAborted();
    truncated ||= counts.size > 8;
    return {
      state: "observed",
      truncated,
      events: [...counts.values()].slice(0, 8),
    };
  } catch {
    return { state: "unavailable", truncated, events: [] };
  }
}
