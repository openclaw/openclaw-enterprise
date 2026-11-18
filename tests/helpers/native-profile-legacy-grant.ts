import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type { Page, WebSocket } from "playwright";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createRealKubernetesFixture } from "./kubernetes-real.ts";

type FailureStage =
  | "validation"
  | "legacy-hello"
  | "browser-storage"
  | "paired-record"
  | "key-grant-binding"
  | "positive-pod"
  | "positive-command"
  | "positive-sdk"
  | "invalid-token-control"
  | "positive-device-auth"
  | "positive-authority"
  | "active-grant"
  | "replay";

// Fixed stages keep a failed real run actionable without exposing credentials
// through remote errors, captured output, or assertion actual/expected values.
const failure = (stage: FailureStage = "validation") =>
  new Error(`Legacy browser grant observation or authentication failed [${stage}].`);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
const record = (value: unknown) => {
  const result = asRecord(value);
  if (!result) {
    throw failure();
  }
  return result;
};
const parse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw failure();
  }
};

type Frame = { payload: string | Buffer; socket: WebSocket; page: Page };
type PodScope = {
  namespace: string;
  name: string;
  uid: string;
  agentId: string;
  revisionId: string;
  port: number;
};
type BrowserBinding = {
  deviceId: string;
  publicKey: string;
  clientId: string;
  clientMode: string;
  platform: string;
  clientVersion: string;
  clientBuildId?: string;
  instanceId?: string;
  origin: string;
  scopes: string[];
};
type NativeDevice = { deviceId: string; publicKeyPem: string; privateKeyPem: string };

// This subprocess boundary privately captures even failed stdout/stderr. Neither
// exec errors nor their command/cause/output can escape into node:test reports.
async function privateKubectl(args: string[], input = ""): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.env.OCC_KUBECTL_BIN ?? "kubectl",
      [
        "--kubeconfig",
        process.env.OCC_TEST_KUBERNETES_KUBECONFIG ?? "",
        "--context",
        process.env.OCC_TEST_KUBERNETES_CONTEXT ?? "",
        ...args,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, 45_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 65_536) {
        failed = true;
        child.kill("SIGKILL");
      } else {
        output += chunk.toString("utf8");
      }
    });
    child.stderr.resume();
    child.on("error", () => {
      failed = true;
    });
    child.stdin.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        reject(failure());
      } else {
        resolve(output);
      }
    });
    child.stdin.end(input);
  });
}

async function assertOwnedPod(scope: PodScope) {
  const pod = record(
    parse(
      await privateKubectl([
        "get",
        "pod",
        scope.name,
        "--namespace",
        scope.namespace,
        "-o",
        "json",
      ]),
    ),
  );
  const metadata = record(pod.metadata);
  const labels = record(metadata.labels);
  if (
    metadata.uid !== scope.uid ||
    metadata.namespace !== scope.namespace ||
    labels["openclaw.dev/agent"] !== scope.agentId ||
    labels["openclaw.dev/revision"] !== scope.revisionId
  ) {
    throw failure();
  }
}

const pairedRead = String.raw`
import { DatabaseSync } from "node:sqlite";
let input = ""; for await (const chunk of process.stdin) { input += chunk; }
const {deviceId} = JSON.parse(input);
const db = new DatabaseSync("/home/node/.openclaw/state/openclaw.sqlite", {readOnly:true});
try {
  db.exec("PRAGMA busy_timeout=5000");
  const row = db.prepare("SELECT device_id, public_key, client_id, client_mode, browser_origin, role, roles_json, approved_scopes_json, tokens_json, approved_via FROM device_pairing_paired WHERE device_id = ?").get(deviceId);
  process.stdout.write(JSON.stringify(row ?? null));
} finally { db.close(); }
`;

async function pairedGrant(scope: PodScope, deviceId: string) {
  await assertOwnedPod(scope);
  // The device id and returned grant travel only over private stdin/stdout, not argv.
  return parse(
    await privateKubectl(
      [
        "exec",
        "-i",
        scope.name,
        "--namespace",
        scope.namespace,
        "--container",
        "gateway",
        "--",
        "node",
        "--input-type=module",
        "-e",
        pairedRead,
      ],
      JSON.stringify({ deviceId }),
    ),
  );
}

