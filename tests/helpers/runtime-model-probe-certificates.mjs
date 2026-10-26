import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.mjs";
import { caAndLeaf } from "./certificates.mjs";

// Callers own subprocess policy and cleanup: image tests remove the CA key,
// while the first-Agent smoke retains it. The CA and leaf keys are the process's
// shared fixture keys (shared-keys.mjs); both certificates are minted per call.
export async function createModelProbeCertificates({ directory, caName, run }) {
  await caAndLeaf(directory, {
    caName,
    commonName: "api.openai.com",
    subjectAltName: "DNS:api.openai.com",
    caKeyPem: sharedRsaPrivateKeyPem("model-probe-ca"),
    leafKeyPem: sharedRsaPrivateKeyPem("model-probe-leaf"),
    run,
  });
}
