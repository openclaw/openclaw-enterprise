import type { AgentRevision, Namespace } from "./index.ts";

/**
 * Runtime log classes. OCC classifies every record; a source never sets the class.
 * `content` (message text, prompts, tool output) is reserved and has no producer.
 */
export type RuntimeLogContentClass = "operational" | "activity" | "content";
/** Container sources are Pods the Compute Driver lists; `sandbox` is the Sandbox Driver's log. */
export type RuntimeLogContainerSourceId = "gateway" | "agent";
export type RuntimeLogSourceId = RuntimeLogContainerSourceId | "sandbox";
export type RuntimeLogLevel = "error" | "warn" | "info" | "debug" | "unknown";
export type RuntimeLogKind = "wrapper" | "openclaw" | "codex" | "sandbox" | "text";
export type RuntimeLogGapReason =
  "stream_replaced" | "window_exceeded" | "cursor_expired" | "truncated" | "buffer_lost";
export type RuntimeLogWithheldReason = "unrecognised_structured" | "oversized" | "malformed";

/** One container instance or sandbox, keyed on server-observed identity only. */
export interface RuntimeLogStream {
  readonly source: RuntimeLogSourceId;
  readonly pod?: string;
  readonly podUid?: string;
  readonly container?: string;
  readonly restartCount?: number;
  /** Sandbox source: the OCC-derived Sandbox name of this revision. */
  readonly sandbox?: string;
}

export type RuntimeLogRecord =
  | {
      readonly type: "line";
      readonly time: string | null;
      readonly stream: RuntimeLogStream;
      readonly contentClass: RuntimeLogContentClass;
      readonly kind: RuntimeLogKind;
      readonly level: RuntimeLogLevel;
      readonly message: string;
      readonly subsystem?: string;
      readonly fields?: Readonly<Record<string, string | number | boolean>>;
      readonly truncated?: true;
    }
  | {
      readonly type: "gap";
      readonly time: string | null;
      readonly stream: RuntimeLogStream;
      readonly reason: RuntimeLogGapReason;
      readonly remedy: string;
    }
  | {
      readonly type: "withheld";
      readonly time: string | null;
      readonly stream: RuntimeLogStream;
      readonly count: number;
      readonly reason: RuntimeLogWithheldReason;
    };

export interface AgentRuntimeContainerStatus {
  readonly name: string;
  readonly state: "waiting" | "running" | "terminated" | "unknown";
  readonly reason: string | null;
  readonly ready: boolean;
  readonly restartCount: number;
  readonly startedAt: string | null;
  readonly lastTermination: {
    readonly reason: string | null;
    readonly exitCode: number | null;
    readonly finishedAt: string | null;
  } | null;
}

export interface AgentRuntimeEvent {
  readonly type: "Normal" | "Warning";
  /** Container the Event concerns (from `involvedObject.fieldPath`), or null for the Pod. */
  readonly container: string | null;
  readonly reason: string;
  readonly message: string;
  readonly count: number;
  readonly lastObservedAt: string | null;
}

export interface AgentRuntimePodStatus {
  readonly role: RuntimeLogContainerSourceId;
  /** `execution` only when the Pod runs on a separately configured execution cluster. */
  readonly cluster: "control" | "execution";
  readonly name: string;
  readonly uid: string;
  readonly phase: string;
  readonly ready: boolean;
  readonly createdAt: string | null;
  readonly containers: readonly AgentRuntimeContainerStatus[];
  /** Pod-scoped Events, newest first, at most 100. */
  readonly events: readonly AgentRuntimeEvent[];
}

export interface AgentRuntimeLogSource {
  readonly id: RuntimeLogSourceId;
  /** `sandbox` sources list no Pods; OCC derives the Sandbox from the revision. */
  readonly kind: "container" | "sandbox";
  readonly pods: readonly {
    readonly name: string;
    readonly uid: string;
    readonly container: string;
    readonly restartCount: number;
  }[];
  readonly available: boolean;
  readonly unavailableCode?: "NO_POD";
  /** Fixed notice for loss the API cannot observe. */
  readonly retention: string;
}

export interface AgentRuntimeDescription {
  readonly revisionId: string;
  readonly observedAt: string;
  readonly pods: readonly AgentRuntimePodStatus[];
  readonly sources: readonly AgentRuntimeLogSource[];
}

/** Narrows a description for a log read, which needs one source's Pods and no Events. */
export interface AgentRuntimeDescribeOptions {
  /** Describe only this source's Pods; other sources are omitted. */
  readonly source?: RuntimeLogContainerSourceId;
  /** `false` skips Pod Event lists; each Pod then carries no Events. */
  readonly events?: boolean;
}

export interface AgentRuntimeLogRequest {
  readonly source: RuntimeLogContainerSourceId;
  readonly pod: string;
  readonly podUid: string;
  readonly container: string;
  readonly previous: boolean;
  readonly tailLines: number;
  readonly sinceSeconds?: number;
  readonly limitBytes: number;
  readonly signal: AbortSignal;
}

/** Raw lines as the runtime wrote them; OCC classifies and redacts every line. */
export interface AgentRuntimeLogChunk {
  /** Stream identity re-read after the log read. */
  readonly stream: RuntimeLogStream;
  readonly observedAt: string;
  readonly lines: readonly { readonly time: string | null; readonly raw: string }[];
  /** The byte limit cut the output; the final line may be partial. */
  readonly truncated: boolean;
}

/** Where a Sandbox Driver finds one revision's Sandbox; the Namespace is Compute's placement. */
export interface SandboxLogContext {
  readonly namespace: Readonly<Namespace>;
  readonly revision: Readonly<AgentRevision>;
  readonly signal: AbortSignal;
}

export interface SandboxLogRequest {
  /** Most recent lines to return, 1 to 1000. */
  readonly lines: number;
  /** Only lines at or after this RFC 3339 time. */
  readonly sinceTime?: string;
}

/** One raw Sandbox log line as the Sandbox runtime reported it; OCC sanitizes every field. */
export interface SandboxLogLine {
  readonly time: string | null;
  readonly sandboxId: string;
  readonly level: string;
  readonly target: string;
  readonly message: string;
  /** Where the line was produced, for example `gateway` or `sandbox`. */
  readonly source: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** Raw, bounded Sandbox log lines in chronological order. */
export interface SandboxLogChunk {
  /** The Sandbox name the Driver read; OCC checks it against the revision. */
  readonly sandbox: string;
  readonly observedAt: string;
  readonly lines: readonly SandboxLogLine[];
  /**
   * Lines the source examined before applying `sinceTime`: the requested line count
   * when the buffer held at least that many, otherwise the whole buffer.
   */
  readonly bufferTotal: number;
}
