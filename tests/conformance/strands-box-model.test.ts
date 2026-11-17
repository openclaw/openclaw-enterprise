import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { pathToFileURL } from "node:url";
import type { ModelHost } from "../../deploy/examples/strands-box/driver/model-gateway.ts";
import { wiringConfiguration as hostWiring } from "../../deploy/examples/strands-box/host/control.ts";
import {
  checkedAnswer,
  CredentialSourceRelay,
  MODEL_MAX_BODY_BYTES,
  parseModelRequest,
} from "../../deploy/examples/strands-box/host/credential-source.ts";
import { modelCredentials } from "../../deploy/examples/strands-box/host/egress.ts";
import type {
  AgentRevision,
  CredentialSource,
} from "../../packages/contracts/src/index.ts";
import {
  askSource,
  boxModelRequest,
  fakeKubernetesSecrets,
  MODEL_SECRET_NAMESPACE,
  testModelKey,
} from "../helpers/strands-box-model-fixture.ts";
import {
  activateStageB,
  id,
  implementation,
  installPackage,
  MODEL_ROUTE,
  MODEL_SOURCE_ID,
  modelSource,
  namespace,
  pairedFixture,
} from "../helpers/strands-box-protected-fixture.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

// The protected Strands Box model route (finding 3291, design note option O1): the paired
// package's Credential Gateway view keeps the model key in its own Secret, Box asks the host's
// second request-time source for each `POST <route>/responses`, the host relays the target only,
// and the Worker answers from the Secret. No Box here; the Box-native cases run in the manual
// strands-box-native lane (strands-box-model-native.test.ts).

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const MODEL_SOURCE_TYPE = "openai";
const modelAttachmentRef = (sourceId: string) => `strands-box-model:${sourceId}`;
const modelSecretName = (namespaceId: string, sourceId: string) =>
  `strands-box-model-${sha(`${namespaceId}\0${sourceId}`).slice(0, 40)}`;
const valueDigest = sha;

type GatewayModule = typeof import("../../deploy/examples/strands-box/driver/model-gateway.ts");

/** The installed package's own model Gateway module, built as `driver/README.md` says. */
async function gatewayModule(t: TestContext): Promise<GatewayModule> {
  const { dist } = await installPackage(t);
  return (await import(pathToFileURL(join(dist, "model-gateway.js")).href)) as GatewayModule;
}
const requestId = () => randomBytes(16).toString("hex");

function source(overrides: Partial<CredentialSource> = {}): CredentialSource {
  return {
    id: MODEL_SOURCE_ID,
    namespaceId: namespace.id,
    name: "model",
    type: MODEL_SOURCE_TYPE,
    driverId: id,
    config: { authorized_base_url: MODEL_ROUTE },
    createdAt: namespace.createdAt,
    updatedAt: namespace.createdAt,
    ...overrides,
  } as unknown as CredentialSource;
}

function modelRevision(overrides: Record<string, unknown> = {}): AgentRevision {
  return {
    id: "rev_pilot",
    namespaceId: namespace.id,
    harness: {
      id: "codex",
      mode: "dedicated",
      configuration: { modelProvider: { id: "openai", baseUrl: MODEL_ROUTE } },
    },
    harnessAuth: modelSource,
    ...overrides,
  } as unknown as AgentRevision;
}

async function gatewayFixture(t: TestContext) {
  const { createModelGateway, ModelKeyStore, modelSourceType } = await gatewayModule(t);
  const kube = await fakeKubernetesSecrets(t);
  const store = new ModelKeyStore(kube.configuration);
  const live = {
    attachment: undefined as { sourceId: string; revoked: boolean } | undefined,
    receipt: "receipt-1" as string | undefined,
    revokes: 0,
  };
  const host: ModelHost = {
    async attachment() {
      return live.attachment;
    },
    async revoke(_revisionId, sourceId) {
      live.revokes++;
      if (live.attachment?.sourceId !== sourceId || live.receipt === undefined) return undefined;
      live.attachment = { sourceId, revoked: true };
      return { receiptId: live.receipt };
    },
  };
  const gateway = createModelGateway(id, implementation, MODEL_ROUTE, store, host);
  const signal = AbortSignal.timeout(20_000);
  const context = (overrides: Partial<CredentialSource> = {}) => ({
    namespace,
    source: source(overrides),
    signal,
  });
  return { kube, store, live, gateway, signal, context, modelSourceType };
}

