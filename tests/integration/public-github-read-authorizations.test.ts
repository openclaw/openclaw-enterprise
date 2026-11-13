import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import {
  KubernetesPublicGithubReadAuthorizationStore,
  type PublicGithubReadAuthorizationStoreOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/public-github-read-authorizations.ts";
import { createPublicGithubReadServer } from "../../apps/controller/src/drivers/repo/github/public-read/server.ts";
import { publicGithubReadAuthorizationDigest } from "../../apps/controller/src/drivers/repo/github/public-read/access.ts";
import { listen } from "../helpers/listen.mjs";

type Core = PublicGithubReadAuthorizationStoreOptions["core"];
type ConfigMap = Awaited<ReturnType<Core["readNamespacedConfigMap"]>>;
type Secret = Awaited<ReturnType<Core["readNamespacedSecret"]>>;
type Revision = Pick<
  AgentRevision,
  "id" | "namespaceId" | "agentId" | "revision" | "compute" | "harness" | "plugins"
>;
const installationId = "installation-test";
const metadataKey = "retirement-state.json";
const marker = "openclaw.dev/public-read-state-version";
const status = (statusCode: number) =>
  Object.assign(new Error(`Kubernetes ${statusCode}`), { statusCode });

function revision(ordinal: number, pin: string | null = "plugin-codex"): Revision {
  return {
    id: `revision-${ordinal}`,
    namespaceId: "namespace-test",
    agentId: "agent-test",
    revision: ordinal,
    compute: { id: "compute-test", implementation: "kubernetes-local" },
    harness: { id: "codex", mode: "dedicated", version: "1.0.0", overrides: {}, configuration: {} },
    ...(pin === null
      ? {}
      : { plugins: { driver: { id: pin, implementation: "occ/codex-plugin" }, plugins: {} } }),
  };
}

// Only the Kubernetes storage transport is controlled. Store validation,
// publication, CAS retry and reader authorization run in their real owners.
function fixture() {
  let object: ConfigMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "authorizations",
      namespace: "reader",
      uid: "registry-uid",
      resourceVersion: "1",
      labels: {
        "openclaw.dev/public-read-installation": createHash("sha256")
          .update(installationId)
          .digest("hex")
          .slice(0, 32),
      },
    },
    data: { "authorizations.json": "{}\n" },
  };
  const secrets = new Map<string, Secret>();
  let beforeReplace: (() => Promise<void>) | undefined;
  let conflicts = 0;
  let replacements = 0;
  const core = {
    async readNamespacedConfigMap() {
      return structuredClone(object);
    },
    async replaceNamespacedConfigMap({ body }: { body: ConfigMap }) {
      replacements++;
      const hook = beforeReplace;
      beforeReplace = undefined;
      await hook?.();
      if (conflicts-- > 0 || body.metadata?.resourceVersion !== object.metadata?.resourceVersion) {
        throw status(409);
      }
      object = structuredClone(body);
      object.metadata!.resourceVersion = String(Number(object.metadata!.resourceVersion) + 1);
      return structuredClone(object);
    },
    async readNamespacedSecret({ namespace, name }: { namespace: string; name: string }) {
      const value = secrets.get(`${namespace}/${name}`);
      if (!value) {
        throw status(404);
      }
      return structuredClone(value);
    },
    async createNamespacedSecret({ namespace, body }: { namespace: string; body: Secret }) {
      const key = `${namespace}/${body.metadata!.name}`;
      if (secrets.has(key)) {
        throw status(409);
      }
      const value = structuredClone(body);
      value.metadata = { ...value.metadata, uid: `secret-${key}`, resourceVersion: "1" };
      secrets.set(key, value);
      return structuredClone(value);
    },
    async deleteNamespacedSecret({
      namespace,
      name,
      body,
    }: {
      namespace: string;
      name: string;
      body: { preconditions: { uid: string; resourceVersion: string } };
    }) {
      const key = `${namespace}/${name}`;
      const value = secrets.get(key);
      if (!value) {
        throw status(404);
      }
      if (
        value.metadata!.uid !== body.preconditions.uid ||
        value.metadata!.resourceVersion !== body.preconditions.resourceVersion
      ) {
        throw status(409);
      }
      secrets.delete(key);
    },
  } as unknown as Core;
  const options = {
    core,
    namespace: "reader",
    configMapName: "authorizations",
    installationId,
    driverId: "compute-test",
  };
  return {
    store: () => new KubernetesPublicGithubReadAuthorizationStore(options),
    options,
    secrets,
    get object() {
      return object;
    },
    entries: () => JSON.parse(object.data!["authorizations.json"]!),
    dataBytes: () =>
      Buffer.byteLength(JSON.stringify({ data: object.data, binaryData: object.binaryData })),
    set beforeReplace(hook: () => Promise<void>) {
      beforeReplace = hook;
    },
    set conflicts(value: number) {
      conflicts = value;
    },
    get replacements() {
      return replacements;
    },
  };
}

