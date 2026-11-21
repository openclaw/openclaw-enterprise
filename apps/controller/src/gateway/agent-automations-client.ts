import {
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  type GatewayClientOptions,
} from "@openclaw/gateway-client";
import {
  AgentAutomationSchema,
  AgentAutomationRunsPageSchema,
  AgentAutomationUnsupportedSummary,
  type AgentRevision,
  type AgentAutomationOwnership,
  type AgentAutomationCreateInput,
  type AgentAutomationUpdateInput,
  type AgentAutomationData,
  type AgentAutomationSummary,
  type AgentAutomationRunsPage,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { Check } from "typebox/value";

const methods = [
  "cron.add",
  "cron.list",
  "cron.get",
  "cron.update",
  "cron.remove",
  "cron.runs",
] as const;
type Method = (typeof methods)[number];
type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];
export type AutomationGatewayErrorCode =
  "unavailable" | "invalid" | "missing" | "conflict" | "unsupported" | "unknown";
export class AutomationGatewayError extends Error {
  readonly code: AutomationGatewayErrorCode;
  constructor(code: AutomationGatewayErrorCode) {
    super(`Automation Gateway operation: ${code}`);
    this.name = "AutomationGatewayError";
    this.code = code;
  }
}
/** Only the transport can establish that a create did not commit. */
export class AutomationCreateNotCommittedError extends Error {
  constructor(cause: unknown) {
    super("The native automation create did not commit.", { cause });
    this.name = "AutomationCreateNotCommittedError";
  }
}
type OwnedAutomation = Pick<AgentAutomationOwnership, "id" | "nativeAgentId" | "nativeJobId">;
export type BoundAutomation = OwnedAutomation & { readonly nativeJobId: string };
export interface NativeAutomationInventoryEntry {
  readonly id: string;
  readonly nativeJobId: string;
  readonly summary: AgentAutomationSummary;
}
export interface AgentAutomationGatewaySession {
  readonly nativeAgentId: string;
  /** Always creates disabled; OCC must persist the native identity before activation. */
  create(
    id: string,
    input: AgentAutomationCreateInput,
  ): Promise<{ nativeJobId: string; job: AgentAutomationData }>;
  list(
    owned: readonly OwnedAutomation[],
  ): Promise<{ entries: NativeAutomationInventoryEntry[]; snapshotRevision: string }>;
  resolve(record: OwnedAutomation): Promise<string>;
  get(record: BoundAutomation): Promise<AgentAutomationData>;
  update(record: BoundAutomation, input: AgentAutomationUpdateInput): Promise<AgentAutomationData>;
  remove(
    record: BoundAutomation,
    expectedConfigRevision: string,
    allowUnsupported: boolean,
  ): Promise<void>;
  runs(record: BoundAutomation, offset: number, limit: number): Promise<AgentAutomationRunsPage>;
  close(): Promise<void>;
}
export interface AgentAutomationsAccess {
  open(input: {
    revision: Readonly<AgentRevision>;
    signal: AbortSignal;
    deadline: Date;
    assertCurrent: () => Promise<void>;
  }): Promise<AgentAutomationGatewaySession>;
}

