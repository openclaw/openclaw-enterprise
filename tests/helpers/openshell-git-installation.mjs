import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { Agent, fetch } = require("undici");

export function createOpenShellGitApi({ origin, key, signal, after }) {
  const base = new URL(origin);
  assert.ok(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      base.port &&
      base.username === "" &&
      base.password === "" &&
      base.pathname === "/" &&
      base.search === "" &&
      base.hash === "",
    "Installed Git API requires its owned loopback origin",
  );
  // This key and Secret request bodies belong only to the disposable API. A
  // private dispatcher bypasses ambient proxies without altering other traffic.
  const dispatcher = new Agent();
  after(() => dispatcher.close());
  return async (method, path, body, expectedFailure) => {
    const url = new URL(path, base);
    assert.equal(url.origin, base.origin, "Installed Git API path changed origin");
    const response = await fetch(url, {
      dispatcher,
      redirect: "error",
      method,
      headers: {
        "x-api-key": key,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (expectedFailure !== undefined) {
      let envelope;
      try {
        envelope = await response.json();
      } catch {
        throw new Error("Installed API refusal returned invalid JSON");
      }
      const error = envelope?.error;
      const details = error?.details;
      assert.ok(
        response.status === expectedFailure.status &&
          error?.code === expectedFailure.code &&
          error?.message === expectedFailure.message &&
          Array.isArray(details) &&
          details.length === 1 &&
          details[0]?.path === expectedFailure.path &&
          details[0]?.code === expectedFailure.detailCode &&
          !Object.hasOwn(details[0], "message"),
        "Installed API returned an unexpected refusal",
      );
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OCC ${method} ${path} returned HTTP ${response.status}`);
    }
    if (response.status === 204) {
      return undefined;
    }
    try {
      return (await response.json()).data;
    } catch {
      throw new Error(`OCC ${method} ${path} returned invalid JSON`);
    }
  };
}

// A terminal decision cannot later satisfy this scenario's same-runtime retention.
// Keep the failure fixed even when the supplier record contains private details.
export function assertOpenShellGitExpiryRetained(event, identity) {
  if (
    event.event === "worker.openshell-git-expiry" &&
    event.outcome === "retire-runtime" &&
    event.namespaceId === identity.namespaceId &&
    event.agentId === identity.agentId &&
    event.revisionId === identity.revisionId &&
    event.repositoryRef === identity.repositoryRef
  ) {
    throw new Error("Git expiry required runtime retirement; same-runtime retention failed.");
  }
}
