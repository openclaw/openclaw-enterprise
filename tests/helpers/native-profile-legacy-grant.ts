import type { Page, WebSocket } from "playwright";
import { asRecord } from "../../packages/utils/src/index.ts";

// Only public pairing metadata is observed. Never read browser signing storage,
// native databases, or bearer credentials to qualify this software upgrade.
const failure = () => new Error("Legacy browser pairing metadata observation failed.");
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
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

type Frame = { payload: string | Buffer; socket: WebSocket; page: Page };
type BrowserBinding = {
  deviceId: string;
  publicKey: string;
  clientId: string;
  clientMode: string;
};

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
      !device.id ||
      typeof device.publicKey !== "string" ||
      !device.publicKey ||
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
    };
  } catch {
    throw failure();
  }
}

// The pinned native device.pair.list contract returns redacted token summaries
// as an array, not the persisted token map. Control UI has no browserOrigin
// pairing field; its page/socket origin is bound by the observer below.
export function legacyPairingMetadata(binding: BrowserBinding, payload: unknown) {
  try {
    const list = record(payload);
    if (!Array.isArray(list.pending) || !Array.isArray(list.paired)) {
      throw failure();
    }
    const matches = list.paired.filter(
      (entry: unknown) => asRecord(entry)?.deviceId === binding.deviceId,
    );
    if (matches.length !== 1) {
      throw failure();
    }
    const paired = record(matches[0]);
    const roles = paired.roles;
    if (
      paired.publicKey !== binding.publicKey ||
      paired.clientId !== binding.clientId ||
      paired.clientMode !== binding.clientMode ||
      paired.approvedVia !== "trusted-proxy" ||
      !(paired.role === "operator" || (strings(roles) && roles.includes("operator"))) ||
      !timestamp(paired.createdAtMs) ||
      !timestamp(paired.approvedAtMs) ||
      !Array.isArray(paired.tokens) ||
      Object.hasOwn(paired, "approvedScopes") ||
      Object.hasOwn(paired, "privateKey") ||
      Object.hasOwn(paired, "tokens_json")
    ) {
      throw failure();
    }
    const operators = paired.tokens.filter(
      (entry: unknown) => asRecord(entry)?.role === "operator",
    );
    if (operators.length !== 1) {
      throw failure();
    }
    const operator = record(operators[0]);
    if (
      !strings(operator.scopes) ||
      !operator.scopes.includes("operator.admin") ||
      !timestamp(operator.createdAtMs) ||
      operator.revokedAtMs !== undefined ||
      Object.hasOwn(operator, "token")
    ) {
      throw failure();
    }
    // Project only the public identity and original approval metadata. A last-use
    // update is not a new pairing, and no bearer usability is inferred here.
    return {
      deviceId: binding.deviceId,
      publicKey: binding.publicKey,
      clientId: binding.clientId,
      clientMode: binding.clientMode,
      approvedVia: "trusted-proxy",
      createdAtMs: paired.createdAtMs,
      approvedAtMs: paired.approvedAtMs,
      operatorTokenCreatedAtMs: operator.createdAtMs,
    };
  } catch {
    throw failure();
  }
}

export async function observeLegacyBrowserPairing({
  page,
  sent,
  received,
  origin,
  readPairingList,
}: {
  page: Page;
  sent: Frame[];
  received: Frame[];
  origin: string;
  readPairingList: () => Promise<unknown>;
}) {
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
      return legacyPairingMetadata(binding, await readPairingList());
    }
    throw failure();
  } catch {
    // Do not attach response bodies or remote errors to node:test failures.
    throw failure();
  }
}
