import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";

/** Reject the complete bundle without retaining rejected bytes in diagnostics. */
export function destinationCaCertificate(pem: string): X509Certificate {
  const certificate = pem.trim();
  const match =
    /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----$/u.exec(
      certificate,
    );
  const body = match?.[1];
  if (!body) {
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
  const payload = Buffer.from(body.replace(/[\r\n]/gu, ""), "base64");
  if (!payload.equals(parsed.raw)) {
    throw new Error(
      "destination trust must contain exactly one certificate and no private material",
    );
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

/** Check cluster readback without retaining rejected ConfigMap contents in errors. */
export function assertStockDestinationCaReadback(value: unknown, expectedPem?: string): void {
  const map = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const data =
    map.data !== null && typeof map.data === "object" && !Array.isArray(map.data)
      ? (map.data as Record<string, unknown>)
      : undefined;
  if (
    !data ||
    Object.keys(data).length !== 1 ||
    typeof data["ca.crt"] !== "string" ||
    (expectedPem !== undefined && data["ca.crt"] !== expectedPem) ||
    map.binaryData !== undefined
  ) {
    throw new Error("destination CA ConfigMap readback does not match the certificate-only input");
  }
}

/** The stock chart projects exactly the certificate key to the mounted subpath. */
export function assertStockDestinationCaProjection(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Supervisor CA volume has an unexpected key-to-path mapping");
  }
  const item: unknown = value[0];
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Supervisor CA volume has an unexpected key-to-path mapping");
  }
  const mapping = item as Record<string, unknown>;
  if (Object.keys(mapping).length !== 2 || mapping.key !== "ca.crt" || mapping.path !== "ca.crt") {
    throw new Error("Supervisor CA volume has an unexpected key-to-path mapping");
  }
}
