import { generateKeyPairSync } from "node:crypto";

const keyPairs = new Map();

// An RSA-2048 key costs 50-300 ms of CPU to generate, and fixtures made one for every
// GitHub App, TLS listener and CA they started: about 30 CPU-seconds per Checks 2 run.
// Fixtures that need a key but not a unique one share this per-process key pair for each
// `name`. createTlsMaterial (process.mjs) mints one certificate per process from its key;
// other certificates made from these keys are still minted per call. Two certificates with
// the same subject and key verify each other, so a test that proves a peer with an
// untrusted certificate is refused must give the two sides different names. It lives here, and
// imports only node:, because the isolation tests mount just this directory into containers.
export function sharedRsaKeyPair(name = "default") {
  let keyPair = keyPairs.get(name);
  if (keyPair === undefined) {
    keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPairs.set(name, keyPair);
  }
  return keyPair;
}

/** The PKCS#8 PEM of `sharedRsaKeyPair(name)`, for `openssl req -key` and TLS listeners. */
export function sharedRsaPrivateKeyPem(name = "default") {
  return sharedRsaKeyPair(name).privateKey.export({ type: "pkcs8", format: "pem" });
}
