import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
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
  MAX_MODEL_ASK_BYTES,
  MODEL_BUFFER_BYTES,
  MODEL_MAX_BODY_BYTES,
  type ModelAsk,
  parseModelRequest,
} from "../../deploy/examples/strands-box/host/credential-source.ts";
import {
  modelCredentials,
  parseRoute,
  policy,
} from "../../deploy/examples/strands-box/host/egress.ts";
import type { AgentRevision, CredentialSource } from "../../packages/contracts/src/index.ts";
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
    async revoke(_withdrawal, sourceId) {
      live.revokes++;
      if (live.receipt === undefined) {
        return undefined;
      }
      // The host's receipt is for the revision and source, live execution or not (finding 3301).
      if (live.attachment?.sourceId === sourceId) {
        live.attachment = { sourceId, revoked: true };
      }
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
    assert.throws(
      () => gateway.validateSourceConfig(refused),
      /model source type|authorized_base_url/,
    );
  }

  // Register: one named Secret per source, labelled and annotated with its owner.
  const key = testModelKey();
  const name = modelSecretName(namespace.id, MODEL_SOURCE_ID);
  assert.deepEqual(
    await gateway.registerSource(context(), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: key },
    }),
    { state: "ready" },
  );
  const stored = kube.secrets.get(name)!;
  assert.equal(kube.value(name), key);
  assert.deepEqual(stored.metadata.labels, {
    "app.kubernetes.io/managed-by": "openclaw-strands-box",
  });
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
    await gateway.updateSource(context(), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: rotated },
    }),
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
      annotations: {
        "openclaw.dev/credential-source-id": "cs_someone",
        "openclaw.dev/namespace-id": namespace.id,
      },
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
  await gateway.registerSource(context(), {
    type: MODEL_SOURCE_TYPE,
    config,
    secrets: { api_key: key },
  });
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
  await assert.rejects(
    attach(modelRevision({ harnessAuth: { ...modelSource, sourceId: "cs_none" } }), [
      source({ id: "cs_none" }),
    ]),
    /no stored key/,
  );

  // Status: pending until the host shows the execution with this attachment; then ready.
  const statuses = () =>
    gateway.attachmentStatus({ namespace, revision: modelRevision(), sources: [source()], signal });
  assert.deepEqual(await statuses(), [{ sourceId: MODEL_SOURCE_ID, state: "pending" }]);
  live.attachment = { sourceId: MODEL_SOURCE_ID, revoked: false };
  assert.deepEqual(await statuses(), [{ sourceId: MODEL_SOURCE_ID, state: "ready" }]);

  // Withdraw: revoked only with the host's receipt.
  const withdrawal = {
    namespace,
    revision: modelRevision(),
    sandbox: { id: "box-execution" } as never,
    sourceId: MODEL_SOURCE_ID,
    signal,
  };
  live.receipt = undefined;
  assert.deepEqual(await gateway.withdraw(withdrawal), {
    sourceId: MODEL_SOURCE_ID,
    state: "pending",
  });
  live.receipt = "receipt-1";
  assert.deepEqual(await gateway.withdraw(withdrawal), {
    sourceId: MODEL_SOURCE_ID,
    state: "revoked",
  });
  assert.deepEqual(await statuses(), [{ sourceId: MODEL_SOURCE_ID, state: "revoked" }]);
  const revokes = live.revokes;
  assert.deepEqual(await gateway.withdraw(withdrawal), {
    sourceId: MODEL_SOURCE_ID,
    state: "revoked",
  });
  assert.equal(live.revokes, revokes, "an already revoked attachment is not revoked again");
  // No live execution (failed, or a restarted host without one): the host still writes the
  // receipt for the revision and source, so a later start is refused (finding 3301).
  live.attachment = undefined;
  assert.deepEqual(await gateway.withdraw(withdrawal), {
    sourceId: MODEL_SOURCE_ID,
    state: "revoked",
  });
  assert.equal(live.revokes, revokes + 1);
  live.receipt = undefined;
  assert.deepEqual(await gateway.withdraw(withdrawal), {
    sourceId: MODEL_SOURCE_ID,
    state: "pending",
  });
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
  assert.equal(
    (await askSource(socket, randomBytes(32).toString("base64url"), boxModelRequest(requestId())))
      .status,
    401,
  );
  assert.equal((await askSource(socket, undefined, boxModelRequest(requestId()))).status, 401);
  // Anything but the one route: refused by the host before the Worker is asked.
  const refusal = async (
    target: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ) =>
    (await askSource(socket, bearer, boxModelRequest(requestId(), target, prompt, overrides))).body
      ?.refusal;
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
  assert.deepEqual(ask.target, {
    host: "10.0.0.9",
    port: 8444,
    method: "POST",
    path: "/v1/responses",
    query: "",
  });
  assert.equal(ask.bearerSha256, sha(bearer));
  assert.equal(JSON.stringify(ask).includes(marker), false);
  assert.equal(JSON.stringify(ask).includes(prompt.toString("base64")), false);
  // A send-by beyond 5 s is not a model answer.
  const now = Date.now();
  assert.throws(
    () =>
      checkedAnswer(
        { host: "10.0.0.9", model: true },
        { credential: "k", send_by_unix_ms: now + 6_000 },
        now,
      ),
    /answer_invalid/,
  );
  const key = testModelKey();
  const sendBy = Date.now() + 5_000;
  assert.equal(relay.answer(ask.askId, { credential: key, send_by_unix_ms: sendBy }), true);
  assert.deepEqual((await pending).body, {
    version: 1,
    request_id: id1,
    credential: key,
    send_by_unix_ms: sendBy,
  });
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
    (
      await askSource(
        socket,
        bearer,
        boxModelRequest(requestId(), {}, Buffer.alloc(MODEL_MAX_BODY_BYTES + 1)),
      )
    ).body?.refusal,
    "body_too_large",
  );
  assert.equal(
    parseModelRequest(Buffer.from(JSON.stringify(boxModelRequest(requestId(), {}, prompt))), route)
      .bodyBytes,
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
  assert.throws(() => modelCredentials({ ...route, kind: "workspace-node" }, {} as never), {
    message: "invalid_model_route",
  });
  assert.throws(() => modelCredentials({ ...route, url: "http://10.0.0.9:8444/v1" }, {} as never), {
    message: "invalid_fixed_egress",
  });
  // The wiring names the model delivery only for a plan with a model source.
  assert.deepEqual(hostWiring("github", true), {
    version: 4,
    protectedRepository: {
      provider: "github",
      hosts: ["github.com", "api.github.com"],
      delivery: "box-source-v1",
    },
    harnessModel: {
      delivery: "box-source-v1",
      method: "POST",
      path: "/responses",
      placeholder: "OPENAI_API_KEY",
    },
  });
});