// Only the controller workspace declares this public SDK. The old native image
// deliberately omits workspace package trees; do not resolve it from that image.
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);

export function legacySdkHostDeps() {
  return {
    loadOrCreateDeviceIdentity: () => undefined,
    loadDeviceAuthToken: (_input?: unknown) => null,
    storeDeviceAuthToken: (_input?: unknown) => {},
    clearDeviceAuthToken: (_input?: unknown) => {},
    logDebug: (_message?: unknown) => {},
    logError: (_message?: unknown) => {},
    signDevicePayload: (pem: string, payload: string) => {
      try {
        return sign(null, Buffer.from(payload), pem).toString("base64url");
      } catch {
        throw failure("key-grant-binding");
      }
    },
    publicKeyRawBase64UrlFromPem: (pem: string) => {
      try {
        const key = createPublicKey(pem).export({ format: "jwk" }).x;
        if (!key) {
          throw failure();
        }
        return key;
      } catch {
        throw failure("key-grant-binding");
      }
    },
  };
}

// Narrow views of the installed SDK's public constructor/options. Dynamic import
// remains unknown until checked, following the fixture dependency-loading owner.
type LegacySdkClient = {
  start(): void;
  stop(): void;
  stopAndWait(options: { timeoutMs: number }): Promise<void>;
  request(method: string, params: unknown, options: { timeoutMs: number }): Promise<unknown>;
};
type LegacySdkOptions = {
  url: string;
  origin: string;
  clientName: string;
  mode: string;
  platform: string;
  clientVersion: string;
  clientBuildId?: string;
  instanceId?: string;
  role: "operator";
  scopes: string[];
  deviceIdentity: NativeDevice;
  deviceToken: string;
  hostDeps: ReturnType<typeof legacySdkHostDeps>;
  onHelloOk: (hello: unknown) => void;
  onConnectError: (error: unknown) => void;
};
type LegacySdkConstructor = new (options: LegacySdkOptions) => LegacySdkClient;
function hasLegacySdk(value: unknown): value is { GatewayClient: LegacySdkConstructor } {
  return typeof asRecord(value)?.GatewayClient === "function";
}
export async function legacyGatewayClientConstructor() {
  try {
    const loaded: unknown = await import(
      pathToFileURL(controllerRequire.resolve("@openclaw/gateway-client")).href
    );
    if (!hasLegacySdk(loaded)) {
      throw failure();
    }
    return loaded.GatewayClient;
  } catch {
    throw failure("positive-sdk");
  }
}

export function legacyDeviceAuthResult(hello: unknown, rpcCompleted: boolean) {
  const auth = asRecord(asRecord(hello)?.auth);
  return {
    connected: true,
    tokenMismatch: false,
    deviceAuth: auth?.method === "device-token",
    operator: auth?.role === "operator",
    admin: strings(auth?.scopes) && auth.scopes.includes("operator.admin"),
    rpcCompleted,
  };
}

async function legacyDeviceConnect(
  GatewayClient: LegacySdkConstructor,
  input: BrowserBinding & { url: string; deviceIdentity: NativeDevice; deviceToken: string },
  readHealth: boolean,
) {
  let client: LegacySdkClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hello = await new Promise<unknown>((resolve, reject) => {
      client = new GatewayClient({
        url: input.url,
        origin: input.origin,
        clientName: input.clientId,
        mode: input.clientMode,
        platform: input.platform,
        clientVersion: input.clientVersion,
        ...(input.clientBuildId === undefined ? {} : { clientBuildId: input.clientBuildId }),
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        role: "operator",
        scopes: input.scopes,
        deviceIdentity: input.deviceIdentity,
        deviceToken: input.deviceToken,
        hostDeps: legacySdkHostDeps(),
        onHelloOk: resolve,
        onConnectError: reject,
      });
      timer = setTimeout(() => reject(failure("positive-command")), 15_000);
      client.start();
    });
    if (readHealth) {
      if (!client) {
        throw failure();
      }
      await client.request("health", {}, { timeoutMs: 15_000 });
    }
    return legacyDeviceAuthResult(hello, readHealth);
  } catch (error) {
    return {
      connected: false,
      deviceAuth: false,
      operator: false,
      admin: false,
      rpcCompleted: false,
      tokenMismatch: asRecord(asRecord(error)?.details)?.authReason === "device_token_mismatch",
    };
  } finally {
    clearTimeout(timer);
    try {
      client?.stop();
    } finally {
      await client?.stopAndWait({ timeoutMs: 1_000 });
    }
  }
}