test("retired public-reader revision churn keeps large-policy storage bounded and admits a new grant", async () => {
  const f = fixture();
  const store = f.store();
  const policy = {
    mode: "repositories" as const,
    repositories: Array.from({ length: 256 }, (_, n) => `example/${"a".repeat(90)}-${n}`).sort(),
  };
  const active = revision(1);
  const initial = await store.prepare(active, "runtime", policy);
  let checkpoint = 0;
  for (let n = 2; n <= 400; n++) {
    const retired = revision(n);
    await store.prepare(retired, "runtime", policy);
    await store.withdraw(retired);
    await store.retireCapability(retired, "runtime");
    if (n === 16) {
      checkpoint = f.dataBytes();
    }
  }
  assert.ok(
    f.dataBytes() <= checkpoint + 128,
    "retired repository lists must not accumulate per revision",
  );
  assert.ok(f.dataBytes() < 64 * 1024);
  assert.deepEqual(Object.keys(f.entries()), [active.id]);
  assert.equal((await f.store().prepare(active, "runtime", policy)).capability, initial.capability);
  const next = revision(401);
  await f.store().prepare(next, "runtime", policy);
  assert.deepEqual(f.entries()[next.id].policy, policy);
  assert.equal(f.secrets.size, 2, "the preserved retirement API removes only retired capabilities");
  await assert.rejects(
    f.store().prepare(revision(200), "runtime", policy),
    /withdrawn|retired|frozen/,
  );
  assert.equal(f.secrets.size, 2, "cold denial must not recreate a retired capability");
});

test("retirement frontiers preserve suspended old grants and separate exact admission lineages", async () => {
  const f = fixture();
  const store = f.store();
  const old = revision(1);
  const policy = { mode: "all" as const };
  const initial = await store.prepare(old, "runtime", policy);
  await store.suspend(old);
  await store.withdraw(revision(10));
  const restarted = f.store();
  assert.equal((await restarted.prepare(old, "runtime", policy)).capability, initial.capability);
  await assert.rejects(
    restarted.prepare(revision(5), "runtime", policy),
    /withdrawn|retired|frozen/,
  );
  await restarted.prepare(
    { ...revision(5, "other-plugin"), id: "other-pin-revision" },
    "runtime",
    policy,
  );
  await restarted.prepare({ ...revision(5, null), id: "unpinned-revision" }, "runtime", policy);
  const otherCompute = {
    ...revision(5),
    id: "other-compute-revision",
    compute: { id: "other-compute", implementation: "kubernetes-local" },
  };
  await new KubernetesPublicGithubReadAuthorizationStore({
    ...f.options,
    driverId: "other-compute",
  }).prepare(otherCompute, "runtime", policy);
  for (const wrong of [
    { ...old, revision: 2 },
    { ...old, agentId: "foreign-agent" },
    { ...old, plugins: revision(1, "other-plugin").plugins! },
  ]) {
    await assert.rejects(
      restarted.prepare(wrong, "runtime", policy),
      /identity|ordinal|lineage|different|frozen/,
    );
  }
  for (const wrong of [
    { ...revision(20), revision: 0 },
    { ...revision(20), revision: 1.5 },
    { ...revision(20), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...revision(20), compute: { id: "foreign", implementation: "kubernetes-local" } },
    { ...revision(20), compute: { id: "compute-test", implementation: "" } },
    {
      ...revision(20),
      harness: {
        id: "codex",
        mode: "embedded" as const,
        version: "1.0.0",
        overrides: {},
        configuration: {},
      },
    },
  ]) {
    const before = f.replacements;
    await assert.rejects(
      restarted.prepare(wrong, "runtime", policy),
      /identity|ordinal|lineage|revision|Compute|Harness/,
    );
    assert.equal(f.replacements, before);
  }
});

