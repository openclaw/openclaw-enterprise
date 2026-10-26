import { randomUUID } from "node:crypto";
import { Agent, request } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
  requireCurrentBinding,
} from "./manifest.ts";
import { readPrivateFile } from "./private-files.ts";
import { isGitHubPullUrl, isSameGitHubRepository } from "../../../credentials/client-contracts.ts";

const USAGE =
  "Usage: oce-github pr-create --draft --head <branch> --base <branch> --title <text> [--body <text>]";

/**
 * Why a draft create stopped, by what is known about GitHub's state. `usage` and `not-sent`
 * stop before any request; `not-created` means the request never reached GitHub or GitHub
 * refused it; anything else may have created a draft. Messages never carry credentials.
 */
export class DraftPullFailure extends Error {
  readonly stage: "usage" | "not-sent" | "not-created";
  constructor(stage: DraftPullFailure["stage"], message: string) {
    super(message);
    this.name = "DraftPullFailure";
    this.stage = stage;
  }
}

// GitHub and middleware text is shown to the Agent: printable, bounded, one line.
function printable(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return text === "" ? undefined : Array.from(text).slice(0, 300).join("");
}

// Connect-phase failures: no connection was established, so no request was sent.
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** What the Agent can do about each worker refusal (finding 2149); Git itself shows only 403. */
const ROUTE_REFUSALS: ReadonlyMap<string, string> = new Map([
  [
    "request_not_allowed",
    "This repository binding does not allow this create; do not retry it. Ask an operator if the branch or base should change.",
  ],
  [
    "access_withdrawn",
    "Repository access for this Agent version has ended; do not retry. Ask an operator to bind the repository and deploy.",
  ],
  [
    "credential_unavailable",
    "The repository credential is unavailable; ask an operator to check the worker log before retrying.",
  ],
  [
    "route_blocked",
    "The repository route is closed for this Agent version; ask an operator to deploy a new version.",
  ],
  ["route_not_ready", "The repository route is not ready yet; retry in a minute."],
  [
    "online_authorization_denied",
    "Retry once; if it is refused again, ask an operator to check the worker log.",
  ],
]);

// Both senders spend the grant allowance before any send to GitHub.
const ALLOWANCE_USED =
  "the grant's draft-create allowance was already used. GitHub did not receive this request. Check whether the earlier attempt created a draft; do not submit another create.";

/**
 * Native broker refusals (finding 2410). The broker answers each of these codes before it
 * sends anything to GitHub, so the advice mirrors the OpenShell route's, except where the
 * operator looks: the broker logs its refusals in the worker Pod's `repository-credentials`
 * container, not the default `worker` container (finding 2431). A create that may have been
 * sent comes back as `exchange-uncertain` or an `outcome_unknown` receipt instead.
 */
const BROKER_REFUSALS: ReadonlyMap<string, string | undefined> = new Map([
  ["unsupported-request", ROUTE_REFUSALS.get("request_not_allowed")],
  [
    "session-unavailable",
    "The repository session for this Agent version is not open; if a retry is refused too, ask an operator to check the repository binding.",
  ],
  [
    "unavailable",
    "Retry once; if it is refused again, ask an operator to check the repository-credentials container log in the worker Pod.",
  ],
  [
    // Either this session's request limit or the broker's total limit refused it.
    "exchange-capacity",
    "Too many repository requests are running, for this Agent or across the broker; retry after a short wait.",
  ],
  ["invalid-request", undefined],
  ["limit-exceeded", undefined],
  ["request-expired", undefined],
  ["authentication-required", undefined],
  ["invalid-credential", undefined],
  ["invalid-binding", undefined],
  ["route-denied", undefined],
]);