type LegacyForward = { url: string; stop(): Promise<void> };
export async function withLegacyGrantForward<Result>(
  context: Pick<TestContext, "after">,
  acquire: () => Promise<LegacyForward>,
  assertCurrentPod: () => Promise<void>,
  run: (url: string) => Promise<Result>,
): Promise<Result> {
  let stop: (() => Promise<void>) | undefined;
  let outcome: { ok: true; value: Result } | { ok: false };
  try {
    await assertCurrentPod();
    const forward = await acquire();
    let stopping: Promise<void> | undefined;
    stop = () => (stopping ??= forward.stop());
    context.after(async () => {
      try {
        await stop?.();
      } catch {
        throw failure("positive-command");
      }
    });
    const endpoint = new URL(forward.url);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      !endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw failure();
    }
    // A different Pod must not receive an already captured device credential.
    await assertCurrentPod();
    outcome = { ok: true, value: await run(forward.url) };
  } catch {
    outcome = { ok: false };
  } finally {
    try {
      await stop?.();
    } catch {
      outcome = { ok: false };
    }
  }
  if (!outcome.ok) {
    throw failure("positive-command");
  }
  return outcome.value;
}

// The constructor consumes actual observations in the real caller; dependency-
// independent tests use generated Ed25519 keys and native-owned row shapes only.
// Credential material is private class state, not serializable fixture evidence.
export class LegacyBrowserGrant {
  #binding: BrowserBinding;
  #device: NativeDevice;
  #token: string;
  #grantSnapshot: string;
  #positive = false;
  #refused = false;

