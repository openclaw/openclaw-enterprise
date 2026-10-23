import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigurationValidationError,
  requireConfiguration,
  type DriverCapability,
  type DriverImplementation,
} from "../../packages/contracts/src/index.ts";
import { DriverConfigurationRegistry } from "../../packages/occ/src/index.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import {
  OpenShellCredentialProxyDriver,
  openShellEgressConfiguration,
} from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import * as releaseFixture from "../fixtures/driver-packages/protected-execution-driver/index.ts";
import * as repositoryFixture from "../fixtures/driver-packages/protected-execution-driver/repository-git.ts";

const sensitive = "SECRET-DO-NOT-LEAK";
const releaseConfiguration = {
  endpoint: "https://127.0.0.1:41001/supervisor/status",
  ca: "validation-only",
};
const invalidReleaseConfigurations = [
  sensitive,
  "http://127.0.0.1:41001/supervisor",
  "https://outside-review.invalid:8443/supervisor",
  "https://localhost:41001/supervisor",
  "https://[::1]:41001/supervisor",
  "https://127.0.0.2:41001/supervisor",
  "https://127.1:41001/supervisor",
  "https://2130706433:41001/supervisor",
  "https://0x7f000001:41001/supervisor",
  "https://127.0.0.1.outside-review.invalid:41001/supervisor",
  `https://${sensitive}@127.0.0.1:41001/supervisor`,
  `https://user:${sensitive}@127.0.0.1:41001/supervisor`,
  `https://:${sensitive}@127.0.0.1:41001/supervisor`,
  "https://@127.0.0.1:41001/supervisor",
  `https://127.0.0.1:${sensitive}@outside-review.invalid:8443/supervisor`,
].map((endpoint) => ({ ...releaseConfiguration, endpoint }));
const repositoryConfiguration = {
  origin: "https://127.0.0.1:41001",
  peerOrigin: "https://127.0.0.1:41002",
  capabilityOrigin: "https://127.0.0.1:41003",
  installationApiOrigin: "https://127.0.0.1:41004",
  certFile: "not-read-during-validation",
  releaseKey: "not-used-during-validation",
};
const invalidRepositoryConfigurations = [
  ...(["origin", "peerOrigin", "capabilityOrigin", "installationApiOrigin"] as const).flatMap(
    (field) =>
      [
        sensitive,
        "",
        "http://127.0.0.1:41005",
        "https://example.invalid",
        "https://localhost:41005",
        "https://127.0.0.1:41005/path",
        "https://127.0.0.1:41005?query",
        "https://127.0.0.1:41005#fragment",
        `https://${sensitive}@127.0.0.1:41005`,
      ].map((origin) => ({ ...repositoryConfiguration, [field]: origin })),
  ),
  { ...repositoryConfiguration, capabilityOrigin: repositoryConfiguration.peerOrigin },
];
const owners: readonly {
  capability: DriverCapability;
  implementation: string;
  definition: DriverImplementation;
  valid: Readonly<Record<string, unknown>>;
  invalid: readonly unknown[];
}[] = [
  {
    capability: "sandbox",
    implementation: "external-release-fixture",
    definition: releaseFixture,
    valid: releaseConfiguration,
    invalid: [null, {}, ...invalidReleaseConfigurations],
  },
  {
    capability: "sandbox",
    implementation: "external-repository-fixture",
    definition: repositoryFixture,
    valid: repositoryConfiguration,
    invalid: [null, {}, ...invalidRepositoryConfigurations],
  },
  {
    capability: "repo",
    implementation: "github",
    definition: GitHubRepositoryPolicy,
    valid: { sessionDurationSeconds: 60 },
    invalid: [
      null,
      {},
      { sessionDurationSeconds: 0 },
      { sessionDurationSeconds: 1.5 },
      { sessionDurationSeconds: Number.MAX_SAFE_INTEGER },
      { sessionDurationSeconds: sensitive },
      { sessionDurationSeconds: 60, [sensitive]: sensitive },
    ],
  },
  {
    capability: "credential_proxy",
    implementation: "openshell",
    definition: OpenShellCredentialProxyDriver,
    valid: {
      middlewareName: "credential-proxy",
      authorityScope: "execution",
      repositoryMiddlewareName: "repository-proxy",
      observedHookPreviewWorkspace: "preview-1",
    },
    invalid: [
      null,
      {},
      { middlewareName: " ", authorityScope: "execution" },
      { middlewareName: "proxy", authorityScope: sensitive },
      { middlewareName: { token: sensitive }, authorityScope: "execution" },
      { middlewareName: "proxy", authorityScope: "execution", repositoryMiddlewareName: 42 },
      {
        middlewareName: "proxy",
        authorityScope: "execution",
        observedHookPreviewWorkspace: "-invalid",
      },
      {
        middlewareName: "proxy",
        authorityScope: "execution",
        observedHookPreviewWorkspace: sensitive,
      },
      { middlewareName: "proxy", authorityScope: "execution", [sensitive]: sensitive },
    ],
  },
];