test(
  "the paired Driver admits the protected plan with exactly its one model attachment and the empty artifact policy",
  { timeout: 60_000 },
  async (t) => {
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
    await refusedBy(
      requirements({ credentialAttachments: [{ ...attachment, ref: "openshell:x" }] }),
      scope,
    );
    await refusedBy(
      requirements({
        credentialAttachments: [
          { ...attachment, requestScope: { host: "x", port: 443, path: "/", scopes: [] } },
        ],
      }),
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
    await refusedBy(
      revision({ sandboxPolicy: { ...policy, defaults: { a: 1 } } }),
      /empty protected artifact policy/,
    );
    await refusedBy(
      revision({ sandboxPolicy: { ...policy, driverId: "openshell" } }),
      /empty protected artifact policy/,
    );
    // A plan whose source belongs to another Gateway is not this registration's plan.
    const foreign = {
      ...f.plan,
      harnessCredentialSource: { ...modelSource, credentialGatewayId: "openshell" },
    };
    await assert.rejects(f.release.configure({ ...f.context, plan: foreign as never }), {
      message: /no longer owns|one online-request/,
    });
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
  },
);

test(
  "the Worker answers a Box model request from the package's Secret: bearer, live attachment, route, 4 s send-by; withdrawal, restart and rotation",
  { timeout: 90_000 },
  async (t) => {
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

    // Allowed: the stored key, with a send-by within 4 s: 1 s below the host's 5 s ceiling, so
    // a Worker clock up to 1 s ahead of the Box node is still accepted (finding 3302).
    const first = await credential();
    assert.equal(first?.credential, key);
    assert.ok(Number(first?.send_by_unix_ms) - Date.now() <= 4_000);
    assert.ok(
      checkedAnswer(
        { host: "10.0.0.9", model: true },
        { credential: key, send_by_unix_ms: Number(first?.send_by_unix_ms) },
        Number(first?.send_by_unix_ms) - 4_000 - 999,
      ),
    );
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
    assert.ok(f.host.modelRevoked, "the live view shows the host's receipt");
    const [receiptFile] = readdirSync(f.revocationDir);
    assert.match(receiptFile!, /^model-revoked-[0-9a-f]{64}\.json$/);
    const receipt = JSON.parse(readFileSync(join(f.revocationDir, receiptFile!), "utf8")) as Record<
      string,
      unknown
    >;
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
    t.diagnostic(
      `key sha256 ${valueDigest(key).slice(0, 12)}, rotated ${valueDigest(rotated).slice(0, 12)}; host model asks ${JSON.stringify(f.source.modelCounts)}`,
    );
  },
);

/** The Secret reads (`GET`) the store made since `from`: the key-read evidence. */
const secretReads = (kube: { calls: readonly string[] }, from: number) =>
  kube.calls.slice(from).filter((call) => call.startsWith("GET "));

/** Register one model source's key through the package's Gateway, as the API process does. */
async function registerModelKey(
  gateway: NonNullable<Awaited<ReturnType<typeof pairedFixture>>["gateway"]>,
  namespaceId: string,
  sourceId: string,
  signal: AbortSignal,
) {
  const key = testModelKey();
  await gateway.registerSource(
    {
      namespace: { ...namespace, id: namespaceId },
      source: source({ id: sourceId, namespaceId }),
      signal,
    },
    {
      type: MODEL_SOURCE_TYPE,
      config: { authorized_base_url: MODEL_ROUTE },
      secrets: { api_key: key },
    },
  );
  return key;
}

test(
  "a host that lies about its Namespace or source gets a refusal and no Secret read; only OCE's confirmed installation selects the key",
  { timeout: 90_000 },
  async (t) => {
    // Finding 3298: the Worker's control socket is served by the host account. Whatever serves it
    // can report any owner, plan and model view; the key must come only from OCE's own state.
    const kube = await fakeKubernetesSecrets(t);
    const f = await pairedFixture(t, { model: { gateway: kube.configuration } });
    const gateway = f.gateway!;
    const signal = AbortSignal.timeout(80_000);
    const { binding } = await activateStageB(f, signal);
    t.after(() => binding.close());
    const own = await registerModelKey(gateway, namespace.id, MODEL_SOURCE_ID, signal);
    const victim = await registerModelKey(gateway, "ns_victim", "cs_victim", signal);
    const sibling = await registerModelKey(gateway, namespace.id, "cs_sibling", signal);
    const ask = () => askSource(f.modelSocket, f.bearer, boxModelRequest(requestId()));
    const outcome = (reply: Awaited<ReturnType<typeof ask>>) => {
      const value = reply.body?.credential;
      // Never the value itself in an assertion message: name which key it was.
      return value === undefined
        ? String(reply.body?.refusal)
        : value === own
          ? "own key"
          : value === victim
            ? "VICTIM KEY"
            : value === sibling
              ? "SIBLING KEY"
              : "unknown key";
    };
    assert.equal(outcome(await ask()), "own key");
    // Right after a Worker pass the serve loop may still hold the replaced recipient for one
    // collect; its asks are refused (`execution_mismatch`). Ask until the live recipient answers.
    const settled = async () => {
      let result = outcome(await ask());
      for (let attempt = 0; attempt < 3 && result === "execution_mismatch"; attempt++) {
        result = outcome(await ask());
      }
      return result;
    };
    const refusals = new Set(["route_not_ready", "execution_mismatch"]);

    for (const lie of [
      { namespaceId: "ns_victim", sourceId: "cs_victim" },
      { namespaceId: namespace.id, sourceId: "cs_sibling" },
    ]) {
      // The lie before the Worker's next pass: the confirmed recipient's host view no longer
      // matches, refused before any Secret read.
      f.host.lie = lie;
      let reads = kube.calls.length;
      assert.equal(outcome(await ask()), "execution_mismatch");
      assert.deepEqual(secretReads(kube, reads), []);
      // After the pass the lying installation is the Worker's recipient, but OCE never committed
      // it: never confirmed, never observed, so every ask is refused and no Secret is read.
      await binding.reconcile!(signal);
      assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "pending");
      reads = kube.calls.length;
      for (let attempt = 0; attempt < 3; attempt++) {
        const refused = outcome(await ask());
        assert.ok(refusals.has(refused), refused);
      }
      assert.equal(await settled(), "route_not_ready");
      assert.deepEqual(secretReads(kube, reads), []);
      // The honest host again: OCE's committed installation, confirmed again, own key only.
      f.host.lie = undefined;
      await binding.reconcile!(signal);
      assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
      assert.equal(await settled(), "own key");
    }

    // Confirmed, then OCE's committed installation for the revision is replaced (a new release):
    // refused at answer time, before the Worker's next pass and before any Secret read.
    const committed = f.committed()!;
    await f.custody.recordEgressInstallation({
      ...committed,
      installedAt: "2026-11-17T00:00:00.000Z",
    });
    let reads = kube.calls.length;
    assert.equal(outcome(await ask()), "route_not_ready");
    assert.deepEqual(secretReads(kube, reads), []);
    await f.custody.recordEgressInstallation(committed);
    assert.equal(outcome(await ask()), "own key");
    // OCE's delivery row moved to another fence (a replaced lease): refused the same way.
    f.state.fence = 2;
    reads = kube.calls.length;
    assert.equal(outcome(await ask()), "route_not_ready");
    assert.deepEqual(secretReads(kube, reads), []);
    f.state.fence = 1;
    assert.equal(outcome(await ask()), "own key");
    // The Worker's own records hold only which outcome each ask had; never a value.
    t.diagnostic(`host model asks ${JSON.stringify(f.source.modelCounts)}`);
  },
);

