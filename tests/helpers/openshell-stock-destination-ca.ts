import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";

/** Reject the complete bundle without retaining rejected bytes in diagnostics. */
export function destinationCaCertificate(pem: string): X509Certificate {
  const certificate = pem.trim();
  if (
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/u.test(
      certificate,
    )
  ) {
    throw new Error(
      "destination trust must contain exactly one certificate and no private material",
    );
  }
  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(certificate);
  } catch {
    throw new Error("destination trust must contain a valid certificate");
  }
  assert.equal(parsed.ca, true, "destination certificate must be a CA");
  return parsed;
}

/** Prepare the stock chart's certificate-only destination trust input. */
export function stockDestinationCa(namespace: string, name: string, pem: string) {
  assert.match(namespace, /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u);
  assert.match(name, /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u);
  destinationCaCertificate(pem);
  return {
    configMap: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { namespace, name },
      immutable: true,
      data: { "ca.crt": pem },
    },
    network: { additionalCaConfigMapName: name },
  };
}
