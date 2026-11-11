import { once } from "node:events";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { OpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { serviceTarget } from "../../apps/controller/src/drivers/sandbox/openshell-service-transport.ts";

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const { WebSocket } = createRequire(controllerRequire.resolve("@kubernetes/client-node"))("ws");
const reviewers = ["user", "auto_review", "guardian_subagent"];
const modes = ["read-only", "workspace-write", "danger-full-access"];
const sandboxes = ["dangerFullAccess", "readOnly", "workspaceWrite", "externalSandbox"];
const failures = [
  "timeout",
  "cancelled",
  "unavailable",
  "rpc-refused",
  "invalid-response",
  "unexpected-request",
  "oversized",
];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function requirementsSummary(value: unknown) {
  if (value === null) {
    return { present: false, modeAllowed: null, profileAllowed: null, reviewerAllowed: null };
  }
  const policy = record(value);
  const validList = (list: unknown, allowed: string[]) =>
    list == null ||
    (Array.isArray(list) &&
      list.every((item) => typeof item === "string" && allowed.includes(item)));
  const profiles = record(policy?.allowedPermissionProfiles);
  if (
    !policy ||
    !validList(policy.allowedSandboxModes, modes) ||
    !validList(policy.allowedApprovalsReviewers, reviewers) ||
    (policy.allowedPermissionProfiles != null &&
      (!profiles || Object.values(profiles).some((item) => typeof item !== "boolean")))
  ) {
    throw new Error("invalid-response");
  }
  return {
    present: true,
    modeAllowed: Array.isArray(policy.allowedSandboxModes)
      ? policy.allowedSandboxModes.includes("danger-full-access")
      : null,
    profileAllowed: profiles ? profiles[":danger-full-access"] === true : null,
    reviewerAllowed: Array.isArray(policy.allowedApprovalsReviewers)
      ? policy.allowedApprovalsReviewers.includes("user")
      : null,
  };
}

interface DiagnosticOptions {
  readonly endpoint: string;
  readonly revisionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly attempted: Set<string>;
  readonly rootCertificate?: Buffer;
  readonly write?: (receipt: unknown) => void;
}

async function diagnose(
  options: DiagnosticOptions,
  serviceUrl: string,
  bearer: string,
  signal: AbortSignal,
) {
  const receipt: Record<string, unknown> = {
    revisionId: options.revisionId,
    outcome: "unavailable",
    phase: "connect",
    cleanup: "not-opened",
  };
  if (signal.aborted) {
    return { ...receipt, outcome: "cancelled" };
  }
  const target = serviceTarget(
    { endpoint: options.endpoint, requestTimeoutMs: 10_000 },
    serviceUrl,
  );
  const hostname = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
  const socket = new WebSocket(`${target.secure ? "wss" : "ws"}://${hostname}:${target.port}/`, {
    headers: { host: target.host, authorization: `Bearer ${bearer}` },
    ca: options.rootCertificate,
    servername: isIP(target.hostname) ? "" : target.hostname,
    checkServerIdentity: (_name: string, certificate: Parameters<typeof checkServerIdentity>[1]) =>
      checkServerIdentity(target.hostname, certificate),
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  const abort = new AbortController();
  const cancel = () => abort.abort("cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  const deadline = setTimeout(() => abort.abort("timeout"), 10_000);
  let bytes = 0;
  let id = 0;
  let pending:
    | {
        id: number;
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  const reject = () =>
    pending?.reject(
      new Error(
        failures.includes(String(abort.signal.reason))
          ? String(abort.signal.reason)
          : "unavailable",
      ),
    );
  abort.signal.addEventListener("abort", reject);
  socket.on("error", () => abort.abort("unavailable"));
  socket.on("close", () => abort.abort("unavailable"));
  socket.on("message", (data: Buffer) => {
    bytes += data.length;
    if (bytes > 1024 * 1024 + 64 * 1024) {
      abort.abort("oversized");
      return;
    }
    try {
      const message = record(JSON.parse(data.toString()));
      if (!message) {
        throw new Error("invalid-response");
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          abort.abort("unexpected-request");
        }
        return;
      }
      if (!pending || message.id !== pending.id) {
        throw new Error("invalid-response");
      }
      if (message.error !== undefined) {
        abort.abort("rpc-refused");
        return;
      }
      const result = record(message.result);
      if (!result) {
        throw new Error("invalid-response");
      }
      pending.resolve(result);
      pending = undefined;
    } catch {
      abort.abort("invalid-response");
    }
  });
  const request = (method: string, params: unknown) => {
    receipt.phase = method;
    abort.signal.throwIfAborted();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending = { id: ++id, resolve, reject };
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  try {
    await once(socket, "open", { signal: abort.signal });
    await request("initialize", {
      clientInfo: { name: "codex_app_server_daemon", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    receipt.requirements = requirementsSummary(
      (await request("configRequirements/read", {})).requirements,
    );
    const auth = await request("getAuthStatus", { includeToken: false, refreshToken: false });
    receipt.authenticatedPat =
      auth.authMethod === "personalAccessToken" &&
      auth.authToken === null &&
      auth.requiresOpenaiAuth === true;
    if (receipt.authenticatedPat !== true) {
      throw new Error("invalid-response");
    }
    // Read and grant use one live connection. Never send a turn or approve a peer request.
    const granted = await request("thread/start", {
      cwd: options.cwd,
      model: options.model,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissions: ":danger-full-access",
      ephemeral: true,
    });
    const sandbox = record(granted.sandbox)?.type;
    const reviewer = granted.approvalsReviewer;
    if (
      typeof sandbox !== "string" ||
      !sandboxes.includes(sandbox) ||
      typeof reviewer !== "string" ||
      !reviewers.includes(reviewer) ||
      typeof record(granted.thread)?.id !== "string"
    ) {
      throw new Error("invalid-response");
    }
    receipt.grant = {
      sandbox,
      reviewer,
      onRequestApproval: granted.approvalPolicy === "on-request",
      requestedProfile: record(granted.activePermissionProfile)?.id === ":danger-full-access",
    };
    receipt.outcome = "accepted";
  } catch (error) {
    let code: unknown = abort.signal.reason;
    if (!abort.signal.aborted && error instanceof Error) {
      code = error.message;
    }
    receipt.outcome =
      typeof code === "string" && failures.includes(code) ? code : "invalid-response";
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    abort.signal.removeEventListener("abort", reject);
    receipt.cleanup = await new Promise<string>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve("closed");
        return;
      }
      let forced = false;
      const finish = (outcome: string) => {
        clearTimeout(force);
        clearTimeout(limit);
        resolve(outcome);
      };
      socket.once("close", () => finish(forced ? "terminated" : "closed"));
      const force = setTimeout(() => {
        forced = true;
        socket.terminate();
      }, 1_000);
      const limit = setTimeout(() => finish("unconfirmed"), 2_000);
      socket.close(1000);
    });
  }
  return receipt;
}

/** Add evidence before the worker stops a refused candidate; never change readiness. */
export function withOpenShellPermissionDiagnostic<
  T extends Pick<OpenShellGatewayClient, "serviceCodexReadinessStatus">,
>(client: T, options: DiagnosticOptions): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === "serviceCodexReadinessStatus") {
        return async (
          serviceUrl: string,
          bearer: string,
          requirePat: boolean,
          signal: AbortSignal,
        ) => {
          const status = await target.serviceCodexReadinessStatus(
            serviceUrl,
            bearer,
            requirePat,
            signal,
          );
          if (
            requirePat &&
            typeof status === "object" &&
            status.state === "permission-refused" &&
            !options.attempted.has(options.revisionId)
          ) {
            options.attempted.add(options.revisionId);
            try {
              const receipt = await diagnose(options, serviceUrl, bearer, signal).catch(() => ({
                revisionId: options.revisionId,
                outcome: "unavailable",
                phase: "connect",
                cleanup: "unconfirmed",
              }));
              (
                options.write ??
                ((value) =>
                  process.stderr.write(
                    `OpenShell native permission diagnostic: ${JSON.stringify(value)}\n`,
                  ))
              )(receipt);
            } catch {
              // Diagnostics and their output must not replace the original permission refusal.
            }
          }
          return status;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
