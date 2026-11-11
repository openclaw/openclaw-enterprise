import { once } from "node:events";
import { write } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { ActivationFailedError } from "../../packages/occ/src/errors.ts";
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
  "rpc-error",
  "protocol-error",
  "server-error",
  "invalid-response",
  "unexpected-request",
  "oversized",
];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function validApprovalPolicy(value: unknown) {
  if (typeof value === "string") {
    return ["untrusted", "on-request", "never"].includes(value);
  }
  const policy = record(value);
  const granular = record(policy?.granular);
  return (
    policy !== undefined &&
    Object.keys(policy).length === 1 &&
    granular !== undefined &&
    ["mcp_elicitations", "rules", "sandbox_approval"].every(
      (key) => typeof granular[key] === "boolean",
    ) &&
    ["request_permissions", "skill_approval"].every(
      (key) => granular[key] === undefined || typeof granular[key] === "boolean",
    )
  );
}

function requirementsSummary(value: unknown) {
  if (value === null) {
    return {
      present: false,
      modeAllowed: null,
      profileAllowed: null,
      reviewerAllowed: null,
      approvalAllowed: null,
    };
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
    (policy.allowedApprovalPolicies != null &&
      (!Array.isArray(policy.allowedApprovalPolicies) ||
        !policy.allowedApprovalPolicies.every(validApprovalPolicy))) ||
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
    approvalAllowed: Array.isArray(policy.allowedApprovalPolicies)
      ? policy.allowedApprovalPolicies.includes("on-request")
      : null,
  };
}

interface DiagnosticOptions {
  readonly endpoint: string;
  readonly revisionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly attempted: Set<string>;
  readonly serviceUrl: () => string | undefined;
  readonly bearer: string;
  readonly signal: AbortSignal;
  readonly requirePat: boolean;
  readonly rootCertificate?: Buffer;
  readonly write?: (receipt: unknown) => void | Promise<void>;
}