/** Classifies a native broker reply other than a created draft's receipt. */
function brokerRefusal(status: number | undefined, result: unknown) {
  if (status === undefined || status < 400 || result === null || typeof result !== "object") {
    return undefined;
  }
  const error = (result as Record<string, unknown>).error;
  // A recorded receipt for this operation, or the grant's spent allowance.
  if (error === "operation_conflict") {
    return new DraftPullFailure("not-created", ALLOWANCE_USED);
  }
  if (error === "not-submitted") {
    return new DraftPullFailure(
      "not-created",
      "the repository broker recorded this operation as not sent (not-submitted); GitHub did not receive it.",
    );
  }
  const code =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>).code
      : undefined;
  if (typeof code !== "string" || !BROKER_REFUSALS.has(code)) {
    return undefined;
  }
  const advice = BROKER_REFUSALS.get(code);
  return new DraftPullFailure(
    "not-created",
    `the repository broker refused it (${code}); GitHub did not receive it.${advice ? ` ${advice}` : ""}`,
  );
}

/**
 * Classifies a reply OpenShell or GitHub gave instead of a created draft. OpenShell marks a
 * refusal made before forwarding with `layer: "l7"` (request-phase middleware and L7 policy);
 * any other OpenShell refusal, such as a response-phase middleware block, may follow a create
 * and stays unconfirmed.
 */
function openShellRefusal(status: number | undefined, result: Record<string, unknown> | undefined) {
  if (typeof result?.error === "string") {
    if (result.layer !== "l7") {
      return undefined;
    }
    if (result.error === "middleware_denied") {
      const reason = printable(result.reason_code);
      if (reason === "draft_already_opened") {
        // Authorization spends the grant allowance before any send to GitHub.
        return new DraftPullFailure("not-created", ALLOWANCE_USED);
      }
      const advice = reason === undefined ? undefined : ROUTE_REFUSALS.get(reason);
      return new DraftPullFailure(
        "not-created",
        `the repository route refused it${reason ? ` (${reason})` : ""}; GitHub did not receive it.${advice ? ` ${advice}` : ""}`,
      );
    }
    if (result.error === "middleware_failed") {
      return new DraftPullFailure(
        "not-created",
        "the repository route could not check it; GitHub did not receive it. Ask an operator to check the worker.",
      );
    }
    return new DraftPullFailure(
      "not-created",
      `OpenShell refused it (${printable(result.error) ?? "policy"}); GitHub did not receive it.`,
    );
  }
  if (status === undefined || status < 400 || status >= 500) {
    return undefined;
  }
  const errors = Array.isArray(result?.errors) ? result.errors.slice(0, 5) : [];
  const detail = [
    printable(result?.message),
    ...errors.map((item) => printable((item as Record<string, unknown> | null)?.message)),
  ]
    .filter((item) => item !== undefined)
    .join("; ");
  const hint =
    status === 401 ? " The repository credential was not accepted; ask an operator." : "";
  return new DraftPullFailure(
    "not-created",
    `GitHub answered ${status}${detail ? `: ${detail}` : ""}${/[.!?]$/.test(detail) ? "" : "."}${hint}`,
  );
}

