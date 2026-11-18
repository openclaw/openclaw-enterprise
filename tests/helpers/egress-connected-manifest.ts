import assert from "node:assert/strict";
import { isIP } from "node:net";
import { isAbsolute, posix } from "node:path";
import { isRecord, parseJson, readString, record } from "./egress-observation-values.ts";
import type { ConnectedStackInputs } from "./egress-upgrade-contracts.ts";

type ControllerSelection = {
  apiOrigin: string;
  namespaceId: unknown;
  model: unknown;
  providerOrigin: unknown;
};

type ValidationProfile = {
  wholeExecution?: boolean;
  allowControllerUpgrade?: boolean;
};

// The runner chooses where its service credential can go. The separate stack
// manifest is checked against that choice, never used to select a credential file.
export function takeConnectedControllerBinding(env: NodeJS.ProcessEnv) {
  const serviceKey = env.OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY;
  delete env.OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY; // Do not pass it to kubectl or other children.
  assert.ok(
    typeof serviceKey === "string" && serviceKey.length > 0 && !/\s/.test(serviceKey),
    "the runner must supply the prepared controller service key",
  );
  const binding = record(parseJson(readString(env.OCC_TEST_EGRESS_CONNECTED_CONTROLLER)));
  const apiOrigin = readString(binding.apiOrigin);
  const { namespaceId, model, providerOrigin } = binding;
  const api = new URL(apiOrigin);
  assert.ok(
    (api.protocol === "http:" || api.protocol === "https:") &&
      api.hostname === "127.0.0.1" &&
      Number(api.port) > 1024 &&
      api.origin === apiOrigin,
    "select the controller's exact 127.0.0.1 origin and explicit high port",
  );
  return { apiOrigin, namespaceId, model, providerOrigin, serviceKey };
}

// Inputs describe an already installed, disposable protected stack. They do not
// authorize this test to install a gateway, change trust, or relax admission.
export function validateConnectedInputs(
  input: unknown,
  controller: ControllerSelection,
  profile: ValidationProfile = {},
): ConnectedStackInputs {
  assertConnectedManifest(input, controller, profile);
  return input;
}

