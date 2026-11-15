import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeLogContainerSourceId, RuntimeLogRecord } from "@openclaw-enterprise/contracts";
import type { AgentSelection } from "./plugin-gateway-session-evidence.ts";
import { redactedQaTail, registerQaSecret } from "./qa-secrets.mjs";

type RevisionLogTarget = {
  namespaceId: AgentSelection["namespaceId"];
  agentId: AgentSelection["id"];
  revisionId: NonNullable<AgentSelection["revision"]>["id"];
};
type AdmittedLogTarget = Omit<RevisionLogTarget, "revisionId"> & { revisionId: string };

type LineRecord = Extract<RuntimeLogRecord, { type: "line" }>;
type GapRecord = Extract<RuntimeLogRecord, { type: "gap" }>;
type WithheldRecord = Extract<RuntimeLogRecord, { type: "withheld" }>;
type RuntimeLogEntry =
  | Pick<LineRecord, "type" | "time" | "level" | "message" | "fields">
  | (Pick<GapRecord, "type" | "time" | "reason"> & { count?: never })
  | Pick<WithheldRecord, "type" | "time" | "reason" | "count">;

type SourceEvidence = { source: RuntimeLogContainerSourceId } & (
  { lines: string[] } | { unavailable: true }
);
type RuntimeLogAdapters = {
  readRuntimeLogs?: (
    target: AdmittedLogTarget & { source: RuntimeLogContainerSourceId },
  ) => Promise<{ records: readonly RuntimeLogEntry[] }>;
  recordRuntimeLogs?: (
    record: AdmittedLogTarget & { sources: SourceEvidence[] },
  ) => void | Promise<void>;
};

const runtimeLogSources: readonly RuntimeLogContainerSourceId[] = ["gateway", "agent"];

export function pluginRevisionLogTarget(agent: AgentSelection): RevisionLogTarget {
  return {
    namespaceId: agent.namespaceId,
    agentId: agent.id,
    revisionId: agent.revision?.id,
  };
}

export function createPluginRevisionFailureLogs({
  readRuntimeLogs,
  recordRuntimeLogs,
}: RuntimeLogAdapters) {
  async function captureRuntimeFailureLogs(
    logTarget: RevisionLogTarget,
    secrets: readonly unknown[] = [],
  ) {
    const { revisionId } = logTarget;
    if (!readRuntimeLogs || !recordRuntimeLogs || !revisionId) {
      return;
    }
    // OCC authorizes and redacts each exact revision read. Apply the existing QA
    // redactor again for fixture secrets before writing the public evidence artifact.
    try {
      for (const value of secrets) {
        if (typeof value === "string" && value) {
          registerQaSecret(value);
        }
      }
      const sources: SourceEvidence[] = [];
      for (const source of runtimeLogSources) {
        // Stay within OCC's two log reads/second per principal and Agent.
        await delay(500);
        try {
          const page = await readRuntimeLogs({ ...logTarget, revisionId, source });
          const lines = page.records.map((record) => {
            if (record.type === "line") {
              const { type, time, level, message, fields } = record;
              return JSON.stringify({ type, time, level, message, fields });
            }
            const { type, time, reason, count } = record;
            return JSON.stringify({ type, time, reason, count });
          });
          sources.push({
            source,
            lines: redactedQaTail(lines.join("\n"), process.env, {
              lines: 80,
              lineChars: 900,
            }),
          });
        } catch {
          sources.push({ source, unavailable: true });
        }
      }
      await recordRuntimeLogs({ ...logTarget, revisionId, sources });
    } catch {
      // Diagnostic reads/writes must never replace the original turn failure.
    }
  }

  async function withRuntimeFailureLogs<T>(agent: AgentSelection, action: () => T | Promise<T>) {
    const logTarget = pluginRevisionLogTarget(agent);
    try {
      return await action();
    } catch (error) {
      await captureRuntimeFailureLogs(logTarget);
      throw error;
    }
  }

  return { captureRuntimeFailureLogs, withRuntimeFailureLogs };
}
