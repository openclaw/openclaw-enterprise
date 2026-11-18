import assert from "node:assert/strict";

import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import type { OpenShellBackendConfiguration } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

const raw = process.argv[2];
assert.ok(raw, "expected the parent fixture's gateway configuration");
const parseConfiguration: (value: string) => unknown = JSON.parse;
const configuration = asRecord(parseConfiguration(raw));
assert.ok(configuration && typeof configuration.requestTimeoutMs === "number");

const settings = {
  requestTimeoutMs: configuration.requestTimeoutMs,
};
let backend: OpenShellBackendConfiguration;
if (typeof configuration.endpoint === "string") {
  backend = { ...settings, endpoint: configuration.endpoint };
} else {
  const { serviceName, scheme, port } = configuration;
  assert.ok(typeof serviceName === "string" && scheme === "http" && typeof port === "number");
  backend = { ...settings, serviceName, scheme, port };
}

const gateway = new OpenShellGateway(backend);
try {
  await gateway.clientForNamespace("tenant-workspace").health(AbortSignal.timeout(2000));
  process.stdout.write("healthy\n");
} finally {
  gateway.close();
}