test(
  "the Worker refuses a model ask OCE has not confirmed, whatever the host shows",
  { timeout: 90_000 },
  async (t) => {
    const kube = await fakeKubernetesSecrets(t);
    const f = await pairedFixture(t, { model: { gateway: kube.configuration } });
    const signal = AbortSignal.timeout(80_000);
    const wiring = await f.release.configure(f.context);
    const binding = await f.owner.requireRepositoryGitTransport()(f.authority, f.requests);
    t.after(() => binding.close());
    await registerModelKey(f.gateway!, namespace.id, MODEL_SOURCE_ID, signal);
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
    // Released and the Worker's recipient, but not confirmed: the host shows no live source.
    f.host.sourceLive = false;
    await binding.reconcile!(signal);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "pending");
    const reads = kube.calls.length;
    const reply = await askSource(f.modelSocket, f.bearer, boxModelRequest(requestId()));
    assert.equal(reply.body?.refusal, "route_not_ready");
    assert.equal(reply.body?.credential, undefined);
    assert.deepEqual(secretReads(kube, reads), []);
    // Confirmed: the same ask is answered.
    f.host.sourceLive = true;
    await binding.reconcile!(signal);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
    assert.equal(
      typeof (await askSource(f.modelSocket, f.bearer, boxModelRequest(requestId()))).body
        ?.credential,
      "string",
    );
  },
);