  constructor(binding: BrowserBinding, storedIdentity: unknown, paired: unknown) {
    try {
      const identity = record(storedIdentity);
      if (
        identity.version !== 1 ||
        identity.deviceId !== binding.deviceId ||
        identity.publicKey !== binding.publicKey ||
        typeof identity.privateKey !== "string"
      ) {
        throw failure();
      }
      const bytes = Buffer.from(binding.publicKey, "base64url");
      if (
        bytes.length !== 32 ||
        createHash("sha256").update(bytes).digest("hex") !== binding.deviceId
      ) {
        throw failure();
      }
      const privateKey = createPrivateKey({
        format: "jwk",
        key: { kty: "OKP", crv: "Ed25519", d: identity.privateKey, x: binding.publicKey },
      });
      const publicKey = createPublicKey(privateKey);
      if (publicKey.export({ format: "jwk" }).x !== binding.publicKey) {
        throw failure();
      }
      const challenge = Buffer.from("owned browser key binding " + randomUUID());
      if (!verify(null, challenge, publicKey, sign(null, challenge, privateKey))) {
        throw failure();
      }
      this.#binding = structuredClone(binding);
      this.#device = {
        deviceId: binding.deviceId,
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
        privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      };
      const grant = this.#readGrant(paired);
      this.#token = grant.token;
      this.#grantSnapshot = grant.snapshot;
    } catch {
      throw failure();
    }
  }

  #readGrant(value: unknown) {
    const row = record(value);
    const binding = this.#binding;
    const roles = typeof row.roles_json === "string" ? parse(row.roles_json) : undefined;
    const approved =
      typeof row.approved_scopes_json === "string" ? parse(row.approved_scopes_json) : undefined;
    const tokens = typeof row.tokens_json === "string" ? record(parse(row.tokens_json)) : {};
    const operator = record(tokens.operator);
    // Control UI pairing stores no browser_origin: only browser-copilot clients
    // persist that field in b589. Bind the actual browser Origin on both probes.
    if (
      row.device_id !== binding.deviceId ||
      row.public_key !== binding.publicKey ||
      row.client_id !== binding.clientId ||
      row.client_mode !== binding.clientMode ||
      row.browser_origin !== null ||
      row.approved_via !== "trusted-proxy" ||
      !(row.role === "operator" || (strings(roles) && roles.includes("operator"))) ||
      !strings(approved) ||
      !approved.includes("operator.admin") ||
      operator.role !== "operator" ||
      !strings(operator.scopes) ||
      !operator.scopes.includes("operator.admin") ||
      operator.scopes.some((scope) => !scope.startsWith("operator.")) ||
      operator.revokedAtMs !== undefined ||
      typeof operator.token !== "string" ||
      !operator.token
    ) {
      throw failure();
    }
    return {
      token: operator.token,
      snapshot: JSON.stringify({
        scopes: [...operator.scopes].sort(),
        approved: [...approved].sort(),
        createdAtMs: operator.createdAtMs,
        rotatedAtMs: operator.rotatedAtMs,
        issuer: operator.issuer,
      }),
    };
  }

  assertCurrent(paired: unknown) {
    try {
      const current = this.#readGrant(paired);
      if (current.token !== this.#token || current.snapshot !== this.#grantSnapshot) {
        throw failure();
      }
    } catch {
      throw failure();
    }
  }

  async proveBeforeCutover(scope: PodScope, context: Pick<TestContext, "after">) {
    let stage: FailureStage = "positive-pod";
    try {
      await withLegacyGrantForward(
        context,
        async () => {
          stage = "positive-command";
          const fixture = createRealKubernetesFixture({
            kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
            kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
          });
          return await fixture.startPortForwardTarget(
            scope.namespace,
            `pod/${scope.name}`,
            `0:${scope.port}`,
          );
        },
        async () => {
          stage = "positive-pod";
          await assertOwnedPod(scope);
        },
        async (endpoint) => {
          stage = "positive-sdk";
          const GatewayClient = await legacyGatewayClientConstructor();
          const input = {
            ...this.#binding,
            url: endpoint.replace(/^http/, "ws"),
            deviceIdentity: this.#device,
          };
          stage = "invalid-token-control";
          const invalid = await legacyDeviceConnect(
            GatewayClient,
            { ...input, deviceToken: "invalid-owned-control-" + randomUUID() },
            false,
          );
          if (invalid.connected || !invalid.tokenMismatch) {
            throw failure();
          }
          stage = "positive-device-auth";
          const valid = await legacyDeviceConnect(
            GatewayClient,
            { ...input, deviceToken: this.#token },
            true,
          );
          if (!valid.connected || !valid.deviceAuth) {
            throw failure();
          }
          stage = "positive-authority";
          if (!valid.operator || !valid.admin || !valid.rpcCompleted) {
            throw failure();
          }
          // Normal auth may update last-used metadata, but must not leave the
          // replay using a rotated/revoked grant and produce a false security pass.
          stage = "active-grant";
          this.assertCurrent(await pairedGrant(scope, this.#binding.deviceId));
          stage = "positive-command";
        },
      );
      this.#positive = true;
    } catch {
      throw failure(stage);
    }
  }

  async assertReplayRefused(probe: (native: object) => Promise<unknown>) {
    try {
      if (!this.#positive) {
        throw failure();
      }
      const result = record(
        await probe({
          deviceToken: this.#token,
          deviceIdentity: this.#device,
          origin: this.#binding.origin,
          clientName: this.#binding.clientId,
          mode: this.#binding.clientMode,
          platform: this.#binding.platform,
          clientVersion: this.#binding.clientVersion,
          clientBuildId: this.#binding.clientBuildId,
          instanceId: this.#binding.instanceId,
          scopes: this.#binding.scopes,
        }),
      );
      if (result.connected !== false || result.authReason !== "trusted_proxy_delegation_denied") {
        throw failure();
      }
      this.#refused = true;
    } catch {
      throw failure("replay");
    }
  }

  completedChecks() {
    return legacyGrantChecks({
      helloTokenOmitted: true,
      actualPersistedGrantBound: true,
      positiveMatchingKeyAuth: this.#positive,
      afterReplayRefused: this.#refused,
    });
  }
}

export function legacyGrantChecks(value: unknown) {
  const checks = record(value);
  if (
    checks.helloTokenOmitted !== true ||
    checks.actualPersistedGrantBound !== true ||
    checks.positiveMatchingKeyAuth !== true ||
    checks.afterReplayRefused !== true
  ) {
    throw failure();
  }
  return {
    helloTokenOmitted: true,
    actualPersistedGrantBound: true,
    positiveMatchingKeyAuth: true,
    afterReplayRefused: true,
  };
}

export function legacyBrowserHandshake(
  outgoing: unknown,
  incoming: unknown,
  origin: string,
): BrowserBinding {
  try {
    const connect = record(outgoing);
    const response = record(incoming);
    const params = record(connect.params);
    const client = record(params.client);
    const device = record(params.device);
    const hello = record(response.payload);
    const auth = record(hello.auth);
    const requestedScopes = params.scopes;
    if (
      connect.type !== "req" ||
      connect.method !== "connect" ||
      typeof connect.id !== "string" ||
      response.type !== "res" ||
      response.id !== connect.id ||
      response.ok !== true ||
      hello.type !== "hello-ok" ||
      client.id !== "openclaw-control-ui" ||
      client.mode !== "webchat" ||
      typeof client.platform !== "string" ||
      typeof client.version !== "string" ||
      params.role !== "operator" ||
      auth.method !== "trusted-proxy" ||
      auth.role !== "operator" ||
      !strings(auth.scopes) ||
      !auth.scopes.includes("operator.admin") ||
      !strings(requestedScopes) ||
      auth.scopes.some((scope) => !requestedScopes.includes(scope)) ||
      Object.hasOwn(auth, "deviceToken") ||
      typeof device.id !== "string" ||
      typeof device.publicKey !== "string" ||
      typeof device.signature !== "string" ||
      !device.signature ||
      typeof device.signedAt !== "number" ||
      typeof device.nonce !== "string" ||
      !device.nonce ||
      new URL(origin).origin !== origin
    ) {
      throw failure();
    }
    return {
      deviceId: device.id,
      publicKey: device.publicKey,
      clientId: client.id,
      clientMode: client.mode,
      platform: client.platform,
      clientVersion: client.version,
      ...(typeof client.buildId === "string" ? { clientBuildId: client.buildId } : {}),
      ...(typeof client.instanceId === "string" ? { instanceId: client.instanceId } : {}),
      origin,
      scopes: auth.scopes,
    };
  } catch {
    throw failure();
  }
}

export async function observeLegacyBrowserGrant({
  page,
  sent,
  received,
  origin,
  scope,
}: {
  page: Page;
  sent: Frame[];
  received: Frame[];
  origin: string;
  scope: PodScope;
}) {
  let stage: FailureStage = "legacy-hello";
  try {
    const expectedSocketOrigin = origin.replace(/^http/, "ws");
    if (new URL(page.url()).origin !== origin) {
      throw failure();
    }
    for (const outgoing of sent.filter(
      (frame) => frame.page === page && new URL(frame.socket.url()).origin === expectedSocketOrigin,
    )) {
      const connect = record(parse(outgoing.payload.toString()));
      if (
        connect.type !== "req" ||
        connect.method !== "connect" ||
        typeof connect.id !== "string"
      ) {
        continue;
      }
      const responseFrame = received.find((frame) => {
        if (frame.socket !== outgoing.socket) {
          return false;
        }
        const response = record(parse(frame.payload.toString()));
        return response.type === "res" && response.id === connect.id && response.ok === true;
      });
      if (!responseFrame) {
        continue;
      }
      const binding = legacyBrowserHandshake(
        connect,
        parse(responseFrame.payload.toString()),
        origin,
      );
      stage = "browser-storage";
      const stored: unknown = await page.evaluate(() => {
        const raw = localStorage.getItem("openclaw-device-identity-v1");
        return raw === null ? null : JSON.parse(raw);
      });
      stage = "paired-record";
      const paired = await pairedGrant(scope, binding.deviceId);
      stage = "key-grant-binding";
      return new LegacyBrowserGrant(binding, stored, paired);
    }
    throw failure();
  } catch {
    throw failure(stage);
  }
}