test("authorization CAS races cannot restore a retired revision or overwrite another lineage", async () => {
  const f = fixture();
  const old = revision(1);
  await f.store().prepare(old, "runtime", { mode: "all" });
  await f.store().suspend(old);
  f.beforeReplace = async () => {
    await f.store().withdraw(old);
    await f.store().withdraw({ ...revision(9, "other-plugin"), id: "other-retired" });
  };
  await assert.rejects(
    f.store().prepare(old, "runtime", { mode: "all" }),
    /withdrawn|retired|frozen/,
  );
  assert.equal(f.entries()[old.id], undefined);
  await assert.rejects(
    f
      .store()
      .prepare({ ...revision(4, "other-plugin"), id: "other-old" }, "runtime", { mode: "all" }),
    /withdrawn|retired|frozen/,
  );
  const before = f.replacements;
  f.conflicts = 10;
  await assert.rejects(
    f.store().prepare(revision(20), "runtime", { mode: "all" }),
    /changed repeatedly/,
  );
  assert.equal(f.replacements - before, 10);
});

test("legacy grants migrate atomically while exact withdrawn identities remain denied", async () => {
  const f = fixture();
  const live = revision(1);
  const material = await f.store().prepare(live, "runtime", { mode: "all" });
  const legacy = structuredClone(f.entries()[live.id]);
  const dead = {
    ...legacy,
    revisionId: "legacy-retired",
    withdrawn: true,
    validUntil: "1970-01-01T00:00:00.000Z",
  };
  f.object.metadata!.annotations = {};
  f.object.data = {
    "authorizations.json": JSON.stringify({ [live.id]: legacy, [dead.revisionId]: dead }) + "\n",
  };
  await f.store().withdraw(revision(10));
  assert.equal(f.object.metadata!.annotations![marker], "1");
  assert.ok(f.object.data![metadataKey]);
  assert.equal(f.entries()[dead.revisionId], undefined);
  assert.deepEqual(f.entries()[live.id], legacy);
  assert.equal(
    (await f.store().prepare(live, "runtime", { mode: "all" })).capability,
    material.capability,
  );
  await assert.rejects(
    f.store().prepare({ ...revision(30), id: dead.revisionId }, "runtime", { mode: "all" }),
    /withdrawn|retired|frozen/,
  );
  await assert.rejects(
    f.store().prepare({ ...revision(30), id: dead.revisionId, agentId: "foreign" }, "runtime", {
      mode: "all",
    }),
    /identity|different|withdrawn|retired/,
  );
});