test(
  "the Worker's own model rules refuse each ask a relay passes: bearer, route, deadline, revoke, source, retired recipient",
  { timeout: 90_000 },
  async (t) => {
    // Finding 3299: a relay stand-in hands the Worker asks the real relay would have refused, so
    // each of the Worker's checks is proven alone. Each refusal reads no Secret.
    const kube = await fakeKubernetesSecrets(t);
    const f = await pairedFixture(t, { model: { gateway: kube.configuration } });
    const signal = AbortSignal.timeout(80_000);
    const { binding } = await activateStageB(f, signal);
    t.after(() => binding.close());
    const key = await registerModelKey(f.gateway!, namespace.id, MODEL_SOURCE_ID, signal);
    const forged = (change: Partial<ModelAsk> = {}, target: Partial<ModelAsk["target"]> = {}) =>
      ({
        kind: "model",
        askId: randomUUID(),
        requestId: requestId(),
        bearerSha256: sha(f.bearer),
        deadlineUnixMs: Date.now() + 4_000,
        ...change,
        target: {
          host: "10.0.0.9",
          port: 8444,
          method: "POST",
          path: "/v1/responses",
          query: "",
          ...target,
        },
      }) as ModelAsk;
    const refused = async (ask: ModelAsk, refusal: string) => {
      const reads = kube.calls.length;
      const answer = await f.forge(ask);
      assert.deepEqual(answer, { refusal }, `${ask.target.path} ${ask.target.host}`);
      assert.deepEqual(secretReads(kube, reads), []);
    };
    // The stand-in itself: an exact ask is answered with the key and a 4 s send-by.
    const allowed = await f.forge(forged());
    assert.equal(allowed.credential, key);
    assert.ok(Number(allowed.send_by_unix_ms) - Date.now() <= 4_000);

    await refused(forged({ bearerSha256: sha("another bearer") }), "execution_mismatch");
    await refused(forged({ bearerSha256: "0".repeat(64) }), "execution_mismatch");
    await refused(forged({}, { path: "/v1/chat/completions" }), "request_not_allowed");
    await refused(forged({}, { path: "/v1/responses/compact" }), "request_not_allowed");
    await refused(forged({}, { host: "10.0.0.8" }), "request_not_allowed");
    await refused(forged({}, { port: 443 }), "request_not_allowed");
    await refused(forged({}, { method: "GET" as "POST" }), "request_not_allowed");
    await refused(forged({}, { query: "x=1" as "" }), "request_not_allowed");
    await refused(forged({ deadlineUnixMs: Date.now() - 1 }), "route_not_ready");
    // The host's view shows the revoke (the relay that would refuse first is bypassed).
    f.host.modelRevoked = { receiptId: randomUUID(), revokedAt: new Date().toISOString() };
    await refused(forged(), "access_withdrawn");
    f.host.modelRevoked = undefined;
    // The host's view names another source than OCE's plan.
    f.host.viewSourceId = "cs_sibling";
    await refused(forged(), "execution_mismatch");
    f.host.viewSourceId = undefined;
    // The recipient retired (OCE removed the revision) while the ask was in flight.
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const reads = kube.calls.length;
    const answered = f.forge(forged(), hold);
    const deadline = Date.now() + 10_000;
    while (!f.host.forgedHeld) {
      assert.ok(Date.now() < deadline, "the forged ask did not reach the collect");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      await f.proxy.removeRevision!({ ...f.context, revision: f.revision } as never),
      true,
    );
    release();
    assert.deepEqual(await answered, { refusal: "execution_mismatch" });
    assert.deepEqual(secretReads(kube, reads), []);
    // Retired while the Worker was reading OCE's state for the ask: refused after that read.
    await binding.reconcile!(signal);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
    let resume!: () => void;
    f.state.observeHold = new Promise<void>((resolve) => (resume = resolve));
    const during = f.forge(forged());
    const observing = Date.now() + 10_000;
    while (!f.state.observeHeld) {
      assert.ok(Date.now() < observing, "the Worker did not read OCE's state");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const readsDuring = kube.calls.length;
    assert.equal(await f.proxy.removeRevision!({ ...f.context, revision: f.revision } as never), true);
    f.state.observeHold = undefined;
    resume();
    assert.deepEqual(await during, { refusal: "route_not_ready" });
    assert.deepEqual(secretReads(kube, readsDuring), []);
  },
);

test(
  "a withdrawal without a live execution still leaves the host's receipt, and a restarted execution is refused",
  { timeout: 90_000 },
  async (t) => {
    // Finding 3301: a failed execution, or a host that restarted without one, used to get
    // `absent` and no receipt; a later start of that revision then got keys until OCC's recheck.
    const kube = await fakeKubernetesSecrets(t);
    const f = await pairedFixture(t, { model: { gateway: kube.configuration } });
    const gateway = f.gateway!;
    const signal = AbortSignal.timeout(80_000);
    const { binding } = await activateStageB(f, signal);
    t.after(() => binding.close());
    await registerModelKey(gateway, namespace.id, MODEL_SOURCE_ID, signal);
    const withdrawal = {
      namespace,
      revision: f.revision,
      sandbox: { id: "box-execution" } as never,
      sourceId: MODEL_SOURCE_ID,
      signal,
    };
    // The host answers 404: no current execution.
    f.host.present = false;
    assert.deepEqual(await gateway.withdraw(withdrawal), {
      sourceId: MODEL_SOURCE_ID,
      state: "revoked",
    });
    assert.equal(f.host.modelRevokes, 1);
    assert.equal(readdirSync(f.revocationDir).length, 1);
    // A Namespace this registration does not serve: nothing is sent to the host, nothing written.
    assert.deepEqual(
      await gateway.withdraw({ ...withdrawal, namespace: { ...namespace, name: "another" } }),
      { sourceId: MODEL_SOURCE_ID, state: "pending" },
    );
    assert.equal(f.host.modelRevokes, 1);
    assert.equal(readdirSync(f.revocationDir).length, 1);
    // The same revision runs again on the host: its start reloads the receipt, and the host
    // refuses every model request before the Worker is asked.
    f.host.present = true;
    f.restartHostModelView();
    assert.ok(f.host.modelRevoked);
    const answers = f.host.answers;
    const reply = await askSource(f.modelSocket, f.bearer, boxModelRequest(requestId()));
    assert.equal(reply.body?.refusal, "access_withdrawn");
    assert.equal(reply.body?.credential, undefined);
    assert.equal(f.host.answers, answers, "the Worker was not asked");
    // Withdrawing again is answered from the live view: no second receipt.
    assert.deepEqual(await gateway.withdraw(withdrawal), {
      sourceId: MODEL_SOURCE_ID,
      state: "revoked",
    });
    assert.equal(f.host.modelRevokes, 1);
  },
);

test("the model key store deletes only the Secret it checked, and updates only its own sources", async (t) => {
  // Finding 3302: DELETE carries the read's uid and resourceVersion; updateSource checks own().
  const { kube, gateway, context, store, signal } = await gatewayFixture(t);
  const config = { authorized_base_url: MODEL_ROUTE };
  const key = testModelKey();
  await gateway.registerSource(context(), {
    type: MODEL_SOURCE_TYPE,
    config,
    secrets: { api_key: key },
  });
  const name = modelSecretName(namespace.id, MODEL_SOURCE_ID);
  // updateSource for a source another Gateway owns is refused and changes nothing.
  await assert.rejects(
    gateway.updateSource(context({ driverId: "openshell" } as never), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: testModelKey() },
    }),
    /not owned by this gateway/,
  );
  await assert.rejects(
    gateway.updateSource(context({ namespaceId: "ns_other" }), {
      type: MODEL_SOURCE_TYPE,
      config,
      secrets: { api_key: testModelKey() },
    }),
    /not owned by this gateway/,
  );
  assert.equal(kube.value(name), key);
  // A write between the store's read and its DELETE: the precondition fails, the store reads
  // again (ownership checked again) and deletes the version it checked.
  const uid = kube.secrets.get(name)!.metadata.uid;
  kube.beforeNextDelete((secret) => kube.touch(secret));
  await store.remove(namespace.id, MODEL_SOURCE_ID, signal);
  assert.equal(kube.secrets.has(name), false);
  assert.equal(kube.deletes.length, 2);
  for (const preconditions of kube.deletes) {
    assert.deepEqual(Object.keys(preconditions as object).sort(), ["resourceVersion", "uid"]);
    assert.equal((preconditions as { uid: string }).uid, uid);
  }
  // Replaced by another owner's Secret under the same name between read and DELETE: the DELETE
  // fails its uid precondition and the new read refuses it as another owner's; nothing deleted.
  await gateway.registerSource(context(), {
    type: MODEL_SOURCE_TYPE,
    config,
    secrets: { api_key: key },
  });
  kube.beforeNextDelete((secret) => {
    kube.secrets.set(secret, {
      metadata: {
        name: secret,
        uid: randomUUID(),
        resourceVersion: "999",
        annotations: {
          "openclaw.dev/credential-source-id": "cs_someone",
          "openclaw.dev/namespace-id": namespace.id,
        },
      },
      data: { api_key: Buffer.from("foreign").toString("base64") },
    });
  });
  await assert.rejects(
    store.remove(namespace.id, MODEL_SOURCE_ID, signal),
    /not owned by this source/,
  );
  assert.equal(kube.value(name), "foreign");
});

