import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.ts";
import { caAndLeaf, type OpenSslRunner } from "./certificates.ts";

interface ModelProbeCertificateOptions {
  directory: string;
  caName: string;
  run?: OpenSslRunner | undefined;
  slackStandIn?: boolean;
}

// Callers own subprocess policy and cleanup. The CA and leaf each reuse their
// own process-cached RSA key, and both certificates are minted for every call.
export async function createModelProbeCertificates({
  directory,
  caName,
  run,
  slackStandIn = false,
}: ModelProbeCertificateOptions): Promise<void> {
  const caKeyPem: unknown = sharedRsaPrivateKeyPem("model-probe-ca");
  const leafKeyPem: unknown = sharedRsaPrivateKeyPem("model-probe-leaf");
  if (typeof caKeyPem !== "string" || typeof leafKeyPem !== "string") {
    throw new Error("Model probe fixture keys must be PEM text");
  }
  await caAndLeaf(directory, {
    caName,
    commonName: "api.openai.com",
    subjectAltName: slackStandIn
      ? "DNS:api.openai.com,DNS:slack.com,DNS:wss-primary.slack.com"
      : "DNS:api.openai.com",
    caKeyPem,
    leafKeyPem,
    run,
  });
}
