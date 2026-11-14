import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

type Target = "P" | "A";
type TransitionStage =
  "setup" | "P-to-P" | "P-to-A" | "A-to-A" | "A-to-P" | "P-back-to-A" | "cleanup";
type TransitionOperation =
  | "exclusive-disposable"
  | "provider-selection"
  | "running-provider"
  | "close-and-probe-routes"
  | "verified-skew"
  | "refusal-policy"
  | "qualified-pair"
  | "tls-input"
  | "initial-virgin-issuance"
  | "initial-target"
  | "catalog"
  | "open-target"
  | "enrollment"
  | "checkpoint-state"
  | "transition"
  | "close-and-cleanup-owned";

type ClosedRoutes = Readonly<Record<"start" | "callback" | "result", 503>>;
type ResultExpectation = "allowed" | "deny";
type ResultTiming = "live" | "expired";
type IssuanceObservation = {
  event: "issued";
  ordinal: number;
  target: Target;
  remainingMs: number;
  disposition?: "INCONCLUSIVE";
};
type ResultObservation = {
  event: "result";
  ordinal: number;
  expected: ResultExpectation;
  timing: ResultTiming | "observed";
  remainingMs: number;
  status: number;
  disposition?: "INCONCLUSIVE";
};
type TransitionObservation =
  | IssuanceObservation
  | ResultObservation
  | { event: "handoff"; closedRoutes: ClosedRoutes; remainingMs: number[] }
  | { event: "admission-refusal"; controls: ["unknown-target", "missing-clock"]; status: 503 }
  | { decision: "legacy-fence-complete"; elapsedMs: number; skewMs: number }
  | { event: "transition-complete" }
  | {
      event: "failure";
      operation: TransitionOperation;
      category: ReturnType<typeof failureCategory>;
      disposition: "FAIL";
    }
  | "replacement-verified";

type Login = {
  attemptId: string;
  cookie: string;
  sessionId: string;
  providerId: string;
  deadline: number;
  key: string;
};
type Controls = { spent: Login; open: Login };
type ResultRowExpectation = "present" | "absent" | "original-or-pruned";
type PasswordLogin = { email: string; password: string };
type SendOptions = {
  method?: "GET" | "POST";
  cookie?: string;
  body?: PasswordLogin | { subject: string; expectedVersion: number } | { attemptId: string };
};

type TargetImages<Image> = Readonly<Record<Target, Image>>;
type ProviderHashes = Readonly<Record<string, string>>;
type FixtureFetch = (
  url: URL,
  options: {
    method?: "GET" | "POST";
    redirect: "manual";
    signal: AbortSignal;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<Response>;

export type TransitionFixture<Image, PreviousPod> = {
  signinPlan: { previous: { version: 2 | 3 }; candidate: { version: 3 } };
  canAdmit: (
    target: Target | "unknown",
    images: TargetImages<Image>,
    skew: number | null,
  ) => boolean;
  images: TargetImages<Image>;
  origin: string;
  authorizationUrl: string;
  userId: string;
  passwordLogin: PasswordLogin;
  providerDirectory: URL;
  providerHashes: ProviderHashes;
  consoleFetch: FixtureFetch;
  providerFetch: FixtureFetch;
  assertExclusiveDisposable: () => Promise<void>;
  assertRunningProvider: (hashes: ProviderHashes) => Promise<void>;
  closeAndProbeRoutes: () => Promise<ClosedRoutes>;
  assertClosedRoutes: () => Promise<ClosedRoutes>;
  verifiedSkewMs: () => Promise<number>;
  readerUpperMs: () => Promise<number>;
  waitUntilReaderPast: (deadline: number) => Promise<void>;
  assertInitialVirginIssuance: () => Promise<void>;
  assertOnlyTarget: (
    target: Target,
    image: Image,
    previous: readonly PreviousPod[],
  ) => Promise<void>;
  assertCatalog: () => Promise<void>;
  openTarget: (target: Target) => Promise<void>;
  checkpointState: () => Promise<void>;
  assertResultRow: (login: Login, expected: ResultRowExpectation) => Promise<void>;
  refusalControls: (probe: () => Promise<void>) => Promise<void>;
  stopAndDrain: (target: Target) => Promise<readonly PreviousPod[]>;
  assertNoController: () => Promise<void>;
  assertV2Fenced: () => Promise<void>;
  startClosed: (target: Target, image: Image) => Promise<void>;
  assertRetainedState: () => Promise<void>;
  record: (stage: TransitionStage, observation: TransitionObservation) => Promise<void>;
  closeAndCleanupOwned: () => Promise<void>;
};

// Called inside the owned, already-populated rehearsal. All fixture hooks throw on failure.
// Requests, cookies and DB rows stay in process. Diagnostics are fixed identifiers.
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) {
    throw new Error(reason);
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0])
    .join("; ");
}
const lifetime = 120_000;
function failureCategory(error: unknown) {
  const fields = isObject(error) ? error : undefined;
  if (fields?.name === "TimeoutError" || fields?.code === "ETIMEDOUT") {
    return "timeout";
  }
  if (fields?.name === "AbortError") {
    return "aborted";
  }
  if (fields?.code === "ERR_ASSERTION") {
    return "assertion";
  }
  if (error instanceof SyntaxError) {
    return "invalid-data";
  }
  return "operation-failed";
}

