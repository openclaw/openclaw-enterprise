import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve the same published client as the controller, not a second protocol implementation.
const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);

export function createProbeDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    deviceId: createHash("sha256").update(rawPublicKey(publicKeyPem)).digest("hex"),
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function rawPublicKey(pem) {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  assert.equal(der.length, prefix.length + 32);
  assert.ok(der.subarray(0, prefix.length).equals(prefix));
  return der.subarray(prefix.length);
}

// No persistent device store: every probe explicitly supplies its authority. The real
// Gateway validates the client's signed connect challenge and issues the device token.
export async function connectNativeGateway(options) {
  const { GatewayClient } = await import(
    pathToFileURL(controllerRequire.resolve("@openclaw/gateway-client")).href
  );
  let accept;
  let refuse;
  const hello = new Promise((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  const client = new GatewayClient({
    ...options,
    hostDeps: {
      signDevicePayload: (key, payload) =>
        sign(null, Buffer.from(payload), key).toString("base64url"),
      publicKeyRawBase64UrlFromPem: (key) => rawPublicKey(key).toString("base64url"),
      loadDeviceAuthToken: () => null,
      storeDeviceAuthToken: () => {},
      clearDeviceAuthToken: () => {},
      // Handshake failures are reported below as codes only, never raw transport errors.
      logDebug: () => {},
      logError: () => {},
    },
    onHelloOk: accept,
    onConnectError: refuse,
  });
  const timer = setTimeout(
    () => refuse(new Error("Gateway authority handshake timed out")),
    15_000,
  );
  const close = async () => {
    client.stop();
    await client.stopAndWait({ timeoutMs: 1_000 });
  };
  try {
    client.start();
    const connected = await hello;
    return { client, hello: connected, close };
  } catch (error) {
    await close();
    // Do not retain the raw error/cause: URLs, setup bearers and device tokens are private.
    const rejected = new Error("Native Gateway rejected the authority handshake");
    rejected.code = error?.code;
    rejected.detailCode = error?.details?.code;
    throw rejected;
  } finally {
    clearTimeout(timer);
  }
}

export async function expectNativeAuthorityDenied(options, detailCode) {
  let admitted;
  let failure;
  try {
    admitted = await connectNativeGateway(options);
  } catch (error) {
    failure = error;
  } finally {
    await admitted?.close();
  }
  assert.ok(failure, "the other Agent or expired authority must not connect");
  assert.equal(failure.code, "INVALID_REQUEST");
  assert.equal(failure.detailCode, detailCode, "require the Gateway's causal auth rejection");
  return { code: failure.code, detailCode: failure.detailCode };
}

export function decodeNativeSetup(setup) {
  assert.equal(setup.access, "node");
  assert.ok(typeof setup.setupId === "string" && setup.setupId.length > 0);
  const encoded = setup.setupCode.toLowerCase().startsWith("oc-pair://")
    ? setup.setupCode.slice("oc-pair://".length)
    : setup.setupCode;
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("The Gateway issued an invalid native setup envelope");
  }
  assert.equal(envelope.expiresAtMs, setup.expiresAtMs);
  assert.ok(typeof envelope.bootstrapToken === "string" && envelope.bootstrapToken.length > 0);
  assert.ok(Number.isSafeInteger(setup.expiresAtMs) && setup.expiresAtMs > Date.now());
  return envelope;
}
