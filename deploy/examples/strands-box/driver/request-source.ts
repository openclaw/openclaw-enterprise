/**
 * Stage B: answer one Box credential-source ask with OCE's decision for that request. The
 * paired Driver never classifies GitHub requests itself: `requests.authorize` (the Worker's
 * port, bound to the same authority) classifies, applies the grant's repository, ref and draft
 * rules, records the use, and returns allow with this request's credential or a refusal. This
 * module only maps the ask to OCE's request view and the decision to Box's reply.
 */
import type {
  GitHubRequestDecision,
  GitHubRequestView,
  RepositoryGitInstallationFence,
  RepositoryGitRequests,
} from "@openclaw-enterprise/contracts";
import type { SourceAnswer, SourceAsk } from "./control.ts";

/** OCE's request view of one ask: the TLS-verified target Box judged, its headers and body. */
export function requestView(ask: SourceAsk): GitHubRequestView {
  return {
    target: {
      host: ask.target.host,
      port: ask.target.port,
      method: ask.target.method,
      path: ask.target.path,
      query: ask.target.query,
    },
    headers: ask.headers,
    body: Buffer.from(ask.body, "base64"),
  };
}

/**
 * Box's reply for OCE's decision. Only an allow for the scheme the ask's route places yields a
 * value: Git (`github.com`, Box `basic_auth`) gets `x-access-token:<token>`, the API
 * (`api.github.com`, Box `header` with prefix `token `) gets the bare token. A refusal carries
 * OCE's Agent reason code, never the internal refusal name; anything else is refused.
 */
export function sourceAnswer(
  host: SourceAsk["target"]["host"],
  decision: GitHubRequestDecision,
  now: number = Date.now(),
): SourceAnswer {
  if (decision.kind !== "allow") {
    return { refusal: decision.reasonCode ?? "request_refused" };
  }
  const sendBy = Date.parse(decision.sendBy);
  if (!Number.isSafeInteger(sendBy) || !(sendBy > now)) return { refusal: "route_not_ready" };
  // A decision without the typed credential (another result shape) never yields a value.
  const credential = decision.credential as typeof decision.credential | undefined;
  if (
    typeof credential !== "object" ||
    credential === null ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  ) {
    return { refusal: "credential_mismatch" };
  }
  if (host === "github.com") {
    if (credential.scheme !== "basic" || credential.username !== "x-access-token") {
      return { refusal: "credential_mismatch" };
    }
    return { credential: `x-access-token:${credential.token}`, send_by_unix_ms: sendBy };
  }
  if (host === "api.github.com" && credential.scheme === "bearer") {
    return { credential: credential.token, send_by_unix_ms: sendBy };
  }
  return { refusal: "credential_mismatch" };
}

/** What the Driver keeps of one answered ask: identifiers and the outcome, never a value. */
export interface AskRecord {
  readonly requestId: string;
  readonly host: SourceAsk["target"]["host"];
  readonly method: string;
  readonly path: string;
  readonly outcome: "allow" | "refused";
  /** The refusal code Box shows the workload. */
  readonly refusal?: string;
  /** OCE's use record for an asked request, joining Box's `request_id` to OCE's row. */
  readonly exchangeId?: string;
  /** False when the Driver refused before asking OCE (unknown execution, wrong bearer, ...). */
  readonly asked: boolean;
}

export interface AskContext {
  /** The confirmed route of the live recipient for this execution, or none yet. */
  readonly route: RepositoryGitInstallationFence | undefined;
  /** The committed recipient's bearer digest; the host reports the presented bearer's digest. */
  readonly bearerSha256: string | undefined;
  readonly requests: RepositoryGitRequests;
  readonly signal: AbortSignal;
}

/** Fail closed before OCE is asked; otherwise one `requests.authorize` call and its mapping. */
export async function answerAsk(
  ask: SourceAsk,
  context: AskContext,
  now: number = Date.now(),
): Promise<{ readonly answer: SourceAnswer; readonly record: AskRecord }> {
  const base = {
    requestId: ask.requestId,
    host: ask.target.host,
    method: ask.target.method,
    path: ask.target.path,
  };
  const refuse = (refusal: string, asked = false, exchangeId?: string) => ({
    answer: { refusal },
    record: {
      ...base,
      outcome: "refused" as const,
      refusal,
      asked,
      ...(exchangeId === undefined ? {} : { exchangeId }),
    },
  });
  if (context.bearerSha256 === undefined || ask.bearerSha256 !== context.bearerSha256) {
    return refuse("execution_mismatch");
  }
  if (context.route === undefined) return refuse("route_not_ready");
  if (!(ask.deadlineUnixMs > now)) return refuse("route_not_ready");
  let view: GitHubRequestView;
  try {
    view = requestView(ask);
  } catch {
    return refuse("request_invalid");
  }
  // OCE answers inside the host's window or the request is refused; at most 30 s by contract.
  const deadline = Math.min(ask.deadlineUnixMs, now + 30_000);
  let decision: GitHubRequestDecision;
  try {
    decision = await context.requests.authorize({
      route: context.route,
      profile: "github_repository",
      request: view,
      deadlineAt: new Date(deadline).toISOString(),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(deadline - now, 1))]),
    });
  } catch {
    return refuse("route_not_ready", true);
  }
  const answer = sourceAnswer(ask.target.host, decision);
  const exchangeId = decision.kind === "allow" ? decision.exchangeId : decision.exchangeId;
  if ("refusal" in answer) return refuse(answer.refusal, true, exchangeId);
  return {
    answer,
    record: {
      ...base,
      outcome: "allow",
      asked: true,
      ...(exchangeId === undefined ? {} : { exchangeId }),
    },
  };
}