/** Exactly one HTTPS exchange, with the broker or with GitHub through OpenShell's mediation. */
export async function createDraftPull(args: string[], manifestRoot?: string) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        head: { type: "string" },
        base: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        "operation-id": { type: "string" },
        draft: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new DraftPullFailure("usage", (error as Error).message);
  }
  const { values: q, positionals } = parsed;
  const { head, base, title, body = "", draft } = q;
  if (positionals.length !== 1 || positionals[0] !== "pr-create") {
    throw new DraftPullFailure("usage", "The only command is pr-create.");
  }
  const missing = [
    ...(draft ? [] : ["--draft"]),
    ...(head ? [] : ["--head"]),
    ...(base ? [] : ["--base"]),
    ...(title ? [] : ["--title"]),
  ];
  if (!head || !base || !title || !draft) {
    throw new DraftPullFailure("usage", `Missing ${missing.join(", ")}.`);
  }
  const operationId = q["operation-id"] ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) {
    throw new DraftPullFailure("usage", "--operation-id must be a lowercase UUIDv4.");
  }
  const { client, bearer, ca, check, openShell } = await transport(head, base, manifestRoot);
  const { gatewayOrigin, repository } = client;
  const bytes = Buffer.from(
    JSON.stringify({
      title,
      head,
      base,
      body,
      draft,
      ...(openShell && { maintainer_can_modify: false }),
    }),
  );
  if (bytes.length > 65536) {
    bearer.fill(0);
    throw new DraftPullFailure("not-sent", "the title and body exceed 64 KiB.");
  }
  const path = "/repos/" + repository + "/pulls";
  // Record the ID before the first possible send. A failed response may mean a draft was created.
  process.stderr.write(
    (openShell ? "local draft attempt " : "draft pull operation ") + operationId + "\n",
  );
  try {
    try {
      check?.();
    } catch {
      throw new DraftPullFailure("not-sent", "the repository session has expired.");
    }
    // A managed Agent shell reaches the bound broker through its HTTPS proxy; TLS authenticates
    // the broker end to end. OpenShell strips proxy variables and mediates every connection from
    // the sandbox network namespace, as for Git there: connect to the GitHub API origin and
    // ignore a proxy the Agent set itself. Never use NO_PROXY or retry another way.
    const proxy = openShell ? undefined : (process.env.https_proxy ?? process.env.HTTPS_PROXY);
    const agent = new Agent({
      keepAlive: false,
      ...(proxy ? { proxyEnv: { HTTPS_PROXY: proxy } } : {}),
    });
    const receipt = await new Promise<string>((resolve, reject) => {
      const req = request(
        gatewayOrigin + path,
        {
          method: "POST",
          agent,
          ca,
          rejectUnauthorized: true,
          headers: {
            "content-type": "application/json",
            "content-length": bytes.length,
            ...(openShell
              ? { "user-agent": "openclaw-enterprise", accept: "application/vnd.github+json" }
              : { "x-oce-operation-id": operationId }),
            authorization: "Bearer " + bearer.toString(),
          },
          signal: AbortSignal.timeout(35000),
        },
        async (res) => {
          try {
            let data = "";
            for await (const chunk of res) {
              data += String(chunk);
              if (data.length > (openShell ? 1024 * 1024 : 8192)) {
                throw new Error("unrecognized-receipt");
              }
            }
            let result;
            try {
              result = JSON.parse(data);
            } catch {
              // A non-JSON 4xx still says GitHub (or the route) refused the create.
              const refusal = openShell ? openShellRefusal(res.statusCode, undefined) : undefined;
              throw refusal ?? new Error("unrecognized-receipt");
            }
            if (openShell) {
              // OCE authorizes this create once; only GitHub's reply confirms its outcome.
              const { html_url: url, number } = result;
              // GitHub answers with the repository's own spelling of the lowercased name.
              if (
                res.statusCode !== 201 ||
                result.state !== "open" ||
                result.draft !== true ||
                !Number.isSafeInteger(number) ||
                number < 1 ||
                !isGitHubPullUrl(url, repository, number) ||
                result.head?.ref !== head ||
                !isSameGitHubRepository(result.head?.repo?.full_name, repository) ||
                result.base?.ref !== base ||
                !isSameGitHubRepository(result.base?.repo?.full_name, repository)
              ) {
                throw (
                  openShellRefusal(
                    res.statusCode,
                    result !== null && typeof result === "object" ? result : undefined,
                  ) ?? new Error("github-draft-not-confirmed")
                );
              }
              resolve(JSON.stringify({ url, number, head, base, draft: true }));
              return;
            }
            if (
              res.statusCode === 201 &&
              result.operationId === operationId &&
              result.state === "open" &&
              result.draft === true &&
              result.head?.ref === head &&
              result.base?.ref === base &&
              isGitHubPullUrl(result.url, repository, result.number)
            ) {
              resolve(JSON.stringify(result));
            } else {
              if (result?.error === "outcome_unknown") {
                process.stderr.write("draft pull outcome_unknown\n");
              }
              reject(
                brokerRefusal(res.statusCode, result) ??
                  new Error("draft-pull-receipt-unavailable"),
              );
            }
          } catch (error) {
            reject(
              error instanceof DraftPullFailure
                ? error
                : new Error("draft-pull-receipt-unavailable"),
            );
          }
        },
      );
      req.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code !== undefined && NOT_CONNECTED.has(error.code)
            ? new DraftPullFailure(
                "not-sent",
                `could not connect to ${new URL(gatewayOrigin).host} (${error.code}).`,
              )
            : new Error(`connection failed${error.code ? ` (${error.code})` : ""}`),
        );
      });
      req.end(bytes);
    });
    process.stdout.write(receipt + "\n");
  } finally {
    bearer.fill(0);
  }
}