test("external fixture factories enforce structured validation before any peer or file access", () => {
  for (const configuration of invalidRepositoryConfigurations) {
    assert.throws(
      () =>
        repositoryFixture.createDriver({ id: "fixture", implementation: "fixture", configuration }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Protected Git fixture requires distinct, exact loopback TLS origins and valid configuration.",
        );
        return true;
      },
    );
  }
  for (const configuration of invalidReleaseConfigurations) {
    const before = { ...releaseFixture.calls };
    const diagnostics = releaseFixture.validateConfiguration(configuration);
    assert.deepEqual(diagnostics, [
      {
        path: "",
        code: "INVALID_VALUE",
        message: "Fixture peer requires a valid TLS configuration.",
      },
    ]);
    assert.ok(!JSON.stringify(diagnostics).includes(sensitive));
    assert.throws(
      () =>
        releaseFixture.createDriver({ id: "fixture", implementation: "fixture", configuration }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Fixture peer requires a valid TLS configuration.");
        assert.ok(!String(error).includes(sensitive));
        return true;
      },
    );
    assert.deepEqual(
      releaseFixture.calls,
      { ...before, validate: before.validate + 1 },
      "refusal must precede construction, lifecycle and close effects",
    );
  }
  assert.deepEqual(releaseFixture.validateConfiguration(releaseConfiguration), []);
  const beforeCreate = releaseFixture.calls.create;
  const registration = releaseFixture.createDriver({
    id: "fixture",
    implementation: "fixture",
    configuration: releaseConfiguration,
  });
  assert.equal(releaseFixture.calls.create, beforeCreate + 1);
  assert.ok(registration.capabilities.sandbox);
  registration.close?.();
});

function redactedConfigurationError(error: unknown): boolean {
  assert.ok(error instanceof ConfigurationValidationError);
  assert.ok(error.error.details.length > 0);
  assert.ok(error.error.details.every((detail) => detail.code && detail.message));
  assert.ok(!JSON.stringify(error.error).includes(sensitive));
  assert.ok(!String(error).includes(sensitive));
  return true;
}

for (const owner of owners) {
  test(`${owner.implementation} registers its real structured validator and rejects malformed input safely`, () => {
    const registry = new DriverConfigurationRegistry();
    registry.register({
      capability: owner.capability,
      driverId: "configured-owner",
      implementation: owner.implementation,
      definition: owner.definition,
    });
    const entry = registry.resolve(owner.capability, "configured-owner", "installation", "startup");
    assert.equal(entry.definition, owner.definition);
    assert.deepEqual(owner.definition.validateConfiguration(owner.valid), []);
    assert.deepEqual(entry.contribution.validateConfiguration(owner.valid), []);
    assert.equal(requireConfiguration(entry.contribution, owner.valid), owner.valid);
    for (const input of owner.invalid) {
      assert.throws(
        () => requireConfiguration(entry.contribution, input),
        redactedConfigurationError,
      );
    }
  });
}

test("OpenShell direct construction and policy rendering still enforce configuration validation", () => {
  for (const options of [
    { middlewareName: " ", authorityScope: "execution" },
    { middlewareName: "proxy", authorityScope: sensitive },
    { middlewareName: "proxy", authorityScope: "execution", repositoryMiddlewareName: 42 },
  ]) {
    // Malformed runtime input must fail before selection or route rendering.
    assert.throws(
      () => Reflect.construct(OpenShellCredentialProxyDriver, [options, undefined]),
      redactedConfigurationError,
    );
    assert.throws(
      () => Reflect.apply(openShellEgressConfiguration, undefined, [{ routes: [] }, options]),
      redactedConfigurationError,
    );
  }
});