async function diagnose(options: DiagnosticOptions) {
  const receipt: Record<string, unknown> = {
    revisionId: options.revisionId,
    outcome: "unavailable",
    phase: "connect",
    cleanup: "not-opened",
  };
  if (options.signal.aborted) {
    return { ...receipt, outcome: "cancelled" };
  }
  const serviceUrl = options.serviceUrl();
  if (serviceUrl === undefined) {
    return receipt;
  }
  const target = serviceTarget(
    { endpoint: options.endpoint, requestTimeoutMs: 10_000 },
    serviceUrl,
  );
  const hostname = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
  const socket = new WebSocket(`${target.secure ? "wss" : "ws"}://${hostname}:${target.port}/`, {
    headers: { host: target.host, authorization: `Bearer ${options.bearer}` },
    ca: options.rootCertificate,
    servername: isIP(target.hostname) ? "" : target.hostname,
    checkServerIdentity: (_name: string, certificate: Parameters<typeof checkServerIdentity>[1]) =>
      checkServerIdentity(target.hostname, certificate),
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  const abort = new AbortController();
  const cancel = () => abort.abort("cancelled");
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) {
    cancel();
  }
  const deadline = setTimeout(() => abort.abort("timeout"), 10_000);
  let observing = true;
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
  socket.on("error", (error: unknown) => {
    if (observing) {
      abort.abort(
        record(error)?.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? "oversized" : "unavailable",
      );
    }
  });
  socket.on("close", () => {
    if (observing) {
      abort.abort("unavailable");
    }
  });
  socket.on("message", (data: Buffer, binary: boolean) => {
    if (!observing) {
      return;
    }
    bytes += data.length;
    if (bytes > 1024 * 1024 + 64 * 1024) {
      abort.abort("oversized");
      return;
    }
    try {
      const message = binary ? undefined : record(JSON.parse(data.toString()));
      if (!message) {
        throw new Error("invalid-response");
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          abort.abort("unexpected-request");
        }
        return;
      }
      if (
        !pending ||
        message.id !== pending.id ||
        Object.hasOwn(message, "error") === Object.hasOwn(message, "result")
      ) {
        throw new Error("invalid-response");
      }
      if (Object.hasOwn(message, "error")) {
        const error = record(message.error);
        if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") {
          throw new Error("invalid-response");
        }
        // These are protocol categories, not evidence that a policy denied the profile.
        if ([-32700, -32600, -32601, -32602].includes(error.code as number)) {
          abort.abort("protocol-error");
        } else {
          abort.abort(error.code === -32603 ? "server-error" : "rpc-error");
        }
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
  const request = async (method: string, params: unknown) => {
    receipt.phase = method;
    abort.signal.throwIfAborted();
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      pending = { id: ++id, resolve, reject };
      socket.send(JSON.stringify({ id, method, params }));
    });
    // A peer request or cancellation can arrive in the same batch as the final reply.
    abort.signal.throwIfAborted();
    return result;
  };
  try {
    await once(socket, "open", { signal: abort.signal });
    const initialized = await request("initialize", {
      clientInfo: { name: "codex_app_server_daemon", version: "1" },
      capabilities: { experimentalApi: true },
    });
    if (
      !["userAgent", "codexHome", "platformFamily", "platformOs"].every(
        (key) => typeof initialized[key] === "string",
      )
    ) {
      throw new Error("invalid-response");
    }
    abort.signal.throwIfAborted();
    socket.send(JSON.stringify({ method: "initialized" }));
    receipt.requirements = requirementsSummary(
      (await request("configRequirements/read", null)).requirements,
    );
    const auth = await request("getAuthStatus", { includeToken: false, refreshToken: false });
    receipt.authenticatedPat =
      auth.authMethod === "personalAccessToken" &&
      auth.authToken === null &&
      auth.requiresOpenaiAuth === true;
    if (receipt.authenticatedPat !== true) {
      throw new Error("invalid-response");
    }
    // One connection compares the requirements and the grant; it never starts a turn.
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
    const thread = record(granted.thread);
    const profile = record(granted.activePermissionProfile);
    if (
      typeof sandbox !== "string" ||
      !sandboxes.includes(sandbox) ||
      typeof reviewer !== "string" ||
      !reviewers.includes(reviewer) ||
      !validApprovalPolicy(granted.approvalPolicy) ||
      !["cwd", "model", "modelProvider"].every((key) => typeof granted[key] === "string") ||
      typeof thread?.id !== "string" ||
      typeof thread.ephemeral !== "boolean" ||
      (granted.activePermissionProfile != null && typeof profile?.id !== "string")
    ) {
      throw new Error("invalid-response");
    }
    const grant = {
      sandbox,
      reviewer,
      onRequestApproval: granted.approvalPolicy === "on-request",
      requestedProfile: profile === undefined ? null : profile.id === ":danger-full-access",
      ephemeral: thread.ephemeral,
    };
    receipt.grant = grant;
    abort.signal.throwIfAborted();
    if (
      sandbox !== "dangerFullAccess" ||
      reviewer !== "user" ||
      !grant.onRequestApproval ||
      !grant.ephemeral ||
      grant.requestedProfile === false
    ) {
      receipt.outcome = "mismatch";
    } else {
      receipt.outcome = grant.requestedProfile === null ? "unconfirmed" : "accepted";
    }
  } catch (error) {
    let code: unknown = abort.signal.reason;
    if (!abort.signal.aborted && error instanceof Error) {
      code = error.message;
    }
    receipt.outcome =
      typeof code === "string" && failures.includes(code) ? code : "invalid-response";
  } finally {
    // Later close-handshake events are cleanup, not part of the observed RPC exchange.
    observing = false;
    clearTimeout(deadline);
    options.signal.removeEventListener("abort", cancel);
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

// Write through fs so asynchronous pipe errors belong to this callback, not stderr's
// process-wide EventEmitter. The caller bounds waiting and consumes late rejections.
const writeReceipt = (receipt: unknown) =>
  new Promise<void>((resolve, reject) => {
    write(2, `OpenShell native permission diagnostic: ${JSON.stringify(receipt)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });

/** Collect only after the real Driver classified the refusal; preserve that exact failure. */
export async function observeOpenShellPermissionRefusal<T>(
  observe: () => Promise<T>,
  options: DiagnosticOptions,
): Promise<T> {
  try {
    return await observe();
  } catch (error) {
    if (
      error instanceof ActivationFailedError &&
      error.code === "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE" &&
      options.requirePat &&
      !options.attempted.has(options.revisionId)
    ) {
      options.attempted.add(options.revisionId);
      let outputTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const receipt = await diagnose(options);
        await Promise.race([
          (options.write ?? writeReceipt)(receipt),
          new Promise<void>((resolve) => {
            outputTimer = setTimeout(resolve, 1_000);
          }),
        ]);
      } catch {
        // Collection and output must not replace the original classified refusal.
      } finally {
        clearTimeout(outputTimer);
      }
    }
    throw error;
  }
}