function assertConnectedManifest(
  input: unknown,
  controller: ControllerSelection,
  { wholeExecution = false, allowControllerUpgrade = false }: ValidationProfile,
): asserts input is ConnectedStackInputs {
  assert.ok(isRecord(input));
  const providerInput = record(input.provider);
  const backend = record(input.openShellBackend);
  const images = record(input.images);
  assert.equal(input.version, 2);
  assert.equal(input.apiOrigin, controller.apiOrigin, "controller origin disagrees with runner");
  assert.equal(input.namespaceId, controller.namespaceId, "tenant disagrees with runner");
  assert.equal(input.model, controller.model, "model disagrees with runner");
  assert.equal(providerInput.origin, controller.providerOrigin, "fixture disagrees with runner");
  assert.equal(input.serviceKeyPath, undefined, "manifest must not select a controller key file");
  assert.match(readString(input.namespaceId ?? ""), /^ns_[A-Za-z0-9_-]+$/);
  assert.match(readString(input.model ?? ""), /^[a-zA-Z0-9][a-zA-Z0-9._-]+$/);
  for (const path of [
    input.kubeconfigPath,
    providerInput.certificatePath,
    providerInput.privateKeyPath,
    backend.rootCertificatePath,
  ]) {
    assert.ok(
      typeof path === "string" && isAbsolute(path),
      "explicit absolute fixture/trust paths are required",
    );
  }
  assert.match(readString(input.kubernetesContext ?? ""), /^k3d-/);
  assert.match(readString(input.controllerNamespace ?? ""), /^[a-z0-9-]+$/);
  assert.ok(input.controllerSelector && !/[\r\n]/.test(String(input.controllerSelector)));
  assert.match(readString(input.openShellGatewayNamespace ?? ""), /^[a-z0-9-]+$/);
  assert.ok(
    input.openShellGatewaySelector && !/[\r\n]/.test(String(input.openShellGatewaySelector)),
  );
  for (const image of Object.values(images)) {
    assert.match(readString(image), /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual(
    Object.keys(images).sort(),
    ["agent", "controller", "gateway", "openShellGateway", "sandbox", "supervisor"].sort(),
  );
  // Explicit operator verification of the genuine intended executable in the
  // immutable workload image is required. Never discover authority by TOFU.
  if (wholeExecution) {
    assert.equal(input.authorityProfile, "fresh-whole-execution");
    assert.equal(
      input.credentialConnector,
      undefined,
      "a connector grant cannot authorize the entire execution",
    );
  } else {
    assert.equal(
      input.authorityProfile,
      undefined,
      "legacy connector inputs cannot claim whole-execution authority",
    );
    const pin = record(input.credentialConnector);
    assert.ok(pin && typeof pin.path === "string" && pin.path.startsWith("/") && pin.path !== "/");
    assert.equal(posix.normalize(pin.path), pin.path);
    assert.ok(
      !pin.path.endsWith("/") &&
        ![...pin.path].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127),
    );
    assert.match(readString(pin.sha256 ?? ""), /^[a-f0-9]{64}$/);
    assert.equal(pin.image, images.agent);
    assert.equal(pin.verification, "operator-verified-image-executable");
  }
  for (const head of [input.oceCommit, input.harnessCommit, input.supplierCommit]) {
    assert.match(readString(head ?? ""), /^[a-f0-9]{40}$/);
  }
  if (input.controllerUpgrade !== undefined) {
    assert.equal(allowControllerUpgrade, true, "this caller does not perform controller upgrades");
    const upgrade = record(input.controllerUpgrade);
    assert.equal(wholeExecution, true, "controller upgrades require the whole-execution lane");
    assert.deepEqual(Object.keys(upgrade).sort(), ["fromCommit", "fromImage", "timeoutMs"]);
    assert.match(readString(upgrade.fromCommit ?? ""), /^[a-f0-9]{40}$/);
    assert.notEqual(upgrade.fromCommit, input.oceCommit, "select different controller revisions");
    assert.match(readString(upgrade.fromImage ?? ""), /^[^\s@]+@sha256:[a-f0-9]{64}$/);
    assert.notEqual(
      readString(upgrade.fromImage).split("@sha256:")[1],
      readString(images.controller).split("@sha256:")[1],
      "select different controller image digests",
    );
    assert.ok(
      typeof upgrade.timeoutMs === "number" &&
        Number.isSafeInteger(upgrade.timeoutMs) &&
        upgrade.timeoutMs >= 60_000 &&
        upgrade.timeoutMs <= 15 * 60_000,
      "controller upgrade must allow between one and fifteen minutes",
    );
  }
  const gateway = new URL(readString(backend.endpoint));
  assert.equal(gateway.protocol, "https:");
  assert.equal(gateway.username + gateway.password + gateway.search + gateway.hash, "");
  const auth = record(backend.auth);
  assert.ok(auth && typeof auth === "object", "explicit Backend authentication is required");
  const authPaths =
    auth.mode === "bearerTokenFile" ? ["path"] : ["certificatePath", "privateKeyPath"];
  assert.ok(
    auth.mode === "bearerTokenFile" || auth.mode === "mtls",
    "Backend authentication must be bearerTokenFile or mtls",
  );
  assert.deepEqual(Object.keys(auth).sort(), ["mode", ...authPaths].sort());
  for (const key of authPaths) {
    const path = auth[key];
    assert.ok(
      typeof path === "string" && isAbsolute(path),
      "explicit absolute Backend authentication paths are required",
    );
  }
  assert.equal(backend.insecureTransport, undefined);
  const provider = new URL(readString(providerInput.origin));
  assert.equal(provider.protocol, "https:");
  assert.ok(
    provider.hostname.endsWith(".test") || provider.hostname === "host.openshell.internal",
    "use a fixture-only .test origin or the native host.openshell.internal fixture alias",
  );
  assert.equal(provider.pathname, "/v1");
  assert.equal(provider.username + provider.password + provider.search + provider.hash, "");
  assert.ok(isIP(readString(providerInput.bindHost)), "explicit provider listener IP is required");
  assert.ok(
    typeof providerInput.bindPort === "number" &&
      Number.isSafeInteger(providerInput.bindPort) &&
      providerInput.bindPort > 0 &&
      providerInput.bindPort < 65536,
  );
  if (wholeExecution) {
    // The supplier terminal exchange only supports inspected HTTPS on 443.
    assert.equal(providerInput.bindPort, 443, "execution authority requires HTTPS port 443");
  } else {
    assert.ok(providerInput.bindPort > 1024);
  }
  assert.equal(Number(provider.port || 443), providerInput.bindPort);
}