test("retirement metadata and combined ConfigMap capacity fail closed before publication", async () => {
  const source = fixture();
  await source.store().prepare(revision(1), "runtime", { mode: "all" });
  const original = structuredClone(source.object);
  for (const corrupt of [
    (object: ConfigMap) => {
      delete object.data![metadataKey];
    },
    (object: ConfigMap) => {
      object.metadata!.annotations![marker] = "2";
    },
    (object: ConfigMap) => {
      object.data![metadataKey] = JSON.stringify({ version: 2 });
    },
    (object: ConfigMap) => {
      object.data![metadataKey] = "{}";
    },
    (object: ConfigMap) => {
      object.data![metadataKey] = "not-json";
    },
    (object: ConfigMap) => {
      const state = JSON.parse(object.data![metadataKey]!);
      state.bindings = {};
      object.data![metadataKey] = JSON.stringify(state);
    },
    (object: ConfigMap) => {
      const state = JSON.parse(object.data![metadataKey]!);
      state.frontiers = {};
      object.data![metadataKey] = JSON.stringify(state);
    },
  ]) {
    Object.assign(source.object, structuredClone(original));
    corrupt(source.object);
    const before = source.replacements;
    await assert.rejects(
      source.store().prepare(revision(2), "runtime", { mode: "all" }),
      /retirement|metadata|registry/,
    );
    assert.equal(source.replacements, before);
  }
  const full = fixture();
  full.object.data!["operator-data"] = "x".repeat(1024 * 1024 - 1000);
  full.object.binaryData = { "operator-binary": Buffer.alloc(2048).toString("base64") };
  await assert.rejects(
    full.store().prepare(revision(1), "runtime", { mode: "all" }),
    /full|limit|unavailable/,
  );
  assert.equal(full.replacements, 0);
  const noReservation = fixture();
  noReservation.object.data!["operator-data"] = "x".repeat(1024 * 1024 - 400);
  assert.ok(noReservation.dataBytes() < 1024 * 1024);
  await assert.rejects(
    noReservation.store().prepare(revision(1), "runtime", { mode: "all" }),
    /full|limit/,
  );
  assert.equal(
    noReservation.replacements,
    0,
    "the grant and its retirement metadata must fit atomically",
  );
});

test("the real reader observes compacted withdrawal and cold restart without resurrecting its bearer", async (t) => {
  const f = fixture();
  const retired = revision(1);
  const policy = { mode: "repositories" as const, repositories: ["example/project"] };
  const material = await f.store().prepare(retired, "runtime", policy);
  const server = createPublicGithubReadServer({
    policy: { mode: "all" },
    loadAuthorizations: f.entries,
  });
  const port = await listen(t, server);
  const base = `http://127.0.0.1:${port}`;
  const health = () => fetch(`${base}/healthz?revision=${retired.id}`).then((r) => r.json());
  assert.equal(
    (await health()).revisionAuthorizationDigest,
    publicGithubReadAuthorizationDigest(f.entries()[retired.id]),
  );
  const outsideScope = "/git/example/other.git/info/refs?service=git-upload-pack";
  const scoped = await fetch(base + outsideScope, {
    headers: { authorization: `Bearer ${material.capability}` },
  });
  assert.equal(
    scoped.status,
    403,
    "the reader recognizes the live bearer and enforces its scope before provider IO",
  );
  await f.store().withdraw(retired);
  await f.store().retireCapability(retired, "runtime");
  assert.equal(
    (await health()).revisionAuthorizationDigest,
    publicGithubReadAuthorizationDigest(undefined),
  );
  const denied = await fetch(`${base}/git/example/project.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${material.capability}` },
  });
  assert.equal(denied.status, 401);
  await assert.rejects(f.store().prepare(retired, "runtime", policy), /withdrawn|retired|frozen/);
  assert.equal(f.secrets.size, 0);
  const restarted = createPublicGithubReadServer({
    policy: { mode: "all" },
    loadAuthorizations: f.entries,
  });
  const restartedPort = await listen(t, restarted);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${restartedPort}` + outsideScope, {
        headers: { authorization: `Bearer ${material.capability}` },
      })
    ).status,
    401,
    "cold reader restart must not restore the retired bearer",
  );
});