/** Native protocol belongs to the Gateway adapter; the controller retains human ownership. */
export function createNativeAgentAutomationsAccess(
  resolveTarget: (
    revision: Readonly<AgentRevision>,
  ) => Promise<{ url: string; apiKey: string } | undefined>,
): AgentAutomationsAccess {
  return {
    async open({ revision, signal, deadline, assertCurrent }) {
      const target = await resolveTarget(revision).catch(() => undefined);
      if (!target) {
        throw new AutomationGatewayError("unavailable");
      }
      try {
        const url = new URL(target.url);
        if (
          url.protocol !== "wss:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !target.apiKey
        ) {
          throw new AutomationGatewayError("unavailable");
        }
      } catch {
        throw new AutomationGatewayError("unavailable");
      }
      let resolveHello!: (value: GatewayHello) => void;
      let rejectHello!: (error: Error) => void;
      const connected = new Promise<GatewayHello>((resolve, reject) => {
        resolveHello = resolve;
        rejectHello = reject;
      });
      void connected.catch(() => {});
      let closed = false;
      const client = new GatewayClient({
        url: target.url,
        clientName: "gateway-client",
        mode: "backend",
        role: "operator",
        deviceIdentity: null,
        scopes: [],
        edgeAuthHeaders: { "x-api-key": target.apiKey },
        hostDeps: { logError: () => {}, logDebug: () => {} },
        onHelloOk: resolveHello,
        onConnectError: () => {
          closed = true;
          rejectHello(new AutomationGatewayError("unavailable"));
          client.stop();
        },
        onClose: () => {
          closed = true;
          rejectHello(new AutomationGatewayError("unavailable"));
          client.stop();
        },
      });
      const stop = () => {
        closed = true;
        rejectHello(new AutomationGatewayError("unavailable"));
        client.stop();
      };
      const timer = setTimeout(stop, Math.max(1, deadline.getTime() - Date.now()));
      timer.unref();
      signal.addEventListener("abort", stop, { once: true });
      async function close() {
        closed = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        client.stop();
        await client.stopAndWait({ timeoutMs: 1000 }).catch(() => undefined);
      }
      let hello: GatewayHello;
      try {
        if (signal.aborted || Date.now() >= deadline.getTime()) {
          throw new AutomationGatewayError("unavailable");
        }
        client.start();
        hello = await connected;
        const defaults = hello.snapshot.sessionDefaults;
        if (
          hello.auth?.role !== "operator" ||
          !hello.auth.scopes.includes("operator.admin") ||
          !methods.every((method) => hello.features.methods.includes(method)) ||
          defaults?.ownership !== "sole" ||
          defaults.selectionRequired !== false ||
          typeof defaults.defaultAgentId !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(defaults.defaultAgentId)
        ) {
          throw new AutomationGatewayError("unavailable");
        }
      } catch (error) {
        await close();
        throw error instanceof AutomationGatewayError
          ? error
          : new AutomationGatewayError("unavailable");
      }
      const nativeAgentId = hello.snapshot.sessionDefaults!.defaultAgentId!;
      async function request(
        method: Method,
        params: Record<string, unknown>,
        mutation = false,
        onSent?: () => void,
      ): Promise<unknown> {
        if (closed || signal.aborted || Date.now() >= deadline.getTime()) {
          throw new AutomationGatewayError("unavailable");
        }
        await assertCurrent();
        let sent = false;
        try {
          return await client.request(method, params, {
            signal,
            timeoutMs: Math.max(1, deadline.getTime() - Date.now()),
            onSent: () => {
              sent = true;
              onSent?.();
            },
          });
        } catch (error) {
          if (error instanceof GatewayClientRequestError) {
            const details = asRecord(error.details);
            if (details?.code === "CRON_JOB_CHANGED") {
              throw new AutomationGatewayError("conflict");
            }
            if (details?.code === "CRON_JOB_NOT_FOUND") {
              throw new AutomationGatewayError("missing");
            }
            if ((error.gatewayCode || error.code) === "INVALID_REQUEST") {
              throw new AutomationGatewayError("invalid");
            }
          }
          if (
            mutation &&
            (sent || (error instanceof GatewayClientRequestTimeoutError && error.requestSent))
          ) {
            throw new AutomationGatewayError("unknown");
          }
          throw new AutomationGatewayError("unavailable");
        }
      }
      const declarationPrefix = "occ-automation:";
      function inspect(value: unknown, record: BoundAutomation) {
        const job = asRecord(value);
        const schedule = asRecord(job?.schedule);
        const state = asRecord(job?.state);
        const payload = asRecord(job?.payload);
        const delivery = asRecord(job?.delivery);
        if (
          !job ||
          job.id !== record.nativeJobId ||
          job.declarationKey !== declarationPrefix + record.id ||
          (job.agentId ?? nativeAgentId) !== record.nativeAgentId
        ) {
          throw new AutomationGatewayError("unavailable");
        }
        const data = {
          id: record.id,
          configRevision: job.configRevision,
          name: job.name,
          enabled: job.enabled,
          schedule: job.schedule,
          prompt: payload?.message,
          nextRunAtMs: job.nextRunAtMs ?? state?.nextRunAtMs ?? null,
          lastRunStatus: job.lastRunStatus ?? state?.lastRunStatus ?? state?.lastStatus ?? null,
        };
        const supported =
          job.sessionTarget === "isolated" &&
          job.wakeMode === "now" &&
          payload?.kind === "agentTurn" &&
          delivery?.mode === "none" &&
          Check(AgentAutomationSchema, data);
        const summary = {
          id: record.id,
          configRevision: job.configRevision,
          name: job.name,
          enabled: job.enabled,
          scheduleKind: schedule?.kind,
        };
        if (!Check(AgentAutomationUnsupportedSummary, summary)) {
          throw new AutomationGatewayError("unavailable");
        }
        return { data: supported ? (data as AgentAutomationData) : undefined, summary };
      }
      async function read(record: BoundAutomation) {
        return inspect(await request("cron.get", { id: record.nativeJobId }), record);
      }
      function requireSupported(found: ReturnType<typeof inspect>): AgentAutomationData {
        if (!found.data) {
          throw new AutomationGatewayError("unsupported");
        }
        return found.data;
      }
      function acknowledgement(value: unknown, record: BoundAutomation): AgentAutomationData {
        try {
          return requireSupported(inspect(value, record));
        } catch {
          throw new AutomationGatewayError("unknown");
        }
      }
      async function inventory(owned: readonly OwnedAutomation[]) {
        const byKey = new Map(owned.map((record) => [declarationPrefix + record.id, record]));
        const entries: NativeAutomationInventoryEntry[] = [];
        const seen = new Set<string>();
        let offset = 0;
        let snapshotRevision: string | undefined;
        for (;;) {
          const page = asRecord(
            await request("cron.list", {
              includeDisabled: true,
              includeDeliveryPreviews: false,
              limit: 200,
              offset,
            }),
          );
          if (
            !page ||
            !Array.isArray(page.jobs) ||
            typeof page.snapshotRevision !== "string" ||
            !page.snapshotRevision
          ) {
            throw new AutomationGatewayError("unavailable");
          }
          if (snapshotRevision !== undefined && snapshotRevision !== page.snapshotRevision) {
            throw new AutomationGatewayError("conflict");
          }
          snapshotRevision = page.snapshotRevision;
          for (const value of page.jobs) {
            const job = asRecord(value);
            const record =
              typeof job?.declarationKey === "string" ? byKey.get(job.declarationKey) : undefined;
            if (!record) {
              continue;
            }
            if (
              typeof job?.id !== "string" ||
              !job.id ||
              seen.has(record.id) ||
              (record.nativeJobId !== null && record.nativeJobId !== job.id)
            ) {
              throw new AutomationGatewayError("unavailable");
            }
            seen.add(record.id);
            const found = inspect(value, { ...record, nativeJobId: job.id });
            let summary: AgentAutomationSummary = found.summary;
            if (found.data) {
              const { prompt: _prompt, ...projection } = found.data;
              summary = projection;
            }
            entries.push({ id: record.id, nativeJobId: job.id, summary });
          }
          if (page.hasMore === false) {
            return { entries, snapshotRevision };
          }
          if (
            page.hasMore !== true ||
            !Number.isSafeInteger(page.nextOffset) ||
            (page.nextOffset as number) <= offset
          ) {
            throw new AutomationGatewayError("unavailable");
          }
          offset = page.nextOffset as number;
        }
      }
      return {
        nativeAgentId,
        close,
        list: inventory,
        async resolve(record) {
          if (record.nativeJobId !== null) {
            return record.nativeJobId;
          }
          const { entries } = await inventory([record]);
          if (entries.length !== 1) {
            throw new AutomationGatewayError("missing");
          }
          return entries[0]!.nativeJobId;
        },
        async create(id, input) {
          let sent = false;
          let response: unknown;
          try {
            response = await request(
              "cron.add",
              {
                declarationKey: declarationPrefix + id,
                agentId: nativeAgentId,
                name: input.name,
                enabled: false,
                schedule: input.schedule,
                sessionTarget: "isolated",
                wakeMode: "now",
                payload: { kind: "agentTurn", message: input.prompt, toolsAllow: ["*"] },
                delivery: { mode: "none" },
              },
              true,
              () => {
                sent = true;
              },
            );
          } catch (error) {
            let rejectedWithoutJob = false;
            if (error instanceof AutomationGatewayError && error.code === "invalid") {
              // A generic INVALID_REQUEST can also wrap a late native error. Confirm
              // the disabled job is absent before discarding its recovery identity.
              try {
                rejectedWithoutJob =
                  (await inventory([{ id, nativeAgentId, nativeJobId: null }])).entries.length ===
                  0;
              } catch {
                throw new AutomationGatewayError("unknown");
              }
              if (!rejectedWithoutJob) {
                throw new AutomationGatewayError("unknown");
              }
            }
            if (
              rejectedWithoutJob ||
              (!sent && !(error instanceof AutomationGatewayError && error.code === "unknown"))
            ) {
              throw new AutomationCreateNotCommittedError(error);
            }
            throw error;
          }
          const result = asRecord(response);
          const native = asRecord(result?.job);
          if (result?.created !== true || typeof native?.id !== "string" || !native.id) {
            throw new AutomationGatewayError("unknown");
          }
          const job = acknowledgement(native, { id, nativeAgentId, nativeJobId: native.id });
          if (job.enabled) {
            throw new AutomationGatewayError("unknown");
          }
          return { nativeJobId: native.id, job };
        },
        async get(record) {
          return requireSupported(await read(record));
        },
        async update(record, input) {
          const current = requireSupported(await read(record));
          if (current.configRevision !== input.expectedConfigRevision) {
            throw new AutomationGatewayError("conflict");
          }
          const patch = {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
            ...(input.prompt === undefined
              ? {}
              : { payload: { kind: "agentTurn", message: input.prompt } }),
          };
          return acknowledgement(
            await request(
              "cron.update",
              { id: record.nativeJobId, patch, expectedConfigRevision: current.configRevision },
              true,
            ),
            record,
          );
        },
        async remove(record, expectedConfigRevision, allowUnsupported) {
          const current = await read(record);
          if (!allowUnsupported) {
            requireSupported(current);
          }
          if (current.summary.configRevision !== expectedConfigRevision) {
            throw new AutomationGatewayError("conflict");
          }
          const result = asRecord(
            await request("cron.remove", { id: record.nativeJobId, expectedConfigRevision }, true),
          );
          if (result?.removed !== true) {
            throw new AutomationGatewayError("unknown");
          }
        },
        async runs(record, offset, limit) {
          // The durable OCC binding authorizes this ID after native one-shot deletion too.
          const page = asRecord(
            await request("cron.runs", { id: record.nativeJobId, offset, limit }),
          );
          if (!page || !Array.isArray(page.entries)) {
            throw new AutomationGatewayError("unavailable");
          }
          const runs = page.entries.map((value) => {
            const entry = asRecord(value);
            if (!entry || entry.jobId !== record.nativeJobId) {
              throw new AutomationGatewayError("unavailable");
            }
            return {
              runId: entry.runId,
              startedAtMs: entry.runAtMs ?? null,
              finishedAtMs: entry.ts ?? null,
              status: entry.status ?? null,
              completionStatus: entry.completionStatus ?? null,
              deliveryStatus: entry.deliveryStatus ?? null,
              ...(typeof entry.summary === "string" ? { summary: entry.summary } : {}),
              ...(typeof entry.error === "string" ? { error: entry.error } : {}),
            };
          });
          const result = { runs, total: page.total, nextOffset: page.nextOffset };
          if (!Check(AgentAutomationRunsPageSchema, result)) {
            throw new AutomationGatewayError("unavailable");
          }
          return result;
        },
      };
    },
  };
}
