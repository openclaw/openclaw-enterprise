import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Called inside the owned, already-populated rehearsal. All fixture hooks throw on failure.
// Requests, cookies and DB rows stay in process. Diagnostics are fixed identifiers.
function check(ok, reason) {
  if (!ok) {
    throw new Error(reason);
  }
}
function cookies(response) {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";", 1)[0])
    .join("; ");
}
const lifetime = 120_000;
function failureCategory(error) {
  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT") {
    return "timeout";
  }
  if (error?.name === "AbortError") {
    return "aborted";
  }
  if (error?.code === "ERR_ASSERTION") {
    return "assertion";
  }
  if (error instanceof SyntaxError) {
    return "invalid-data";
  }
  return "operation-failed";
}

export async function runTransition(f) {
  const versions = { P: f.signinPlan?.previous?.version, A: f.signinPlan?.candidate?.version };
  check((versions.P === 2 || versions.P === 3) && versions.A === 3, "unsupported-signin-plan");
  check(typeof f.canAdmit === "function", "missing-admission-policy");
  let stage = "setup";
  let operation = "exclusive-disposable";
  let owned = false;
  const { origin, authorizationUrl, userId, images } = f;
  let subject;
  const sessions = [];
  // Inputs come from the exclusive fixture, never from the active kube context or a live installation.
  async function send(path, { method = "GET", cookie, body } = {}) {
    const url = new URL(path, origin);
    check(url.origin === origin, "controller-origin");
    return f.consoleFetch(url, {
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
  async function data(response) {
    check(response.ok, "api-status");
    return (await response.json()).data;
  }
  async function session(cookie) {
    const current = await data(await send("/api/auth/session", { cookie }));
    check(
      current.authenticated &&
        current.user?.id === userId &&
        typeof current.sessionKey === "string" &&
        current.sessionKey.length,
      "session-binding",
    );
    return current.sessionKey;
  }
  async function enroll() {
    const response = await send("/api/auth/sign-in/email", {
      method: "POST",
      body: f.passwordLogin,
    });
    check(response.status === 200, "password-login");
    const cookie = cookies(response);
    const path = "/api/auth/accounts/" + encodeURIComponent(userId);
    const account = await data(await send(path, { cookie }));
    check(Number.isSafeInteger(account.version), "account-version");
    const attached = await send(path + "/providers/oidc", {
      method: "POST",
      cookie,
      body: { subject, expectedVersion: account.version },
    });
    check(attached.status === 200, "enrollment");
  }
  async function issue(target) {
    const path = "/api/auth/providers/oidc";
    const start = await send(path + "/start", { method: "POST" });
    const { url, attemptId } = await data(start);
    const auth = new URL(url);
    check(
      auth.origin + auth.pathname === authorizationUrl &&
        !auth.username &&
        !auth.password &&
        /^[A-Za-z0-9_-]{43}$/.test(attemptId),
      "provider-start",
    );
    const grant = await f.providerFetch(auth, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    check(grant.status === 302, "provider-grant");
    const callback = new URL(grant.headers.get("location"));
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
    const receipt = cookie.match(/(?:^|; )__Host-occ_login_receipt=([A-Za-z0-9_-]+)\./);
    check(receipt, "receipt-cookie");
    const { a, s, p, v, e } = JSON.parse(Buffer.from(receipt[1], "base64url"));
    check(a === attemptId && v === versions[target] && Number.isSafeInteger(e), "issued-version");
    const login = {
      attemptId,
      cookie,
      sessionId: s,
      providerId: p,
      deadline: e,
      key: await session(cookie),
    };
    await f.assertResultRow(login, versions[target] === 3 ? "present" : "absent");
    sessions.push(login);
    const remainingMs = login.deadline - (await f.readerUpperMs());
    const evidence = { event: "issued", ordinal: sessions.length, target, remainingMs };
    // An already-expired control cannot prove a later live-to-expired transition.
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      await f.record(stage, { ...evidence, disposition: "INCONCLUSIVE" });
      throw new Error("issuance-window-missed");
    }
    await f.record(stage, evidence);
    return login;
  }
  async function collect(login, expected, timing) {
    if (timing === "expired") {
      await f.assertResultRow(login, "original-or-pruned");
    }
    const result = await send("/api/auth/providers/oidc/result", {
      method: "POST",
      cookie: login.cookie,
      body: { attemptId: login.attemptId },
    });
    // Reader/DB time interval must enclose this request. Use the conservative end appropriate to the proof.
    const remainingMs = login.deadline - (await f.readerUpperMs());
    const evidence = {
      event: "result",
      ordinal: sessions.indexOf(login) + 1,
      expected,
      timing: timing ?? "observed",
      remainingMs,
      status: result.status,
    };
    if (timing === "live" && remainingMs <= 0) {
      await f.record(stage, { ...evidence, disposition: "INCONCLUSIVE" });
      throw new Error("live-window-missed");
    }
    const text = await result.text();
    const payload = text ? JSON.parse(text) : {};
    if (expected === "allowed") {
      check(
        result.status === 200 &&
          payload.data?.sessionKey === login.key &&
          result.headers
            .getSetCookie()
            .some((c) => /login_receipt=;.*(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(c)),
        "collection",
      );
      await f.assertResultRow(login, "absent");
    } else {
      check(
        result.status === 401 &&
          !Object.hasOwn(payload, "sessionKey") &&
          !Object.hasOwn(payload.data ?? {}, "sessionKey") &&
          !sessions.some((l) => text.includes(l.key)),
        "denial",
      );
      if (timing === "expired") {
        await f.assertResultRow(login, "original-or-pruned");
      }
    }
    await f.record(stage, evidence);
  }
  async function controls(target) {
    const spent = await issue(target);
    await collect(spent, "allowed", "live");
    return { spent, open: await issue(target) };
  }
  async function awaitFence(start, skew) {
    for (;;) {
      await f.assertV2Fenced();
      const left = start + lifetime + skew - performance.now();
      if (left <= 0) {
        break;
      }
      await delay(Math.min(Math.ceil(left), 5000));
    }
  }
  let fence;
  let skew;
  async function replace(from, to) {
    const closedRoutes = await f.closeAndProbeRoutes();
    const now = await f.readerUpperMs();
    await f.record(stage, {
      event: "handoff",
      closedRoutes,
      remainingMs: sessions.map((login) => login.deadline - now),
    });
    if (stage === "P-to-P" || (versions.P === 3 && stage === "P-to-A")) {
      const original = sessions.at(-1);
      await f.refusalControls(async () => {
        const result = await send("/api/auth/providers/oidc/result", {
          method: "POST",
          cookie: original.cookie,
          body: { attemptId: original.attemptId },
        });
        check(
          result.status === 503 && result.headers.get("x-rehearsal-gate") === "closed",
          "closed-bound-control",
        );
        await result.arrayBuffer();
      });
      await f.record(stage, {
        event: "admission-refusal",
        controls: ["unknown-target", "missing-clock"],
        status: 503,
      });
    }
    const previous = await f.stopAndDrain(from);
    await f.assertNoController();
    if (versions[from] === 2) {
      fence = performance.now();
    }
    if (versions.P === 2) {
      await f.assertV2Fenced();
    }
    check(f.canAdmit(to, images, skew), "target-refused");
    if (versions[to] === 2) {
      check(Number.isFinite(fence), "missing-issuer-fence");
      await awaitFence(fence, skew);
      await f.assertClosedRoutes();
      await f.record(stage, {
        decision: "legacy-fence-complete",
        elapsedMs: Math.floor(performance.now() - fence),
        skewMs: skew,
      });
    }
    await f.startClosed(to, images[to]);
    await f.assertOnlyTarget(to, images[to], previous);
    await f.assertRetainedState();
    await f.assertRunningProvider(f.providerHashes);
    await f.assertCatalog();
    await f.assertClosedRoutes();
    await f.openTarget(to);
    for (const login of sessions) {
      check((await session(login.cookie)) === login.key, "retained-session");
    }
    await f.record(stage, "replacement-verified");
  }
  async function recordFailure(failedStage, failedOperation, category) {
    try {
      await f.record(failedStage, {
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
    await f.assertExclusiveDisposable();
    owned = true;
    operation = "provider-selection";
    for (const [name, expected] of Object.entries(f.providerHashes)) {
      const bytes = await readFile(new URL(name, f.providerDirectory));
      check(createHash("sha256").update(bytes).digest("hex") === expected, "provider-selection");
      if (name === "config.json") {
        subject = JSON.parse(bytes).subject;
      }
    }
    check(typeof subject === "string" && subject.length, "synthetic-subject");
    operation = "running-provider";
    await f.assertRunningProvider(f.providerHashes);
    operation = "close-and-probe-routes";
    await f.closeAndProbeRoutes();
    operation = "verified-skew";
    skew = await f.verifiedSkewMs();
    operation = "refusal-policy";
    check(!f.canAdmit("unknown", images, skew) && !f.canAdmit("P", images, null), "refusal-policy");
    operation = "qualified-pair";
    check(
      ["P", "A"].every((t) => f.canAdmit(t, images, skew)) &&
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
    await f.assertInitialVirginIssuance();
    operation = "initial-target";
    await f.assertOnlyTarget("P", images.P, []);
    operation = "catalog";
    await f.assertCatalog();
    operation = "open-target";
    await f.openTarget("P");
    operation = "enrollment";
    await enroll();
    operation = "checkpoint-state";
    await f.checkpointState();
    operation = "transition";
    if (versions.P === 3) {
      stage = "P-to-A";
      const forward = await controls("P");
      await replace("P", "A");
      await collect(forward.spent, "deny", "live");
      await collect(forward.open, "allowed", "live");
      await collect(forward.open, "deny", "live");
      await f.record(stage, { event: "transition-complete" });
      stage = "A-to-P";
      const returning = await controls("A");
      await replace("A", "P");
      await collect(returning.spent, "deny", "live");
      await collect(returning.open, "allowed", "live");
      await collect(returning.open, "deny", "live");
      await collect(forward.open, "deny", "live");
      await f.assertResultRow(forward.open, "absent");
      const expired = await issue("P");
      await f.waitUntilReaderPast(expired.deadline);
      await collect(expired, "deny", "expired");
      const final = await issue("P");
      await collect(final, "allowed", "live");
      await f.assertRetainedState();
      await f.assertCatalog();
      await f.record(stage, { event: "transition-complete" });
      return;
    }
    stage = "P-to-P";
    const legacy = await controls("P");
    await replace("P", "P");
    await collect(legacy.spent, "deny");
    await collect(legacy.open, "deny");
    await f.record(stage, { event: "transition-complete" });
    stage = "P-to-A";
    const beforeActivation = await controls("P");
    await replace("P", "A");
    await collect(beforeActivation.spent, "deny", "live");
    await collect(beforeActivation.open, "deny", "live");
    await f.record(stage, { event: "transition-complete" });
    stage = "A-to-A";
    const compatible = await controls("A");
    await replace("A", "A");
    await collect(compatible.spent, "deny", "live");
    await collect(compatible.open, "allowed", "live");
    await collect(compatible.open, "deny", "live");
    const expired = await issue("A");
    await f.waitUntilReaderPast(expired.deadline);
    await collect(expired, "deny", "expired");
    await f.record(stage, { event: "transition-complete" });
    stage = "A-to-P";
    await awaitFence(fence, skew);
    const acknowledged = await issue("A");
    await collect(acknowledged, "allowed", "live");
    await f.checkpointState();
    const rollback = await controls("A");
    await replace("A", "P");
    await collect(rollback.spent, "deny", "live");
    await collect(rollback.open, "deny", "live");
    await f.assertResultRow(rollback.open, "present");
    await f.record(stage, { event: "transition-complete" });
    stage = "P-back-to-A";
    const returning = await controls("P");
    await replace("P", "A");
    await collect(returning.open, "deny", "live");
    await collect(rollback.spent, "deny");
    await f.assertResultRow(rollback.spent, "absent");
    if ((await f.readerUpperMs()) < rollback.open.deadline) {
      await collect(rollback.open, "allowed", "live");
      await collect(rollback.open, "deny");
    } else {
      await f.waitUntilReaderPast(rollback.open.deadline);
      await collect(rollback.open, "deny", "expired");
    }
    const final = await issue("A");
    await collect(final, "allowed", "live");
    await f.assertRetainedState();
    await f.assertCatalog();
    await f.record(stage, { event: "transition-complete" });
  }
  let failure;
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
      await f.closeAndCleanupOwned();
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