test("the host buffers at most two of Box's largest model asks at once; more are refused unread", async (t) => {
  // Finding 3302: before, 64 parallel 16 MiB model requests held about 1.4 GB in the host.
  const directory = await temporaryDirectory(t, "strands-model-budget-");
  const socket = join(directory, "model.sock");
  const bearer = randomBytes(32).toString("base64url");
  const relay = new CredentialSourceRelay(sha(bearer), () => true);
  await relay.listenModel(
    socket,
    { host: "10.0.0.9", port: 8444, path: "/v1/responses" },
    () => false,
  );
  t.after(() => relay.close());
  assert.equal(MODEL_BUFFER_BYTES, 2 * MAX_MODEL_ASK_BYTES);
  // Two uploads of the largest declared size, held open mid-body: they hold the whole budget.
  const held = await Promise.all(
    [0, 1].map(async () => {
      const connection = createConnection(socket);
      await once(connection, "connect");
      connection.write(
        `POST / HTTP/1.1\r\nHost: source\r\nAuthorization: Bearer ${bearer}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${MAX_MODEL_ASK_BYTES}\r\n\r\n{"version":1`,
      );
      return connection;
    }),
  );
  t.after(() => held.forEach((connection) => connection.destroy()));
  const deadline = Date.now() + 5_000;
  while (relay.modelBuffer.held < MODEL_BUFFER_BYTES) {
    assert.ok(Date.now() < deadline, "the held uploads were not reserved");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // A third ask, even a small one, is refused before its body is read.
  const third = await askSource(socket, bearer, boxModelRequest(requestId()));
  assert.equal(third.status, 503);
  assert.equal(relay.modelBuffer.refused, 1);
  assert.equal(relay.modelBuffer.peak, MODEL_BUFFER_BYTES);
  // A declared length over Box's cap is refused without reading.
  const over = await new Promise<string>((resolve, reject) => {
    const connection = createConnection(socket);
    let reply = "";
    connection.on("data", (chunk) => (reply += chunk.toString("latin1")));
    connection.on("end", () => resolve(reply));
    connection.on("error", reject);
    connection.write(
      `POST / HTTP/1.1\r\nHost: source\r\nAuthorization: Bearer ${bearer}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${MAX_MODEL_ASK_BYTES + 1}\r\n\r\n`,
    );
  });
  assert.match(over, /^HTTP\/1\.1 413 /);
  // The held uploads end: the budget is released, and the next ask is relayed to the Worker.
  held.forEach((connection) => connection.destroy());
  while (relay.modelBuffer.held > 0) {
    assert.ok(Date.now() < deadline + 5_000, "the budget was not released");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const pending = askSource(socket, bearer, boxModelRequest(requestId()));
  const [ask] = await relay.collect(4_000, AbortSignal.timeout(5_000));
  assert.ok(ask);
  relay.answer(ask.askId, { refusal: "access_withdrawn" });
  assert.equal((await pending).body?.refusal, "access_withdrawn");
});

test(
  "a model route below a path prefix still admits one exact POST path: host, Box tables, Worker",
  { timeout: 90_000 },
  async (t) => {
    // Review of the prefix change: /v1 may sit below fixed plain segments, and nothing else.
    const route = "https://10.0.0.9:8444/openai/v1";
    const path = "/openai/v1/responses";
    for (const spelling of [
      "https://10.0.0.9:8444/openai/./v1",
      "https://10.0.0.9:8444/openai/../v1",
      "https://10.0.0.9:8444/openai/%2e/v1",
      "https://10.0.0.9:8444/openai/%2E%2E/v1",
      "https://10.0.0.9:8444/open%61i/v1",
      "https://10.0.0.9:8444/openai//v1",
      "https://10.0.0.9:8444/openai/v1/",
      "https://10.0.0.9:8444/openai/v1/responses",
      "https://10.0.0.9:8444/./v1",
    ]) {
      // The host refuses them at load (the Driver's same refusals: strands-box-driver.test.ts).
      // The URL parser's own normalisation of dot segments changes the spelling, refused too.
      assert.throws(() => parseRoute({ url: spelling, address: "10.0.0.9" }, "controlled-inference"), {
        message: "invalid_fixed_egress",
      });
    }
    const parsed = parseRoute({ url: route, address: "10.0.0.9" }, "controlled-inference");
    // Box's policy: exactly one request rule for the route, POST and the exact full path.
    const rules = policy([parsed])
      .split("\n")
      .filter((line) => line.includes("context.input.path"));
    assert.equal(rules.length, 1);
    assert.match(rules[0]!, /context\.input\.method == "POST" && context\.input\.path == "\/openai\/v1\/responses" &&/);
    // Box's credential route names the same full path, never the bare prefix or /v1.
    const tables = modelCredentials(parsed, {
      socket: "/run/oce-box/revision/source/model.sock",
      bearerEnv: "OCE_SOURCE_BEARER",
      timeoutMs: 5_000,
      maxBodyBytes: MODEL_MAX_BODY_BYTES,
      path,
    });
    assert.match(tables, /^destinations = \["10\.0\.0\.9:8444\/openai\/v1\/responses"\]$/m);
    const siblings = [
      "/v1/responses",
      "/openai/v2/responses",
      "/openai/v1/responses/",
      "/openai/v1/responses/compact",
      "/openai/v1/chat/completions",
      "/openai/v1//responses",
      "/openai//v1/responses",
      "/openai/v1/./responses",
      "/openai/x/../v1/responses",
      "/openai/v1/%72esponses",
      "/OPENAI/v1/responses",
      "/x/openai/v1/responses",
    ];
    // The host's relay: only the exact path reaches the Worker.
    const directory = await temporaryDirectory(t, "strands-model-prefix-");
    const socket = join(directory, "model.sock");
    const bearer = randomBytes(32).toString("base64url");
    const relay = new CredentialSourceRelay(sha(bearer), () => true);
    await relay.listenModel(socket, { host: "10.0.0.9", port: 8444, path }, () => false);
    t.after(() => relay.close());
    for (const sibling of siblings) {
      const reply = await askSource(socket, bearer, boxModelRequest(requestId(), { path: sibling }));
      assert.equal(reply.body?.refusal, "route_unsupported", sibling);
    }
    assert.deepEqual(await relay.collect(0, AbortSignal.timeout(5_000)), []);

    // The Worker's answer check, with the relay bypassed: the exact path only.
    const kube = await fakeKubernetesSecrets(t);
    const f = await pairedFixture(t, { model: { gateway: kube.configuration, route } });
    const signal = AbortSignal.timeout(80_000);
    const { binding } = await activateStageB(f, signal);
    t.after(() => binding.close());
    const key = await registerModelKey(f.gateway!, namespace.id, MODEL_SOURCE_ID, signal);
    const ask = (target: string) =>
      ({
        kind: "model",
        askId: randomUUID(),
        requestId: requestId(),
        bearerSha256: sha(f.bearer),
        deadlineUnixMs: Date.now() + 4_000,
        target: { host: "10.0.0.9", port: 8444, method: "POST", path: target, query: "" },
      }) as ModelAsk;
    for (const sibling of siblings) {
      const reads = kube.calls.length;
      assert.deepEqual(await f.forge(ask(sibling)), { refusal: "request_not_allowed" }, sibling);
      assert.deepEqual(secretReads(kube, reads), []);
    }
    const allowed = await f.forge(ask(path));
    assert.equal(allowed.credential === key, true);
  },
);