test("the package's model Gateway keeps each source's key in its own Secret and never shows it", async (t) => {
  const { kube, gateway, context, signal, modelSourceType } = await gatewayFixture(t);
  assert.deepEqual(await gateway.listSourceTypes({ signal }), [modelSourceType]);
  assert.deepEqual(modelSourceType.harnessAuth, { modelProvider: "openai", loginMode: "api_key" });
  assert.deepEqual(
    modelSourceType.secrets.map((field) => field.name),
    ["api_key"],
  );
  // Only the model type, only the configured route.
  const config = { authorized_base_url: MODEL_ROUTE };
  assert.deepEqual(gateway.validateSourceConfig({ type: MODEL_SOURCE_TYPE, config }), config);
  assert.deepEqual(
    gateway.validateSourceConfig({
      type: MODEL_SOURCE_TYPE,
      config: { authorized_base_url: `${MODEL_ROUTE}/` },
    }),
    config,
  );
  for (const refused of [
    { type: "anthropic", config },
    { type: MODEL_SOURCE_TYPE, config: {} },
    { type: MODEL_SOURCE_TYPE, config: { authorized_base_url: "https://10.0.0.8:8444/v1" } },
    { type: MODEL_SOURCE_TYPE, config: { authorized_base_url: "http://10.0.0.9:8444/v1" } },
    { type: MODEL_SOURCE_TYPE, config: { ...config, extra: "x" } },
  ]) {
    assert.throws(() => gateway.validateSourceConfig(refused), /model source type|authorized_base_url/);
  }

  // Register: one named Secret per source, labelled and annotated with its owner.
  const key = testModelKey();
  const name = modelSecretName(namespace.id, MODEL_SOURCE_ID);
  assert.deepEqual(
    await gateway.registerSource(context(), { type: MODEL_SOURCE_TYPE, config, secrets: { api_key: key } }),
    { state: "ready" },
  );
  const stored = kube.secrets.get(name)!;
  assert.equal(kube.value(name), key);
  assert.deepEqual(stored.metadata.labels, { "app.kubernetes.io/managed-by": "openclaw-strands-box" });
  assert.deepEqual(stored.metadata.annotations, {
    "openclaw.dev/credential-source-id": MODEL_SOURCE_ID,
    "openclaw.dev/namespace-id": namespace.id,
  });
  assert.match(name, /^strands-box-model-[0-9a-f]{40}$/);
  assert.equal(JSON.stringify(stored.metadata).includes(key), false);
  assert.deepEqual(await gateway.sourceStatus(context()), { state: "ready" });
  // A second source gets a second Secret; a different Namespace's same ID another one.
  const other = testModelKey();
  await gateway.registerSource(context({ id: "cs_other" }), {
    type: MODEL_SOURCE_TYPE,
    config,
    secrets: { api_key: other },
  });
  assert.notEqual(modelSecretName(namespace.id, "cs_other"), name);
  assert.notEqual(modelSecretName("ns_other", MODEL_SOURCE_ID), name);
  assert.equal(kube.secrets.size, 2);

  // Refusals never carry a value: a malformed key, another Gateway's source, an API failure.
  const malformed = `${key} with spaces`;
  await assert.rejects(
    gateway.registerSource(context({ id: "cs_bad" }), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: malformed },
    }),
    (error: Error) => !error.message.includes(key) && /printable/.test(error.message),
  );
  await assert.rejects(
    gateway.registerSource(context({ id: "cs_foreign", driverId: "openshell" } as never), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: key },
    }),
    /not owned by this gateway/,
  );
  kube.failNext(500);
  await assert.rejects(
    gateway.registerSource(context({ id: "cs_fail" }), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: key },
    }),
    (error: Error) => !error.message.includes(key) && /Kubernetes API refused/.test(error.message),
  );

  // Rotation replaces the value in place (resourceVersion checked); an absent source stays absent.
  const version = stored.metadata.resourceVersion;
  const rotated = testModelKey();
  assert.deepEqual(
    await gateway.updateSource(context(), { type: MODEL_SOURCE_TYPE, config, secrets: { api_key: rotated } }),
    { state: "ready" },
  );
  assert.equal(kube.value(name), rotated);
  assert.notEqual(kube.secrets.get(name)!.metadata.resourceVersion, version);
  assert.deepEqual(
    await gateway.updateSource(context({ id: "cs_missing" }), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: rotated },
    }),
    { state: "absent" },
  );

  // A Secret under this name that another source owns is never read as this source's key or
  // overwritten by a register replay.
  const foreignName = modelSecretName(namespace.id, "cs_taken");
  kube.secrets.set(foreignName, {
    metadata: {
      name: foreignName,
      resourceVersion: "1",
      annotations: { "openclaw.dev/credential-source-id": "cs_someone", "openclaw.dev/namespace-id": namespace.id },
    },
    data: { api_key: Buffer.from("foreign").toString("base64") },
  });
  assert.equal((await gateway.sourceStatus(context({ id: "cs_taken" }))).state, "failed");
  await assert.rejects(
    gateway.registerSource(context({ id: "cs_taken" }), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: key },
    }),
    /not owned by this source/,
  );
  assert.equal(kube.value(foreignName), "foreign");

  // Removal deletes exactly this source's Secret, verified, and is idempotent.
  await gateway.removeSource(context());
  assert.equal(kube.secrets.has(name), false);
  await gateway.removeSource(context());
  assert.deepEqual(await gateway.sourceStatus(context()), { state: "absent" });
  assert.equal(kube.value(modelSecretName(namespace.id, "cs_other")), other);

  // Least privilege: only get, create, update and delete on Secrets in the one namespace.
  const verbs = new Set(kube.calls.map((call) => call.split(" ")[0]));
  assert.deepEqual([...verbs].sort(), ["DELETE", "GET", "POST", "PUT"]);
  assert.ok(kube.calls.every((call) => call.split(" ")[1] === MODEL_SECRET_NAMESPACE));
});

