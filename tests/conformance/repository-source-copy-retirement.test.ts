import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { GIT_REVISION } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import { openShellSourceGitProviderPrefix } from "../../apps/controller/src/drivers/egress-proxy/openshell-repository-git-evidence.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { routeStore } from "../fixtures/openshell-git-route-store.ts";

// The Worker side of the repository Source copy record: it retires a recorded copy only after a
// fresh Workspace listing finds no prepared Git Provider of the revision. The fake Gateway keeps
// OpenShell's rule that a Provider a Sandbox still attaches cannot be deleted. The record's
// PostgreSQL semantics are in tests/integration/postgres-repository-source-copies.test.ts.

const OWNER = "openclaw.dev/prepared-git-binding";

/** A Workspace's Providers and profiles as OpenShell answers them; never a credential value. */
function gateway() {
  const providers = new Map<string, OpenShellProviderResponse>();
  const profiles = new Map<string, { id: string; annotations: Record<string, string> }>();
  const attached = new Set<string>();
  const calls: string[] = [];
  let unavailable = false;
  const answer = (method: string) => {
    calls.push(method);
    if (unavailable) {
      throw Object.assign(new Error("Gateway unavailable"), { code: 14 });
    }
  };
  const client = {
    async listProviders(_workspace: string) {
      answer("listProviders");
      return Array.from(providers.values());
    },
    async deleteProvider(_workspace: string, name: string) {
      answer("deleteProvider");
      if (attached.has(name)) {
        throw new Error("FAILED_PRECONDITION: a Sandbox still attaches the provider");
      }
      providers.delete(name);
    },
    async getProviderProfile(_workspace: string, id: string) {
      answer("getProviderProfile");
      return profiles.get(id);
    },
    async listProviderProfiles(_workspace: string) {
      answer("listProviderProfiles");
      return Array.from(profiles.values());
    },
    async deleteProviderProfile(_workspace: string, id: string) {
      answer("deleteProviderProfile");
      profiles.delete(id);
    },
  };
  /** The Source Provider a preparation writes for the revision: name and profile from its owner. */
  const prepare = (revisionId: string) => {
    const owner = createHash("sha256").update(revisionId).digest("hex").slice(0, 48);
    const name = openShellSourceGitProviderPrefix + owner.slice(0, 32);
    providers.set(name, {
      name,
      type: name,
      labels: { [OWNER]: owner, [GIT_REVISION]: revisionId },
      config: {},
      resourceVersion: "1",
    });
    profiles.set(name, { id: name, annotations: { [OWNER]: owner, [GIT_REVISION]: revisionId } });
    return name;
  };
  return {
    client: client as unknown as OpenShellGatewayClient,
    providers,
    profiles,
    attached,
    calls,
    prepare,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
  };
}

function runtime() {
  const store = routeStore();
  const git = new OpenShellGitRuntime(
    {
      registrationName: "oce-prepared-git",
      authority: {
        host: "127.0.0.1",
        port: 0,
        certificatePath: "",
        privateKeyPath: "",
        issuerPublicKeyPath: "",
        issuer: "test-issuer",
        audience: "test-audience",
        keyId: "test-key",
      },
    },
    (() => {
      throw new Error("No delivery is resolved to retire a copy.");
    }) as never,
  );
  const events: Record<string, unknown>[] = [];
  git["routes"] = store;
  git["emit"] = (event: Readonly<Record<string, unknown>>) => {
    events.push({ ...event });
  };
  const record = (revisionId: string, idle = false) =>
    store.copies.set(revisionId, {
      revisionId,
      namespaceId: "ns-a",
      agentId: "agent-a",
      credentialSourceId: "cs_fixture_token",
      namespaceName: "team-a",
      retired: false,
      idle,
    });
  return { git, store, events, record };
}

const signal = () => AbortSignal.timeout(2_000);

