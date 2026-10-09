import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryMaterialStore } from "../../apps/controller/src/drivers/compute/kubernetes/repository-material-store.ts";
import { repositoryMaterialSpec } from "../../apps/controller/src/drivers/compute/kubernetes/repository-material.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";

const now = 1800000000000;
const origin = "https://credentials.example.test";
const client = {
  gatewayOrigin: origin,
  gitRemote: `${origin}/example/project.git`,
  gitUsername: "gateway-session",
  canonicalApiHost: "github.com",
  apiHost: "credentials.example.test",
  repository: "example/project",
};
const revision = (refs, deadline) => ({
  id: "rev-material-expiry",
  namespaceId: "namespace-material-expiry",
  agentId: "agent-material-expiry",
  repositoryCredentials: {
    deadlineWallMs: deadline,
    bindings: refs.map((repositoryRef) => ({ repositoryRef })),
  },
});
function binding(repositoryRef, sessionId, deadlineWallMs) {
  return {
    kind: "new",
    repositoryRef,
    sessionId,
    deadlineWallMs,
    files: encodeRepositoryCredentialSessionFiles({
      session: { sessionId, deadlineWallMs },
      bearer: "synthetic_material_bearer_0123456789abcdef0123456789abcdef",
      client,
    }),
  };
}
function fakeCore() {
  const objects = new Map();
  const created = [];
  const reads = [];
  let onRead = () => {};
  let onCreate = () => {};
  const core = {
    async readNamespacedSecret({ name }) {
      reads.push(name);
      onRead(name);
      if (!objects.has(name)) {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      }
      return structuredClone(objects.get(name));
    },
    async createNamespacedSecret({ body }) {
      const record = structuredClone(body);
      record.metadata.uid = `uid-${created.length}`;
      objects.set(record.metadata.name, record);
      created.push(record.metadata.name);
      onCreate(record);
      return structuredClone(record);
    },
    async listNamespacedSecret() {
      return { items: [...objects.values()].map((v) => structuredClone(v)) };
    },
    async deleteNamespacedSecret({ name, body }) {
      assert.equal(objects.get(name)?.metadata.uid, body.preconditions.uid);
      objects.delete(name);
    },
  };
  return {
    core,
    created,
    objects,
    reads,
    onRead(fn) {
      onRead = fn;
    },
    onCreate(fn) {
      onCreate = fn;
    },
  };
}

test("expiry during Secret read refuses to create material", async (t) => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const end = now + 1000;
  const input = binding("project", "session_one", end);
  const owner = revision([input.repositoryRef], end);
  const spec = repositoryMaterialSpec(owner, [input]);
  const fake = fakeCore();
  fake.onRead(() => {
    clock = end;
  });
  const store = new RepositoryMaterialStore("namespace-material-expiry", fake.core, (op) => op());
  let result;
  try {
    result = await store.prepare(owner, spec);
  } catch (error) {
    result = error;
  }
  assert.equal(fake.reads.length, 1);
  assert.equal(
    fake.created.length,
    0,
    "expired material must never be created after a read returns",
  );
  assert.equal(result?.message, "Repository credential material has expired.");
});

test("earliest expiry during first creation prevents the next creation and leaves cleanup possible", async (t) => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const first = binding("alpha", "session_alpha", now + 2000);
  const second = binding("zeta", "session_zeta", now + 1000);
  const owner = revision([first.repositoryRef, second.repositoryRef], first.deadlineWallMs);
  const spec = repositoryMaterialSpec(owner, [first, second]);
  const fake = fakeCore();
  fake.onCreate(() => {
    clock = second.deadlineWallMs;
  });
  const store = new RepositoryMaterialStore("namespace-material-expiry", fake.core, (op) => op());
  let result;
  try {
    result = await store.prepare(owner, spec);
  } catch (error) {
    result = error;
  }
  const created = fake.created.length;
  const cleanup = await store.cleanup(
    { namespaceId: owner.namespaceId, agentId: owner.agentId, revisionId: owner.id },
    new Set(),
  );
  assert.equal(created, 1, "do not create another Secret once any original session has expired");
  assert.equal(result?.message, "Repository credential material has expired.");
  assert.equal(cleanup, true);
  assert.equal(fake.objects.size, 0);
});

// Creates material for one session that expires a second after `now` and returns
// the spec that retains it.
async function retainedSession() {
  const input = binding("project", "session_one", now + 1000);
  const owner = revision([input.repositoryRef], input.deadlineWallMs);
  const fake = fakeCore();
  const store = new RepositoryMaterialStore("namespace-material-expiry", fake.core, (op) => op());
  const first = await store.prepare(owner, repositoryMaterialSpec(owner, [input]));
  const { repositoryRef, sessionId, deadlineWallMs } = input;
  const spec = repositoryMaterialSpec(owner, [
    { kind: "retained", repositoryRef, sessionId, deadlineWallMs },
  ]);
  return { input, owner, fake, store, first, spec };
}

test("unexpired material is created and the retained session is reused", async (t) => {
  t.mock.method(Date, "now", () => now);
  const { input, owner, fake, store, first, spec } = await retainedSession();
  assert.equal(first.kind, "ready");
  const result = await store.prepare(owner, spec);
  assert.equal(result.kind, "ready");
  assert.equal(result.spec.bindings[0].sessionId, input.sessionId);
  assert.equal(fake.created.length, 1);
});

test("expiry during retained Secret read is not reported as missing material", async (t) => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const { input, owner, fake, store, spec } = await retainedSession();
  fake.onRead(() => {
    clock = input.deadlineWallMs;
  });
  await assert.rejects(store.prepare(owner, spec), {
    message: "Repository credential material has expired.",
  });
  assert.equal(fake.created.length, 1);
});

test("expiry during retained Secret validation is not reported as missing material", async (t) => {
  let validating = false;
  let observations = 0;
  t.mock.method(Date, "now", () => (validating && ++observations > 1 ? now + 1000 : now));
  const { owner, fake, store, spec } = await retainedSession();
  fake.onRead(() => {
    validating = true;
  });
  await assert.rejects(store.prepare(owner, spec), {
    message: "Repository credential material has expired.",
  });
  assert.equal(fake.created.length, 1);
});
