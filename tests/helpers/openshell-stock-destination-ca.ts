import { createHash, X509Certificate } from "node:crypto";

const singleCertificate =
  "destination trust must contain exactly one certificate and no private material";

export function stockDestinationCa(namespace: string, name: string, pem: string) {
  const body =
    /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END CERTIFICATE-----$/u.exec(
      pem.trim(),
    )?.[1];
  if (!body) {
    throw new Error(singleCertificate);
  }

  // Some X.509 parsers accept an auxiliary trust record appended to the DER.
  const encoded = body.replace(/[\r\n]/gu, "");
  const der = Buffer.from(encoded, "base64");
  if (der.toString("base64") !== encoded) {
    throw new Error(singleCertificate);
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    throw new Error("destination trust must contain a valid certificate");
  }
  if (!der.equals(certificate.raw)) {
    throw new Error(singleCertificate);
  }
  if (!certificate.ca) {
    throw new Error("destination certificate must be a CA");
  }

  return {
    configMap: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { namespace, name },
      immutable: true,
      data: { "ca.crt": pem },
    },
    normalizedPem: certificate.toString(),
  };
}

export function stockManagedDestinationCa(namespace: string, gatewayId: string, pem: string) {
  // Stock OpenShell names each immutable generation by gateway ID and normalized bundle.
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const generation = `sha256:${sha256(pem)}`;
  const name = `openshell-additional-ca-${sha256(gatewayId).slice(0, 12)}-${sha256(generation).slice(0, 26)}`;
  return { namespace, name, pem, owner: { gatewayId, generation } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keep unexpected ConfigMap contents out of the failure diagnostics. */
export function assertStockDestinationCaReadback(
  value: unknown,
  expected: {
    namespace: string;
    name: string;
    pem: string;
    owner?: { gatewayId: string; generation: string };
  },
): void {
  const map = asRecord(value);
  const identity = asRecord(map?.metadata);
  if (
    !map ||
    map.kind !== "ConfigMap" ||
    identity?.namespace !== expected.namespace ||
    identity?.name !== expected.name
  ) {
    throw new Error("destination CA ConfigMap identity does not match");
  }
  if (expected.owner) {
    if ("ownerReferences" in identity) {
      throw new Error("managed destination CA ConfigMap must omit ownerReferences");
    }
    const labels = asRecord(identity.labels);
    const annotations = asRecord(identity.annotations);
    if (
      labels?.["openshell.ai/managed-by"] !== "openshell" ||
      labels?.["openshell.ai/gateway-id"] !== expected.owner.gatewayId ||
      annotations?.["openshell.ai/additional-ca-generation"] !== expected.owner.generation
    ) {
      throw new Error("managed destination CA ConfigMap generation does not match");
    }
  }
  const data = asRecord(map.data);
  if (
    map.immutable !== true ||
    map.binaryData !== undefined ||
    !data ||
    Object.keys(data).length !== 1 ||
    data["ca.crt"] !== expected.pem
  ) {
    throw new Error("destination CA ConfigMap does not match the certificate-only input");
  }
}

export function assertStockDestinationCaProjection(value: unknown, expectedName: string): void {
  const configMap = asRecord(value);
  if (configMap?.name !== expectedName) {
    throw new Error("Supervisor must project the managed destination CA ConfigMap");
  }
  const items = configMap.items;
  const mapping = Array.isArray(items) && items.length === 1 ? asRecord(items[0]) : undefined;
  if (
    !mapping ||
    Object.keys(mapping).length !== 2 ||
    mapping.key !== "ca.crt" ||
    mapping.path !== "ca.crt"
  ) {
    throw new Error("Supervisor CA volume must project only ca.crt to ca.crt");
  }
}