test("the model Gateway attaches exactly the dedicated Codex source for its route and withdraws only on the host's receipt", async (t) => {
  const { gateway, live, context, signal } = await gatewayFixture(t);
  const key = testModelKey();
  const config = { authorized_base_url: MODEL_ROUTE };
  await gateway.registerSource(context(), { type: MODEL_SOURCE_TYPE, config, secrets: { api_key: key } });
  const attach = (revision = modelRevision(), sources = [source()]) =>
    gateway.attachForRevision({ namespace, revision, sources, signal });
  assert.deepEqual(await attach(), [
    { sourceId: MODEL_SOURCE_ID, ref: modelAttachmentRef(MODEL_SOURCE_ID) },
  ]);
  assert.equal(JSON.stringify(await attach()).includes(key), false);
  for (const [revision, sources] of [
    [modelRevision(), [source(), source({ id: "cs_two" })]],
    [modelRevision(), [source({ driverId: "openshell" } as never)]],
    [modelRevision(), [source({ type: "anthropic" })]],
    [modelRevision(), [source({ config: { authorized_base_url: "https://10.0.0.8:8444/v1" } })]],
    [modelRevision({ harnessAuth: { ...modelSource, sourceId: "cs_two" } }), [source()]],
    [modelRevision({ harnessAuth: { method: "runtime" } }), [source()]],
    [
      modelRevision({
        harness: {
          id: "codex",
          mode: "dedicated",
          configuration: { modelProvider: { baseUrl: "https://10.0.0.8:8444/v1" } },
        },
      }),
      [source()],
    ],
    [
      modelRevision({
        harness: {
          id: "codex",
          mode: "shared",
          configuration: { modelProvider: { baseUrl: MODEL_ROUTE } },
        },
      }),
      [source()],
    ],
  ] as const) {
    await assert.rejects(attach(revision as AgentRevision, [...sources]), /attaches exactly/);
  }
  await assert.rejects(attach(modelRevision({ harnessAuth: { ...modelSource, sourceId: "cs_none" } }), [source({ id: "cs_none" })]), /no stored key/);

  // Status: pending until the host shows the execution with this attachment; then ready.
  const statuses = () =>
    gateway.attachmentStatus({ namespace, revision: modelRevision(), sources: [source()], signal });
  assert.deepEqual(await statuses(), [{ sourceId: MODEL_SOURCE_ID, state: "pending" }]);
  live.attachment = { sourceId: MODEL_SOURCE_ID, revoked: false };
  assert.deepEqual(await statuses(), [{ sourceId: MODEL_SOURCE_ID, state: "ready" }]);

  // Withdraw: absent without the execution; revoked only with the host's receipt.
  const withdrawal = {
    namespace,
    revision: modelRevision(),
    sandbox: { id: "box-execution" } as never,
    sourceId: MODEL_SOURCE_ID,
    signal,
  };
  live.receipt = undefined;
  assert.deepEqual(await gateway.withdraw(withdrawal), { sourceId: MODEL_SOURCE_ID, state: "pending" });
  live.receipt = "receipt-1";
  assert.deepEqual(await gateway.withdraw(withdrawal), { sourceId: MODEL_SOURCE_ID, state: "revoked" });
  assert.deepEqual(await statuses(), [{ sourceId: MODEL_SOURCE_ID, state: "revoked" }]);
  const revokes = live.revokes;
  assert.deepEqual(await gateway.withdraw(withdrawal), { sourceId: MODEL_SOURCE_ID, state: "revoked" });
  assert.equal(live.revokes, revokes, "an already revoked attachment is not revoked again");
  live.attachment = undefined;
  assert.deepEqual(await gateway.withdraw(withdrawal), { sourceId: MODEL_SOURCE_ID, state: "absent" });
  await gateway.removeSource(context());
  assert.deepEqual(await statuses(), [{ sourceId: MODEL_SOURCE_ID, state: "absent" }]);
});