export async function runTransition<Image extends { configDigest: string }, PreviousPod>(
  fixture: TransitionFixture<Image, PreviousPod>,
): Promise<void> {
  const versions = {
    P: fixture.signinPlan?.previous?.version,
    A: fixture.signinPlan?.candidate?.version,
  };
  check((versions.P === 2 || versions.P === 3) && versions.A === 3, "unsupported-signin-plan");
  check(typeof fixture.canAdmit === "function", "missing-admission-policy");
  let stage: TransitionStage = "setup";
  let operation: TransitionOperation = "exclusive-disposable";
  let owned = false;
  const { origin, authorizationUrl, userId, images } = fixture;
  const sessions: Login[] = [];
  // Inputs come from the exclusive fixture, never from the active kube context or a live installation.
  async function send(
    path: string | URL,
    { method = "GET", cookie, body }: SendOptions = {},
  ): Promise<Response> {
    const url = new URL(path, origin);
    check(url.origin === origin, "controller-origin");
    return fixture.consoleFetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        origin,
        ...(cookie && { cookie }),
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
  }
  async function data(response: Response) {
    check(response.ok, "api-status");
    const payload: unknown = await response.json();
    return isObject(payload) ? payload.data : undefined;
  }
  async function session(cookie: string) {
    const current = await data(await send("/api/auth/session", { cookie }));
    check(
      isObject(current) &&
        current.authenticated &&
        isObject(current.user) &&
        current.user.id === userId &&
        typeof current.sessionKey === "string" &&
        current.sessionKey.length,
      "session-binding",
    );
    return current.sessionKey;
  }
  async function enroll(subject: string) {
    const response = await send("/api/auth/sign-in/email", {
      method: "POST",
      body: fixture.passwordLogin,
    });
    check(response.status === 200, "password-login");
    const cookie = cookies(response);
    const path = "/api/auth/accounts/" + encodeURIComponent(userId);
    const account = await data(await send(path, { cookie }));
    check(
      isObject(account) &&
        typeof account.version === "number" &&
        Number.isSafeInteger(account.version),
      "account-version",
    );
    const attached = await send(path + "/providers/oidc", {
      method: "POST",
      cookie,
      body: { subject, expectedVersion: account.version },
    });
    check(attached.status === 200, "enrollment");
  }
  async function issue(target: Target): Promise<Login> {
    const path = "/api/auth/providers/oidc";
    const start = await send(path + "/start", { method: "POST" });
    const provider = await data(start);
    check(isObject(provider), "provider-start");
    const { url, attemptId } = provider;
    check(typeof url === "string", "provider-start");
    const auth = new URL(url);
    check(
      auth.origin + auth.pathname === authorizationUrl &&
        !auth.username &&
        !auth.password &&
        typeof attemptId === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(attemptId),
      "provider-start",
    );
    const grant = await fixture.providerFetch(auth, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    check(grant.status === 302, "provider-grant");
    const location = grant.headers.get("location");
    check(location !== null, "provider-callback");
    const callback = new URL(location);
    check(
      callback.origin === origin &&
        callback.pathname === path + "/callback" &&
        callback.searchParams.has("code") &&
        callback.searchParams.get("state") === auth.searchParams.get("state"),
      "provider-callback",
    );
    const completed = await send(callback, { cookie: cookies(start) });
    check(completed.status === 302, "callback-status");
    const cookie = cookies(completed);
    const encoded = cookie.match(/(?:^|; )__Host-occ_login_receipt=([A-Za-z0-9_-]+)\./)?.[1];
    check(encoded, "receipt-cookie");
    const receipt: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    check(isObject(receipt), "issued-version");
    const { a, s, p, v, e } = receipt;
    check(
      a === attemptId &&
        v === versions[target] &&
        typeof s === "string" &&
        typeof p === "string" &&
        typeof e === "number" &&
        Number.isSafeInteger(e),
      "issued-version",
    );
    const login = {
      attemptId,
      cookie,
      sessionId: s,
      providerId: p,
      deadline: e,
      key: await session(cookie),
    };
    await fixture.assertResultRow(login, versions[target] === 3 ? "present" : "absent");
    sessions.push(login);
    const remainingMs = login.deadline - (await fixture.readerUpperMs());
    const evidence: IssuanceObservation = {
      event: "issued",
      ordinal: sessions.length,
      target,
      remainingMs,
    };
    // An already-expired control cannot prove a later live-to-expired transition.
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      await fixture.record(stage, { ...evidence, disposition: "INCONCLUSIVE" });
      throw new Error("issuance-window-missed");
    }
    await fixture.record(stage, evidence);
    return login;
  }
  function requestResult(login: Login) {
    return send("/api/auth/providers/oidc/result", {
      method: "POST",
      cookie: login.cookie,
      body: { attemptId: login.attemptId },
    });
  }
  async function collect(login: Login, expected: ResultExpectation, timing?: ResultTiming) {
    if (timing === "expired") {
      await fixture.assertResultRow(login, "original-or-pruned");
    }
    const result = await requestResult(login);
    // Reader/DB time interval must enclose this request. Use the conservative end appropriate to the proof.
    const remainingMs = login.deadline - (await fixture.readerUpperMs());
    const evidence: ResultObservation = {
      event: "result",
      ordinal: sessions.indexOf(login) + 1,
      expected,
      timing: timing ?? "observed",
      remainingMs,
      status: result.status,
    };
    if (timing === "live" && remainingMs <= 0) {
      await fixture.record(stage, { ...evidence, disposition: "INCONCLUSIVE" });
      throw new Error("live-window-missed");
    }
    const text = await result.text();
    const payload: unknown = text ? JSON.parse(text) : {};
    const resultData = isObject(payload) ? payload.data : undefined;
    if (expected === "allowed") {
      check(
        result.status === 200 &&
          isObject(resultData) &&
          resultData.sessionKey === login.key &&
          result.headers
            .getSetCookie()
            .some((c) => /login_receipt=;.*(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(c)),
        "collection",
      );
      await fixture.assertResultRow(login, "absent");
    } else {
      check(
        result.status === 401 &&
          payload !== null &&
          !(isObject(payload) && Object.hasOwn(payload, "sessionKey")) &&
          !(isObject(resultData) && Object.hasOwn(resultData, "sessionKey")) &&
          !sessions.some((l) => text.includes(l.key)),
        "denial",
      );
      if (timing === "expired") {
        await fixture.assertResultRow(login, "original-or-pruned");
      }
    }
    await fixture.record(stage, evidence);
  }
  async function controls(target: Target): Promise<Controls> {
    const spent = await issue(target);
    await collect(spent, "allowed", "live");
    return { spent, open: await issue(target) };
  }
  async function collectCompatibleControls({ spent, open }: Controls) {
    await collect(spent, "deny", "live");
    await collect(open, "allowed", "live");
    await collect(open, "deny", "live");
  }
  async function awaitFence(start: number, skew: number) {
    for (;;) {
      await fixture.assertV2Fenced();
      const left = start + lifetime + skew - performance.now();
      if (left <= 0) {
        break;
      }
      await delay(Math.min(Math.ceil(left), 5000));
    }
  }
  async function replace(from: Target, to: Target, skew: number, previousFence?: number) {
    const closedRoutes = await fixture.closeAndProbeRoutes();
    const now = await fixture.readerUpperMs();
    await fixture.record(stage, {
      event: "handoff",
      closedRoutes,
      remainingMs: sessions.map((login) => login.deadline - now),
    });
    if (stage === "P-to-P" || (versions.P === 3 && stage === "P-to-A")) {
      const original = sessions.at(-1);
      check(original, "missing-bound-control");
      await fixture.refusalControls(async () => {
        const result = await requestResult(original);
        check(
          result.status === 503 && result.headers.get("x-rehearsal-gate") === "closed",
          "closed-bound-control",
        );
        await result.arrayBuffer();
      });
      await fixture.record(stage, {
        event: "admission-refusal",
        controls: ["unknown-target", "missing-clock"],
        status: 503,
      });
    }
    const previous = await fixture.stopAndDrain(from);
    await fixture.assertNoController();
    const fence = versions[from] === 2 ? performance.now() : previousFence;
    if (versions.P === 2) {
      await fixture.assertV2Fenced();
    }
    check(fixture.canAdmit(to, images, skew), "target-refused");
    if (versions[to] === 2) {
      check(fence !== undefined && Number.isFinite(fence), "missing-issuer-fence");
      await awaitFence(fence, skew);
      await fixture.assertClosedRoutes();
      await fixture.record(stage, {
        decision: "legacy-fence-complete",
        elapsedMs: Math.floor(performance.now() - fence),
        skewMs: skew,
      });
    }
    await fixture.startClosed(to, images[to]);
    await fixture.assertOnlyTarget(to, images[to], previous);
    await fixture.assertRetainedState();
    await fixture.assertRunningProvider(fixture.providerHashes);
    await fixture.assertCatalog();
    await fixture.assertClosedRoutes();
    await fixture.openTarget(to);
    for (const login of sessions) {
      check((await session(login.cookie)) === login.key, "retained-session");
    }
    await fixture.record(stage, "replacement-verified");
    return fence;
  }
  async function recordFailure(
    failedStage: TransitionStage,
    failedOperation: TransitionOperation,
    category: ReturnType<typeof failureCategory>,
  ) {
    try {
      await fixture.record(failedStage, {
        event: "failure",
        operation: failedOperation,
        category,
        disposition: "FAIL",
      });
    } catch {
      // Recording failure cannot replace the original exception or skip cleanup.
    }
  }
  async function execute() {
    await fixture.assertExclusiveDisposable();
    owned = true;
    operation = "provider-selection";
    let subject: unknown;
    for (const [name, expected] of Object.entries(fixture.providerHashes)) {
      const bytes = await readFile(new URL(name, fixture.providerDirectory));
      check(createHash("sha256").update(bytes).digest("hex") === expected, "provider-selection");
      if (name === "config.json") {
        const config: unknown = JSON.parse(bytes.toString("utf8"));
        subject = isObject(config) ? config.subject : undefined;
      }
    }
    check(typeof subject === "string" && subject.length, "synthetic-subject");
    operation = "running-provider";
    await fixture.assertRunningProvider(fixture.providerHashes);
    operation = "close-and-probe-routes";
    await fixture.closeAndProbeRoutes();
    operation = "verified-skew";
    const skew = await fixture.verifiedSkewMs();
    operation = "refusal-policy";
    check(
      !fixture.canAdmit("unknown", images, skew) && !fixture.canAdmit("P", images, null),
      "refusal-policy",
    );
    operation = "qualified-pair";
    check(
      fixture.canAdmit("P", images, skew) &&
        fixture.canAdmit("A", images, skew) &&
        images.P.configDigest !== images.A.configDigest,
      "unqualified-pair",
    );
    operation = "tls-input";
    check(
      origin === new URL(origin).origin &&
        origin.startsWith("https://") &&
        origin === "https://console.signin-rehearsal.test" &&
        authorizationUrl === "https://idp.signin-rehearsal.test/authorize",
      "tls-input",
    );
    operation = "initial-virgin-issuance";
    await fixture.assertInitialVirginIssuance();
    operation = "initial-target";
    await fixture.assertOnlyTarget("P", images.P, []);
    operation = "catalog";
    await fixture.assertCatalog();
    operation = "open-target";
    await fixture.openTarget("P");
    operation = "enrollment";
    await enroll(subject);
    operation = "checkpoint-state";
    await fixture.checkpointState();
    operation = "transition";
    if (versions.P === 3) {
      stage = "P-to-A";
      const forward = await controls("P");
      await replace("P", "A", skew);
      await collectCompatibleControls(forward);
      await fixture.record(stage, { event: "transition-complete" });
      stage = "A-to-P";
      const returning = await controls("A");
      await replace("A", "P", skew);
      await collectCompatibleControls(returning);
      await collect(forward.open, "deny", "live");
      await fixture.assertResultRow(forward.open, "absent");
      const expired = await issue("P");
      await fixture.waitUntilReaderPast(expired.deadline);
      await collect(expired, "deny", "expired");
      const final = await issue("P");
      await collect(final, "allowed", "live");
      await fixture.assertRetainedState();
      await fixture.assertCatalog();
      await fixture.record(stage, { event: "transition-complete" });
      return;
    }
    stage = "P-to-P";
    const legacy = await controls("P");
    await replace("P", "P", skew);
    await collect(legacy.spent, "deny");
    await collect(legacy.open, "deny");
    await fixture.record(stage, { event: "transition-complete" });
    stage = "P-to-A";
    const beforeActivation = await controls("P");
    const legacyFence = await replace("P", "A", skew);
    await collect(beforeActivation.spent, "deny", "live");
    await collect(beforeActivation.open, "deny", "live");
    await fixture.record(stage, { event: "transition-complete" });
    stage = "A-to-A";
    const compatible = await controls("A");
    await replace("A", "A", skew);
    await collectCompatibleControls(compatible);
    const expired = await issue("A");
    await fixture.waitUntilReaderPast(expired.deadline);
    await collect(expired, "deny", "expired");
    await fixture.record(stage, { event: "transition-complete" });
    stage = "A-to-P";
    check(legacyFence !== undefined, "missing-issuer-fence");
    await awaitFence(legacyFence, skew);
    const acknowledged = await issue("A");
    await collect(acknowledged, "allowed", "live");
    await fixture.checkpointState();
    const rollback = await controls("A");
    await replace("A", "P", skew, legacyFence);
    await collect(rollback.spent, "deny", "live");
    await collect(rollback.open, "deny", "live");
    await fixture.assertResultRow(rollback.open, "present");
    await fixture.record(stage, { event: "transition-complete" });
    stage = "P-back-to-A";
    const returning = await controls("P");
    await replace("P", "A", skew);
    await collect(returning.open, "deny", "live");
    await collect(rollback.spent, "deny");
    await fixture.assertResultRow(rollback.spent, "absent");
    if ((await fixture.readerUpperMs()) < rollback.open.deadline) {
      await collect(rollback.open, "allowed", "live");
      await collect(rollback.open, "deny");
    } else {
      await fixture.waitUntilReaderPast(rollback.open.deadline);
      await collect(rollback.open, "deny", "expired");
    }
    const final = await issue("A");
    await collect(final, "allowed", "live");
    await fixture.assertRetainedState();
    await fixture.assertCatalog();
    await fixture.record(stage, { event: "transition-complete" });
  }
  let failure: Error | undefined;
  try {
    await execute();
  } catch (error) {
    // Only fixed stage, operation and category labels enter the retained message.
    const category = failureCategory(error);
    failure = new Error(
      `sign-in rehearsal failed or inconclusive at ${stage} operation=${operation} category=${category}`,
      { cause: error },
    );
    await recordFailure(stage, operation, category);
  }
  // The owning fixture must close the ingress even after an exception, then release only its own resources.
  if (owned) {
    try {
      await fixture.closeAndCleanupOwned();
    } catch (error) {
      const category = failureCategory(error);
      await recordFailure("cleanup", "close-and-cleanup-owned", category);
      const cleanup = `owned cleanup failed operation=close-and-cleanup-owned category=${category}`;
      if (failure) {
        throw new AggregateError([failure, error], `${failure.message}; ${cleanup}`, {
          cause: error,
        });
      }
      throw new Error(cleanup, { cause: error });
    }
  }
  if (failure) {
    throw failure;
  }
}
