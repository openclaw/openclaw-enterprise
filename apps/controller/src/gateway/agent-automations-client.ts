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
  type AgentAutomationToolGrant,
  type AgentAutomationPolicyQualification,
  type AgentAutomationTransport,
  type AgentAutomationCreateInput,
  type AgentAutomationUpdateInput,
  type AgentAutomationData,
  type AgentAutomationSummary,
  type AgentAutomationRunsPage,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import { Check } from "typebox/value";
import { AUTOMATION_NO_MCP_PLUGIN_IDS } from "../drivers/compute/agent-automations-policy.ts";

const methods = [
  "cron.add",
  "cron.list",
  "cron.get",
  "cron.update",
  "cron.remove",
  "cron.runs",
] as const;
type Method =
  | (typeof methods)[number]
  | "sessions.list"
  | "tools.catalog"
  | "tools.effective"
  | "plugins.inspect"
  | "system.info";
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
type OwnedAutomation = Pick<
  AgentAutomationOwnership,
  "id" | "nativeAgentId" | "nativeJobId" | "toolGrant"
>;
export type BoundAutomation = OwnedAutomation & { readonly nativeJobId: string };
export interface NativeAutomationInventoryEntry {
  readonly id: string;
  readonly nativeJobId: string;
  readonly summary: AgentAutomationSummary;
}
export interface AgentAutomationGatewaySession {
  readonly nativeAgentId: string;
  captureToolGrant(): Promise<AgentAutomationToolGrant>;
  /** Always creates disabled; OCC must persist the native identity before activation. */
  create(
    id: string,
    input: AgentAutomationCreateInput,
    grant: AgentAutomationToolGrant,
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
  resolveTarget: (revision: Readonly<AgentRevision>) => Promise<
    | {
        transport: AgentAutomationTransport;
        apiKey: string;
        policy: AgentAutomationPolicyQualification | undefined;
      }
    | undefined
  >,
): AgentAutomationsAccess {
  return {
    async open({ revision, signal, deadline, assertCurrent }) {
      const target = await resolveTarget(revision).catch(() => undefined);
      if (!target) {
        throw new AutomationGatewayError("unavailable");
      }
      const transport = target.transport;
      try {
        const url = new URL(transport.url);
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
        url: transport.url,
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
        await transport.close().catch(() => undefined);
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
          !hello.features.methods.includes("system.info") ||
          typeof hello.server?.bootId !== "string" ||
          hello.server.bootId.length === 0 ||
          hello.server.bootId.length > 128 ||
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
      let processIdentity:
        { bootId: string; processInstanceId: string; hostname: string; pid: number } | undefined;
      async function request(
        method: Method,
        params: Record<string, unknown>,
        mutation = false,
        onSent?: () => void,
      ): Promise<unknown> {
        if (
          closed ||
          signal.aborted ||
          Date.now() >= deadline.getTime() ||
          (mutation && (!processIdentity || processIdentity.bootId !== hello.server.bootId))
        ) {
          throw new AutomationGatewayError("unavailable");
        }
        let transportCurrent = false;
        try {
          transportCurrent = await transport.assertCurrent();
        } catch {
          // A failed observation invalidates this connection, even if a later read could succeed.
        }
        if (!transportCurrent) {
          await close();
          throw new AutomationGatewayError("unavailable");
        }
        try {
          await assertCurrent();
        } catch (error) {
          await close();
          throw error;
        }
        if (
          closed ||
          signal.aborted ||
          Date.now() >= deadline.getTime() ||
          (mutation && (!processIdentity || processIdentity.bootId !== hello.server.bootId))
        ) {
          throw new AutomationGatewayError("unavailable");
        }
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
      try {
        const info = asRecord(await request("system.info", {}));
        if (
          info?.hostname !== transport.expectedHostname ||
          typeof info.processInstanceId !== "string" ||
          info.processInstanceId.length === 0 ||
          info.processInstanceId.length > 128 ||
          !Number.isSafeInteger(info.pid) ||
          (info.pid as number) <= 0 ||
          !(await transport.assertCurrent())
        ) {
          throw new AutomationGatewayError("unavailable");
        }
        processIdentity = {
          bootId: hello.server.bootId,
          processInstanceId: info.processInstanceId,
          hostname: info.hostname as string,
          pid: info.pid as number,
        };
      } catch {
        await close();
        throw new AutomationGatewayError("unavailable");
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
          job.trigger === undefined &&
          payload?.kind === "agentTurn" &&
          Array.isArray(payload.toolsAllow) &&
          JSON.stringify(payload.toolsAllow) ===
            JSON.stringify(record.toolGrant.tools.map(({ name }) => name)) &&
          (payload.toolsAllowIsDefault === undefined || payload.toolsAllowIsDefault === false) &&
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
      const session: AgentAutomationGatewaySession = {
        nativeAgentId,
        close,
        async captureToolGrant() {
          const policy = target.policy;
          if (!policy) {
            throw new AutomationGatewayError("unavailable");
          }
          if (policy.bindings.length === 0) {
            return policy.grant;
          }
          if (
            !hello.features.methods.includes("sessions.list") ||
            !hello.features.methods.includes("tools.catalog") ||
            !hello.features.methods.includes("tools.effective") ||
            !hello.features.methods.includes("plugins.inspect")
          ) {
            throw new AutomationGatewayError("unavailable");
          }
          const plugins = asRecord(revision.configuration.plugins);
          const slots = asRecord(plugins?.slots);
          const pluginIds = new Set<string>(Array.isArray(plugins?.allow) ? plugins.allow : []);
          if (slots?.memory !== "none") {
            pluginIds.add("memory-core");
          }
          if (revision.harness.mode === "dedicated") {
            pluginIds.add("file-transfer");
          }
          const trustedOwners = new Set<string>(AUTOMATION_NO_MCP_PLUGIN_IDS);
          for (const pluginId of pluginIds) {
            if (!trustedOwners.has(pluginId)) {
              throw new AutomationGatewayError("unavailable");
            }
            const inspected = asRecord(await request("plugins.inspect", { pluginId }));
            const plugin = asRecord(inspected?.plugin);
            const source = asRecord(inspected?.source);
            const declared = asRecord(inspected?.declared);
            const components = asRecord(inspected?.components);
            const unavailable = asRecord(components?.unavailable);
            if (
              inspected?.ok !== true ||
              plugin?.id !== pluginId ||
              plugin.installed !== true ||
              plugin.enabled !== true ||
              plugin.origin !== "bundled" ||
              source?.kind !== "bundled" ||
              !Array.isArray(declared?.mcpServers) ||
              declared.mcpServers.length !== 0 ||
              !Array.isArray(components?.mcpServers) ||
              components.mcpServers.length !== 0 ||
              !Array.isArray(unavailable?.mcpServers) ||
              unavailable.mcpServers.length !== 0 ||
              inspected.declaredSurfaceStatus === "partial" ||
              inspected.declaredSurfaceStatus === "unavailable"
            ) {
              throw new AutomationGatewayError("unavailable");
            }
          }
          // This catalog has no ordinary-session overrides. A session preview
          // cannot prove absence of a conflicting core or plugin tool.
          const catalog = asRecord(
            await request("tools.catalog", { agentId: nativeAgentId, includePlugins: true }),
          );
          if (catalog?.agentId !== nativeAgentId || !Array.isArray(catalog.groups)) {
            throw new AutomationGatewayError("unavailable");
          }
          const aliases = new Set(policy.bindings.map(({ name }) => name.toLowerCase()));
          for (const value of catalog.groups) {
            const group = asRecord(value);
            if (
              !group ||
              !["core", "plugin"].includes(String(group.source)) ||
              !Array.isArray(group.tools) ||
              (group.source === "plugin" &&
                (typeof group.pluginId !== "string" || !trustedOwners.has(group.pluginId)))
            ) {
              throw new AutomationGatewayError("unavailable");
            }
            for (const item of group.tools) {
              const tool = asRecord(item);
              if (
                !tool ||
                typeof tool.id !== "string" ||
                !tool.id ||
                tool.source !== group.source ||
                (group.source === "plugin" && tool.pluginId !== group.pluginId) ||
                aliases.has(tool.id.toLowerCase())
              ) {
                throw new AutomationGatewayError("unavailable");
              }
            }
          }
          const rows = asRecord(
            await request("sessions.list", {
              agentId: nativeAgentId,
              limit: 100,
              excludeCron: true,
              excludeSystem: true,
              rowMode: "compact",
            }),
          );
          if (!Array.isArray(rows?.sessions)) {
            throw new AutomationGatewayError("unavailable");
          }
          for (const value of rows.sessions.slice(0, 20)) {
            const row = asRecord(value);
            if (row?.agentId !== nativeAgentId || typeof row.key !== "string" || !row.key) {
              continue;
            }
            let inventory: Record<string, unknown> | undefined;
            try {
              inventory = asRecord(
                await request("tools.effective", { agentId: nativeAgentId, sessionKey: row.key }),
              );
            } catch {
              if (closed || signal.aborted || Date.now() >= deadline.getTime()) {
                throw new AutomationGatewayError("unavailable");
              }
              continue;
            }
            if (inventory?.agentId !== nativeAgentId || !Array.isArray(inventory.groups)) {
              continue;
            }
            const entries = inventory.groups
              .flatMap((group) => {
                const item = asRecord(group);
                return item?.source === "mcp" && Array.isArray(item.tools) ? item.tools : [];
              })
              .map(asRecord)
              .filter((entry) => entry !== undefined);
            const valid = policy.bindings.every((binding) => {
              const matches = entries.filter((entry) => entry?.id === binding.name);
              return (
                matches.length === 1 &&
                matches[0]?.source === "mcp" &&
                matches[0]?.mcpServer === binding.server &&
                matches[0]?.mcpToolName === binding.tool &&
                matches[0]?.deniedBySession !== true
              );
            });
            if (valid) {
              return policy.grant;
            }
          }
          throw new AutomationGatewayError("unavailable");
        },
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
        async create(id, input, grant) {
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
                payload: {
                  kind: "agentTurn",
                  message: input.prompt,
                  toolsAllow: grant.tools.map(({ name }) => name),
                },
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
                  (await inventory([{ id, nativeAgentId, nativeJobId: null, toolGrant: grant }]))
                    .entries.length === 0;
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
          const job = acknowledgement(native, {
            id,
            nativeAgentId,
            nativeJobId: native.id,
            toolGrant: grant,
          });
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
          const disableOnly =
            input.enabled === false &&
            input.name === undefined &&
            input.prompt === undefined &&
            input.schedule === undefined;
          const qualified = target.policy?.grant.tools;
          const grantStillApproved =
            qualified !== undefined &&
            record.toolGrant.tools.every((captured) =>
              qualified.some(
                (candidate) =>
                  candidate.name === captured.name && candidate.binding === captured.binding,
              ),
            );
          if (!disableOnly && !grantStillApproved) {
            throw new AutomationGatewayError("unavailable");
          }
          if (!disableOnly && record.toolGrant.tools.length > 0) {
            const live = await session.captureToolGrant();
            if (
              !record.toolGrant.tools.every((captured) =>
                live.tools.some(
                  (candidate) =>
                    candidate.name === captured.name && candidate.binding === captured.binding,
                ),
              )
            ) {
              throw new AutomationGatewayError("unavailable");
            }
          }
          const patch = {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
            // Reassert the immutable admitted cap on every update.
            payload: {
              kind: "agentTurn",
              message: input.prompt ?? current.prompt,
              toolsAllow: record.toolGrant.tools.map(({ name }) => name),
            },
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
      return session;
    },
  };
}
