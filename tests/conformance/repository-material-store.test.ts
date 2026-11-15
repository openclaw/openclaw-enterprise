import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { RepositoryMaterialStore } from "../../apps/controller/src/drivers/compute/kubernetes/repository-material-store.ts";
import { repositoryMaterialSpec } from "../../apps/controller/src/drivers/compute/kubernetes/repository-material.ts";
import { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import type { RepositoryCredentialClientConfiguration } from "../../apps/controller/src/drivers/repo/access/client-contracts.ts";
import type { SessionStatus } from "../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/access/client/config.ts";
import { repositoryCleanupFailureCode } from "../../apps/controller/src/worker/repository-credentials.ts";
import type {
  AgentRevision,
  RepositoryCredentialRuntimeBinding,
} from "../../packages/contracts/src/index.ts";
import { repositoryClientData } from "../fixtures/repository-credentials/builders.mjs";
import { writeSafeKubeconfig } from "../helpers/unsafe-kubeconfigs.mjs";

type Core = ConstructorParameters<typeof RepositoryMaterialStore>[1];
type SecretOperations = Pick<
  Core,
  | "readNamespacedSecret"
  | "createNamespacedSecret"
  | "listNamespacedSecret"
  | "deleteNamespacedSecret"
>;
type Secret = Awaited<ReturnType<Core["readNamespacedSecret"]>>;
type NewBinding = Extract<RepositoryCredentialRuntimeBinding, { kind: "new" }>;
const grant = { providerInstanceId: "github-main", repositoryId: "project", grantId: "read" };
const now = 1800000000000;
const client: RepositoryCredentialClientConfiguration = repositoryClientData();
const revision = (refs: readonly string[], deadline: number): AgentRevision => ({
  id: "rev-material-expiry",
  namespaceId: "namespace-material-expiry",
  agentId: "agent-material-expiry",
  revision: 1,
  backendId: null,
  configurationId: "configuration-material",
  configurationKind: "agent",
  configurationGeneration: 1,
  configuration: {
    agents: { defaults: { model: "codex/fixture" } },
    models: {
      providers: {
        codex: {
          baseUrl: "http://127.0.0.1:9",
          api: "openai-responses",
          models: [{ id: "fixture", name: "fixture" }],
        },
      },
    },
  },
  gatewayManagedMode: false,
  harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
  compute: { id: "kubernetes", implementation: "kubernetes" },
  harnessAuth: { method: "runtime" },
  servicePrincipalId: "service-principal-material",
  createdAt: new Date(now).toISOString(),
  executionAdmission: { version: 2, mode: "unprotected" },
  repositoryCredentials: {
    driver: { id: "repository-credentials", implementation: "repository-credentials" },
    deadlineWallMs: deadline,
    bindings: refs.map((repositoryRef) => ({
      repositoryRef,
      profile: "read",
      backendId: "github",
      grant,
    })),
  },
});
function binding(repositoryRef: string, sessionId: string, deadlineWallMs: number): NewBinding {
  const session: SessionStatus = {
    sessionId,
    deadlineWallMs,
    state: "OPEN",
    binding: grant,
    activeUses: 0,
    cleanup: {
      active: 0,
      pending: 0,
      revoked: 0,
      expired: 0,
      uncertain: 0,
      auxiliaryPending: false,
    },
  };
  return {
    kind: "new",
    repositoryRef,
    sessionId,
    deadlineWallMs,
    files: encodeRepositoryCredentialSessionFiles({
      session,
      bearer: "synthetic_material_bearer_0123456789abcdef0123456789abcdef",
      client,
    }),
  };
}
async function fakeCore(t: TestContext) {
  const { kubeconfigPath, context }: { kubeconfigPath: string; context: unknown } =
    await writeSafeKubeconfig(t);
  assert.ok(typeof context === "string");
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    { mode: "kubeconfig", kubeconfigPath, context },
    (message) => new Error(message),
  );
  const objects = new Map<string, Secret>();
  const created: string[] = [];
  const reads: string[] = [];
  let onRead: (name: string) => void = () => {};
  let onCreate: (record: Secret) => void = () => {};
  const secretOperations: SecretOperations = {
    async readNamespacedSecret({ name }) {
      reads.push(name);
      onRead(name);
      const object = objects.get(name);
      if (object === undefined) {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      }
      return structuredClone(object);
    },
    async createNamespacedSecret({ body }) {
      const record = structuredClone(body);
      assert.ok(record.metadata?.name);
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
      const uid = objects.get(name)?.metadata?.uid;
      assert.ok(uid, "the Secret must exist and have a Kubernetes UID");
      assert.equal(body?.preconditions?.uid, uid);
      objects.delete(name);
      return {};
    },
  };
  return {
    core: Object.assign(new sdk.CoreV1Api(clientConfiguration), secretOperations),
    created,
    objects,
    reads,
    onRead(fn: typeof onRead) {
      onRead = fn;
    },
    onCreate(fn: typeof onCreate) {
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
  assert.ok(spec);
  const fake = await fakeCore(t);
  fake.onRead(() => {
    clock = end;
  });
  const store = new RepositoryMaterialStore("namespace-material-expiry", fake.core, (op) => op());
  await assert.rejects(store.prepare(owner, spec), {
    message: "Repository credential material has expired.",
  });
  assert.equal(fake.reads.length, 1);
  assert.equal(
    fake.created.length,
    0,
    "expired material must never be created after a read returns",
  );
});

test("earliest expiry during first creation prevents the next creation and leaves cleanup possible", async (t) => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const first = binding("alpha", "session_alpha", now + 2000);
  const second = binding("zeta", "session_zeta", now + 1000);
  const owner = revision([first.repositoryRef, second.repositoryRef], first.deadlineWallMs);
  const spec = repositoryMaterialSpec(owner, [first, second]);
  assert.ok(spec);
  const fake = await fakeCore(t);
  fake.onCreate(() => {
    clock = second.deadlineWallMs;
  });
  const store = new RepositoryMaterialStore("namespace-material-expiry", fake.core, (op) => op());
  await assert.rejects(store.prepare(owner, spec), {
    message: "Repository credential material has expired.",
  });
  const created = fake.created.length;
  const cleanup = await store.cleanup(
    { namespaceId: owner.namespaceId, agentId: owner.agentId, revisionId: owner.id },
    new Set(),
  );
  assert.equal(created, 1, "do not create another Secret once any original session has expired");
  assert.equal(cleanup, true);
  assert.equal(fake.objects.size, 0);
});