async function transport(head: string, base: string, manifestRoot?: string) {
  const env = process.env;
  const repository = env.OCE_OPENSHELL_GIT_REPOSITORY;
  if (repository !== undefined) {
    const marker = env.GITHUB_TOKEN ?? "";
    // These are client-side mistake checks, not authorization. Never send an ambient token.
    if (
      !/^[\w-]+\/[\w.-]+$/.test(repository) ||
      env.OCE_OPENSHELL_GIT_PUSH_REF !== "refs/heads/" + head ||
      env.OCE_OPENSHELL_GIT_BASE !== base ||
      env.OCE_OPENSHELL_GIT_API_ORIGIN !== "https://api.github.com" ||
      !/^openshell:resolve:env:s[a-f0-9]{64}_GITHUB_TOKEN$/.test(marker)
    ) {
      // The admitted branch and base are this Sandbox's own environment, not a secret.
      const admittedHead = env.OCE_OPENSHELL_GIT_PUSH_REF?.replace(/^refs\/heads\//, "");
      throw new DraftPullFailure(
        "not-sent",
        env.OCE_OPENSHELL_GIT_PUSH_REF === "refs/heads/" + head &&
          env.OCE_OPENSHELL_GIT_BASE === base
          ? "this Sandbox's repository binding is incomplete; ask an operator."
          : `this Sandbox's repository binding allows only --head ${admittedHead ?? "(none)"} --base ${env.OCE_OPENSHELL_GIT_BASE ?? "(none)"}.`,
      );
    }
    return {
      client: { gatewayOrigin: "https://api.github.com", repository },
      bearer: Buffer.from(marker),
      ca: undefined,
      check: undefined,
      openShell: true,
    };
  }
  const manifest = await readRuntimeRepositoryManifest(manifestRoot);
  const b =
    inheritedRepositoryBinding(manifest, env) ??
    (manifest.bindings.length === 1 ? manifest.bindings[0] : undefined);
  if (!b) {
    throw new DraftPullFailure(
      "not-sent",
      "no single repository binding is selected for this workspace.",
    );
  }
  const check = () => requireCurrentBinding(b);
  check();
  const ca = b.configuration.hasPublicCa
    ? await readPrivateFile(join(b.directory, "ca.pem"), 65536)
    : undefined;
  const bearer = await readPrivateFile(join(b.directory, "bearer"), 256);
  return { client: b.client, ca, bearer, check, openShell: false };
}
/** The one stderr line for a failure, and the exit code: 2 for usage, 1 otherwise. */
export function draftPullFailureMessage(error: unknown): { message: string; exitCode: number } {
  if (error instanceof DraftPullFailure) {
    if (error.stage === "usage") {
      return { message: `${error.message}\n${USAGE}`, exitCode: 2 };
    }
    return {
      message:
        (error.stage === "not-sent" ? "Draft not sent: " : "Draft not created: ") + error.message,
      exitCode: 1,
    };
  }
  const reason = error instanceof Error && error.message.startsWith("connection failed");
  return {
    message: `Draft not confirmed${reason ? ` (${(error as Error).message})` : ""}. Check the pull requests at the repository; do not submit another create.`,
    exitCode: 1,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(USAGE + "\n");
  } else {
    createDraftPull(args).catch((error: unknown) => {
      const { message, exitCode } = draftPullFailureMessage(error);
      process.stderr.write(message + "\n");
      process.exitCode = exitCode;
    });
  }
}