test("the host's model source relays only the target of POST <route>/responses, never the prompt", async (t) => {
  const directory = await temporaryDirectory(t, "strands-model-source-");
  const socket = join(directory, "model.sock");
  const bearer = randomBytes(32).toString("base64url");
  let active = true;
  let revoked = false;
  const relay = new CredentialSourceRelay(sha(bearer), () => active);
  const route = { host: "10.0.0.9", port: 8444, path: "/v1/responses" };
  await relay.listenModel(socket, route, () => revoked);
  t.after(() => relay.close());
  const signal = AbortSignal.timeout(30_000);
  const marker = `prompt-marker-${randomBytes(8).toString("hex")}`;
  const prompt = Buffer.from(JSON.stringify({ model: "fixture-model", input: marker }));

  // Wrong bearer, no bearer: nothing parsed, nothing relayed.
  assert.equal((await askSource(socket, randomBytes(32).toString("base64url"), boxModelRequest(requestId()))).status, 401);
  assert.equal((await askSource(socket, undefined, boxModelRequest(requestId()))).status, 401);
  // Anything but the one route: refused by the host before the Worker is asked.
  const refusal = async (target: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    (await askSource(socket, bearer, boxModelRequest(requestId(), target, prompt, overrides))).body?.refusal;
  assert.equal(await refusal({ host: "10.0.0.8" }), "route_unsupported");
  assert.equal(await refusal({ port: 443 }), "route_unsupported");
  assert.equal(await refusal({ path: "/v1/chat/completions" }), "route_unsupported");
  assert.equal(await refusal({ path: "/v1/responses/compact" }), "route_unsupported");
  assert.equal(await refusal({ method: "GET" }), "route_unsupported");
  assert.equal(await refusal({ query: "x=1" }), "route_unsupported");
  assert.equal(await refusal({ scheme: "http" }), "request_invalid");
  assert.equal(await refusal({}, { version: 2 }), "request_invalid");
  assert.equal(await refusal({}, { body: "AAA" }), "request_invalid");
  assert.deepEqual(await relay.collect(0, signal), []);

  // An allowed request: the Worker sees the target and its own ids only.
  const id1 = requestId();
  const pending = askSource(socket, bearer, boxModelRequest(id1, {}, prompt));
  const [ask] = await relay.collect(4_000, signal);
  assert.ok(ask && "kind" in ask);
  assert.deepEqual(Object.keys(ask).sort(), [
    "askId",
    "bearerSha256",
    "deadlineUnixMs",
    "kind",
    "requestId",
    "target",
  ]);
  assert.deepEqual(ask.target, { host: "10.0.0.9", port: 8444, method: "POST", path: "/v1/responses", query: "" });
  assert.equal(ask.bearerSha256, sha(bearer));
  assert.equal(JSON.stringify(ask).includes(marker), false);
  assert.equal(JSON.stringify(ask).includes(prompt.toString("base64")), false);
  // A send-by beyond 5 s is not a model answer.
  const now = Date.now();
  assert.throws(
    () => checkedAnswer({ host: "10.0.0.9", model: true }, { credential: "k", send_by_unix_ms: now + 6_000 }, now),
    /answer_invalid/,
  );
  const key = testModelKey();
  const sendBy = Date.now() + 5_000;
  assert.equal(relay.answer(ask.askId, { credential: key, send_by_unix_ms: sendBy }), true);
  assert.deepEqual((await pending).body, { version: 1, request_id: id1, credential: key, send_by_unix_ms: sendBy });
  assert.equal(relay.modelCounts.released, 1);

  // A Worker refusal passes through as a refusal; an over-long send-by becomes answer_invalid.
  const refused = askSource(socket, bearer, boxModelRequest(requestId(), {}, prompt));
  const [second] = await relay.collect(4_000, signal);
  relay.answer(second!.askId, { refusal: "access_withdrawn" });
  assert.equal((await refused).body?.refusal, "access_withdrawn");
  const tooLong = askSource(socket, bearer, boxModelRequest(requestId(), {}, prompt));
  const [third] = await relay.collect(4_000, signal);
  relay.answer(third!.askId, { credential: key, send_by_unix_ms: Date.now() + 30_000 });
  assert.equal((await tooLong).body?.refusal, "answer_invalid");
  assert.equal((await tooLong).body?.credential, undefined);

  // A body up to Box's 16 MiB cap is accepted (and dropped); one byte more is refused.
  const nearCap = Buffer.alloc(MODEL_MAX_BODY_BYTES, 0x61);
  const big = askSource(socket, bearer, boxModelRequest(requestId(), {}, nearCap));
  const [bigAsk] = await relay.collect(8_000, signal);
  assert.ok(bigAsk);
  relay.answer(bigAsk.askId, { credential: key, send_by_unix_ms: Date.now() + 5_000 });
  assert.equal((await big).body?.credential, key);
  assert.equal(
    (await askSource(socket, bearer, boxModelRequest(requestId(), {}, Buffer.alloc(MODEL_MAX_BODY_BYTES + 1)))).body?.refusal,
    "body_too_large",
  );
  assert.equal(
    parseModelRequest(Buffer.from(JSON.stringify(boxModelRequest(requestId(), {}, prompt))), route).bodyBytes,
    prompt.length,
  );

  // The revoke receipt wins: refused by the host, the Worker never asked; also mid-answer.
  const raced = askSource(socket, bearer, boxModelRequest(requestId(), {}, prompt));
  const [racedAsk] = await relay.collect(4_000, signal);
  revoked = true;
  relay.answer(racedAsk!.askId, { credential: key, send_by_unix_ms: Date.now() + 5_000 });
  assert.equal((await raced).body?.refusal, "access_withdrawn");
  assert.equal((await raced).body?.credential, undefined);
  assert.equal(await refusal({}), "access_withdrawn");
  assert.deepEqual(await relay.collect(0, signal), []);
  revoked = false;
  active = false;
  assert.equal(await refusal({}), "access_withdrawn");
  assert.deepEqual(await relay.collect(0, signal), []);
  t.diagnostic(`model asks: ${JSON.stringify(relay.modelCounts)}`);
});

test("the host renders one model credential route: Box's source, the placeholder variable, POST /v1/responses only", () => {
  const route = { kind: "controlled-inference" as const, url: MODEL_ROUTE, address: "10.0.0.9" };
  const tables = modelCredentials(route, {
    socket: "/run/oce-box/revision/source/model.sock",
    bearerEnv: "OCE_SOURCE_BEARER",
    timeoutMs: 5_000,
    maxBodyBytes: MODEL_MAX_BODY_BYTES,
    path: "/v1/responses",
  });
  assert.equal(
    tables,
    [
      "[gateway.credential_source.oce-model]",
      'endpoint = "unix:///run/oce-box/revision/source/model.sock"',
      'bearer = "env://OCE_SOURCE_BEARER"',
      "timeout_ms = 5000",
      `max_body_bytes = ${16 * 1024 * 1024}`,
      "",
      "[egress.oce-model]",
      'destinations = ["10.0.0.9:8444/v1/responses"]',
      'secret.ref = "source://oce-model"',
      'secret.env = "OPENAI_API_KEY"',
      'secret.placement = "header"',
      'secret.header = "Authorization"',
      'secret.prefix = "Bearer "',
      'secret.inject = "phantom"',
      "",
    ].join("\n"),
  );
  assert.throws(() => modelCredentials({ ...route, kind: "workspace-node" }, {} as never), /invalid_model_route/);
  assert.throws(() => modelCredentials({ ...route, url: "http://10.0.0.9:8444/v1" }, {} as never));
  // The wiring names the model delivery only for a plan with a model source.
  assert.deepEqual(hostWiring("github", true), {
    version: 4,
    protectedRepository: {
      provider: "github",
      hosts: ["github.com", "api.github.com"],
      delivery: "box-source-v1",
    },
    harnessModel: { delivery: "box-source-v1", method: "POST", path: "/responses", placeholder: "OPENAI_API_KEY" },
  });
});

test("the paired Driver admits the protected plan with exactly its one model attachment and the empty artifact policy", { timeout: 60_000 }, async (t) => {
  const kube = await fakeKubernetesSecrets(t);
  const f = await pairedFixture(t, { model: { gateway: kube.configuration } });
  assert.ok(f.gateway);
  const wiring = await f.release.configure(f.context);
  assert.deepEqual(wiring.configuration, hostWiring("github", true));
  const installed = await f.release.observe(f.context, wiring);
  assert.ok(installed);
  const refusedBy = async (change: (h: typeof f.harness) => typeof f.harness, message: RegExp) =>
    assert.rejects(
      f.sandbox.enrollHarness!(change(f.harness), installed, async () => {
        throw new Error("release must not be requested");
      }),
      message,
    );
  const requirements = (value: Record<string, unknown>) => (h: typeof f.harness) =>
    ({ ...h, requirements: { ...h.requirements, ...value } }) as typeof f.harness;
  const revision = (value: Record<string, unknown>) => (h: typeof f.harness) =>
    ({ ...h, revision: { ...h.revision, ...value } }) as typeof f.harness;
  const attachment = { sourceId: MODEL_SOURCE_ID, ref: modelAttachmentRef(MODEL_SOURCE_ID) };
  const scope = /protected one-repository revision/;
  await refusedBy(requirements({ credentialAttachments: [] }), scope);
  await refusedBy(requirements({ credentialAttachments: [attachment, attachment] }), scope);
  await refusedBy(requirements({ credentialAttachments: [{ ...attachment, ref: "openshell:x" }] }), scope);
  await refusedBy(
    requirements({ credentialAttachments: [{ ...attachment, requestScope: { host: "x", port: 443, path: "/", scopes: [] } }] }),
    scope,
  );
  await refusedBy(requirements({ loginMode: "chatgpt" }), scope);
  await refusedBy(revision({ harnessAuth: { ...modelSource, sourceId: "cs_other" } }), scope);
  const policy = f.revision.sandboxPolicy!;
  await refusedBy(revision({ sandboxPolicy: undefined }), /empty protected artifact policy/);
  await refusedBy(
    revision({
      sandboxPolicy: {
        ...policy,
        additions: [{ name: "x", host: "example.com", ports: [443] }],
      },
    }),
    /empty protected artifact policy/,
  );
  await refusedBy(revision({ sandboxPolicy: { ...policy, defaults: { a: 1 } } }), /empty protected artifact policy/);
  await refusedBy(revision({ sandboxPolicy: { ...policy, driverId: "openshell" } }), /empty protected artifact policy/);
  // A plan whose source belongs to another Gateway is not this registration's plan.
  const foreign = {
    ...f.plan,
    harnessCredentialSource: { ...modelSource, credentialGatewayId: "openshell" },
  };
  await assert.rejects(f.release.configure({ ...f.context, plan: foreign as never }), /no longer owns|one online-request/);
  assert.equal(f.host.releases.length, 0);
  // The exact admitted shape enrolls.
  assert.equal(
    await f.release.enroll(
      f.context,
      wiring,
      f.custody,
      async () => true,
      async () => f.harness,
      (startupId, current) => signComputeExecutionRelease(f.keys.privateKey, startupId, current),
    ),
    true,
  );
  assert.equal(f.host.releases.length, 1);
});

test("the Worker answers a Box model request from the package's Secret: bearer, live attachment, route, 5 s; withdrawal, restart and rotation", { timeout: 90_000 }, async (t) => {
  const kube = await fakeKubernetesSecrets(t);
  const f = await pairedFixture(t, { model: { gateway: kube.configuration } });
  const gateway = f.gateway!;
  const signal = AbortSignal.timeout(80_000);
  const { binding } = await activateStageB(f, signal);
  t.after(() => binding.close());
  const sourceContext = {
    namespace,
    source: source(),
    signal,
  };
  const key = testModelKey();
  await gateway.registerSource(sourceContext, {
    type: MODEL_SOURCE_TYPE,
    config: { authorized_base_url: MODEL_ROUTE },
    secrets: { api_key: key },
  });
  const revisionContext = { namespace, revision: f.revision, sources: [source()], signal };
  assert.deepEqual(await gateway.attachForRevision(revisionContext), [
    { sourceId: MODEL_SOURCE_ID, ref: modelAttachmentRef(MODEL_SOURCE_ID) },
  ]);
  assert.deepEqual(await gateway.attachmentStatus(revisionContext), [
    { sourceId: MODEL_SOURCE_ID, state: "ready" },
  ]);
  const ask = async (bearer: string | undefined = f.bearer) => {
    const id1 = requestId();
    const reply = await askSource(f.modelSocket, bearer, boxModelRequest(id1));
    return { ...reply, requestId: id1 };
  };
  const credential = async () => {
    const reply = await ask();
    assert.equal(reply.status, 200);
    assert.equal(reply.body?.request_id, reply.requestId);
    return reply.body;
  };

  // Allowed: the stored key, with a send-by within 5 s.
  const first = await credential();
  assert.equal(first?.credential, key);
  assert.ok(Number(first?.send_by_unix_ms) - Date.now() <= 5_000);
  assert.equal(f.host.answered.at(-1), "credential");
  assert.equal((await ask(randomBytes(32).toString("base64url"))).status, 401);

  // Rotation: the next request gets the new key; nothing restarts.
  const rotated = testModelKey();
  await gateway.updateSource(sourceContext, {
    type: MODEL_SOURCE_TYPE,
    config: { authorized_base_url: MODEL_ROUTE },
    secrets: { api_key: rotated },
  });
  assert.equal((await credential())?.credential, rotated);
  assert.equal(f.host.deletes, 0);

  // Repository-only withdrawal: OCE refuses GitHub, the model keeps working.
  f.state.withdrawn = true;
  assert.equal((await credential())?.credential, rotated);
  f.state.withdrawn = false;

  // Model withdrawal: the host's receipt; refused by the host before the Worker or provider.
  const before = { ...f.source.modelCounts };
  assert.deepEqual(
    await gateway.withdraw({
      namespace,
      revision: f.revision,
      sandbox: { id: "box-execution" } as never,
      sourceId: MODEL_SOURCE_ID,
      signal,
    }),
    { sourceId: MODEL_SOURCE_ID, state: "revoked" },
  );
  assert.equal(f.host.modelRevokes, 1);
  const [receiptFile] = readdirSync(f.revocationDir);
  assert.match(receiptFile!, /^model-revoked-[0-9a-f]{64}\.json$/);
  const receipt = JSON.parse(readFileSync(join(f.revocationDir, receiptFile!), "utf8")) as Record<string, unknown>;
  assert.equal(receipt.sourceId, MODEL_SOURCE_ID);
  assert.equal(JSON.stringify(receipt).includes(rotated), false);
  const answersBefore = f.host.answers;
  const withdrawn = await credential();
  assert.equal(withdrawn?.refusal, "access_withdrawn");
  assert.equal(withdrawn?.credential, undefined);
  assert.equal(f.host.answers, answersBefore, "the Worker was not asked");
  assert.equal(f.source.modelCounts.refusedByHost, before.refusedByHost + 1);
  assert.deepEqual(await gateway.attachmentStatus(revisionContext), [
    { sourceId: MODEL_SOURCE_ID, state: "revoked" },
  ]);
  // A host restart reloads the receipt: still refused.
  f.host.modelRevoked = undefined;
  f.restartHostModelView();
  assert.ok(f.host.modelRevoked);
  assert.equal((await credential())?.refusal, "access_withdrawn");
  // Even if the host view lost it, the Worker reads the host's view per request: a view without
  // the receipt but with the source removed is refused by the Worker from the store.
  f.host.modelRevoked = undefined;
  await gateway.removeSource(sourceContext);
  assert.equal((await credential())?.refusal, "access_withdrawn");
  assert.equal(f.host.answered.at(-1), "access_withdrawn");
  // Digests only in the Worker's own records.
  t.diagnostic(`key sha256 ${valueDigest(key).slice(0, 12)}, rotated ${valueDigest(rotated).slice(0, 12)}; host model asks ${JSON.stringify(f.source.modelCounts)}`);
});