test("a recorded copy is retired only after the Workspace no longer lists its Provider", async () => {
  const { git, store, events, record } = runtime();
  const g = gateway();
  record("rev-a");
  const name = g.prepare("rev-a");
  // Another revision's Provider in the same Workspace is not this copy's.
  const other = g.prepare("rev-b");

  // While its Sandbox attaches the Provider, OpenShell refuses the delete: the copy stays.
  g.attached.add(name);
  assert.equal(
    await git.retireSourceCopy("rev-a", g.client, "team-a", signal()),
    "provider_present",
  );
  assert.equal(store.copies.get("rev-a")?.retired, false);
  assert.equal(store.copies.get("rev-a")?.retirementBlocked, "provider_present");
  assert.ok(g.providers.has(name));

  // Once the Sandbox is gone, the Provider and its profile go and the read-back retires the copy.
  g.attached.delete(name);
  assert.equal(await git.retireSourceCopy("rev-a", g.client, "team-a", signal()), "retired");
  assert.equal(store.copies.get("rev-a")?.retired, true);
  assert.equal(store.copies.get("rev-a")?.retirementBlocked, undefined);
  assert.deepEqual([g.providers.has(name), g.profiles.has(name)], [false, false]);
  assert.ok(g.providers.has(other));
  assert.deepEqual(
    events.map(({ event, status, reason, revisionId, credentialSourceId }) => [
      event,
      status,
      reason,
      revisionId,
      credentialSourceId,
    ]),
    [
      ["worker.openshell-git-copy", "retained", "provider_present", "rev-a", "cs_fixture_token"],
      ["worker.openshell-git-copy", "retired", undefined, "rev-a", "cs_fixture_token"],
    ],
  );

  // A retired copy is final: a later cleanup pass reads the record and calls no Gateway.
  g.calls.length = 0;
  assert.equal(await git.retireSourceCopy("rev-a", g.client, "team-a", signal()), undefined);
  assert.deepEqual(g.calls, []);
});

test("a copy whose Gateway does not answer stays unretired until a later pass reads it back", async () => {
  const { git, store, record } = runtime();
  const g = gateway();
  record("rev-a");
  g.prepare("rev-a");
  g.setUnavailable(true);
  assert.equal(
    await git.retireSourceCopy("rev-a", g.client, "team-a", signal()),
    "gateway_unavailable",
  );
  assert.equal(store.copies.get("rev-a")?.retired, false);
  assert.equal(store.copies.get("rev-a")?.retirementBlocked, "gateway_unavailable");
  g.setUnavailable(false);
  assert.equal(await git.retireSourceCopy("rev-a", g.client, "team-a", signal()), "retired");
});

test("a revision without a recorded copy calls no Gateway, as for an App-backed revision", async () => {
  const { git } = runtime();
  const g = gateway();
  g.prepare("rev-app");
  assert.equal(await git.retireSourceCopy("rev-app", g.client, "team-a", signal()), undefined);
  assert.deepEqual(g.calls, []);
  assert.equal(g.providers.size, 1);
  // A runtime without the copy store (an older store fake) retires nothing either.
  const bare = runtime();
  bare.git["routes"] = undefined;
  assert.equal(await bare.git.retireSourceCopy("rev-app", g.client, "team-a", signal()), undefined);
});

test("at Worker start the record, not the registry, names the copies to retire", async () => {
  const { git, store, record } = runtime();
  const g = gateway();
  // rev-gone: its registry entry was removed and both processes restarted; its Sandbox is gone.
  // rev-live: still the running Agent's revision, so the store does not name it as idle.
  record("rev-gone", true);
  record("rev-live", false);
  const gone = g.prepare("rev-gone");
  const live = g.prepare("rev-live");
  g.attached.add(live);
  const namespaces: string[] = [];
  await git.retireIdleSourceCopies((namespaceName) => {
    namespaces.push(namespaceName);
    return g.client;
  }, signal());
  assert.deepEqual(namespaces, ["team-a"]);
  assert.equal(store.copies.get("rev-gone")?.retired, true);
  assert.equal(g.providers.has(gone), false);
  assert.equal(store.copies.get("rev-live")?.retired, false);
  assert.equal(g.providers.has(live), true);

  // A Worker stopped mid-retirement (Provider deleted, retirement unrecorded) finishes at start.
  record("rev-stopped", true);
  await git.retireIdleSourceCopies(() => g.client, signal());
  assert.equal(store.copies.get("rev-stopped")?.retired, true);
});