// Creates material for one session that expires a second after `now` and returns
// the spec that retains it.
async function retainedSession(t: TestContext) {
  const input = binding("project", "session_one", now + 1000);
  const owner = revision([input.repositoryRef], input.deadlineWallMs);
  const fake = await fakeCore(t);
  const store = new RepositoryMaterialStore("namespace-material-expiry", fake.core, (op) => op());
  const initial = repositoryMaterialSpec(owner, [input]);
  assert.ok(initial);
  const first = await store.prepare(owner, initial);
  const { repositoryRef, sessionId, deadlineWallMs } = input;
  const spec = repositoryMaterialSpec(owner, [
    { kind: "retained", repositoryRef, sessionId, deadlineWallMs },
  ]);
  assert.ok(spec);
  return { input, owner, fake, store, first, spec };
}

test("unexpired material is created and the retained session is reused", async (t) => {
  t.mock.method(Date, "now", () => now);
  const { input, owner, fake, store, first, spec } = await retainedSession(t);
  assert.equal(first.kind, "ready");
  const result = await store.prepare(owner, spec);
  assert.equal(result.kind, "ready");
  const [retained] = result.spec.bindings;
  assert.ok(retained);
  assert.equal(retained.sessionId, input.sessionId);
  assert.equal(fake.created.length, 1);
});

test("expiry during retained Secret read is not reported as missing material", async (t) => {
  let clock = now;
  t.mock.method(Date, "now", () => clock);
  const { input, owner, fake, store, spec } = await retainedSession(t);
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
  const { owner, fake, store, spec } = await retainedSession(t);
  fake.onRead(() => {
    validating = true;
  });
  await assert.rejects(store.prepare(owner, spec), {
    message: "Repository credential material has expired.",
  });
  assert.equal(fake.created.length, 1);
});

// The worker logs a stuck repository cleanup by its cause code. A store failure names its
// operation and an RBAC refusal, not the generic REPOSITORY_CLEANUP_FAILED, and never the
// Kubernetes response text, which may carry a Secret body (finding 2201).
test("material cleanup failures carry the stable code the worker logs", async (t) => {
  const failures: readonly (readonly [number, string])[] = [
    [403, "REPOSITORY_MATERIAL_LIST_FORBIDDEN"],
    [503, "REPOSITORY_MATERIAL_LIST_FAILED"],
  ];
  for (const [statusCode, code] of failures) {
    const fake = await fakeCore(t);
    fake.core.listNamespacedSecret = async () => {
      throw Object.assign(new Error("synthetic response with a Secret body"), { statusCode });
    };
    const store = new RepositoryMaterialStore("namespace-material-expiry", fake.core, (op) => op());
    const error = await store.cleanup({ namespaceId: "namespace-material-expiry" }, new Set()).then(
      () => assert.fail("cleanup must fail"),
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      "Repository credential material cleanup could not list owned objects.",
    );
    const cause: unknown = error.cause;
    assert.equal(cause, undefined);
    assert.equal(repositoryCleanupFailureCode(error), code);
  }
});
