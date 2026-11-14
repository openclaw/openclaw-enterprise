import assert from "node:assert/strict";
import test from "node:test";

import {
  presetTemplateDefaultsWithPlaceholders,
  renderPresetTemplate,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type PresetDraftTemplate,
  type PresetLaunchSettings,
} from "../../packages/contracts/src/index.ts";
import {
  ComputeGatewaySettingError,
  ConfigurationHarnessError,
} from "../../packages/occ/src/index.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

const setting = "gateway.auth.trustedProxy.requiredHeaders";
const requirement = "must be an array of valid HTTP field names when set";
const message = `Configuration setting ${setting} ${requirement}.`;
const malformed = [
  ["colon", "x:synthetic"],
  ["space", "x synthetic"],
  ["internal tab", "x\tsynthetic"],
  ["control", "x\u0000synthetic"],
  ["non-ASCII", "x-\u00e9"],
] as const;

function configuration(
  requiredHeaders?: OpenClawConfigurationValue,
): OpenClawConfigurationDocument {
  return {
    gateway: {
      auth: {
        trustedProxy: {
          allowUsers: ["occ-workspace-files"],
          ...(requiredHeaders === undefined ? {} : { requiredHeaders }),
        },
      },
    },
  };
}

function driver(routed = false) {
  const compute = createTestKubernetesComputeDriver("compute-required-headers", {
    gatewayRuntime: routed,
  });
  let clusterCalls = 0;
  // Admission must reject before the Driver obtains a Kubernetes client.
  Object.defineProperty(compute, "clients", {
    value: () => {
      clusterCalls += 1;
      throw new Error("Unexpected Kubernetes client access");
    },
  });
  return { compute, clusterCalls: () => clusterCalls };
}

function saveRefusal(error: unknown): boolean {
  return error instanceof ConfigurationHarnessError && error.message === message;
}

function gatewayRefusal(error: unknown): boolean {
  return (
    error instanceof ComputeGatewaySettingError &&
    error.setting === setting &&
    error.message === message
  );
}

for (const [label, header] of malformed) {
  test(`Kubernetes required headers reject ${label} through save and Gateway admission`, () => {
    const { compute, clusterCalls } = driver();
    const values = configuration([header]);
    assert.throws(() => compute.validateConfiguration(values), saveRefusal, "Configuration save");
    assert.throws(
      () =>
        compute.validateAgentProvisioning({ executionMode: "dedicated", configuration: values }),
      gatewayRefusal,
      "provisioning admission",
    );
    assert.throws(
      () => compute.validateGatewaySettings(values),
      gatewayRefusal,
      "deployment admission",
    );
    assert.throws(
      () => compute["kubernetesGatewayConfigurationDocument"](values),
      { message },
      "Gateway render",
    );
    assert.equal(clusterCalls(), 0);
  });
}

test("Kubernetes required headers preserve valid tokens and existing route restrictions", () => {
  const valid = ["X-Mixed-Case", "Az09!#$%&'*+-.^_\x60|~"];
  for (const routed of [false, true]) {
    const { compute, clusterCalls } = driver(routed);
    for (const headers of [undefined, [], valid, ["X-OpenClaw-Scopes", ...valid]]) {
      const values = configuration(headers);
      const before = structuredClone(values);
      compute.validateConfiguration(values);
      compute.validateAgentProvisioning({ executionMode: "dedicated", configuration: values });
      compute.validateGatewaySettings(values);
      const rendered = compute["kubernetesGatewayConfigurationDocument"](values);
      const expected = routed
        ? headers?.some((header) => header.toLowerCase() === "x-openclaw-scopes")
          ? headers
          : [...(headers ?? []), "x-openclaw-scopes"]
        : headers;
      assert.deepEqual(
        (rendered.gateway as { auth: { trustedProxy: { requiredHeaders?: string[] } } }).auth
          .trustedProxy.requiredHeaders,
        expected,
      );
      assert.deepEqual(values, before);
    }
    for (const header of ["authorization", "Cookie", "forwarded", "x-forwarded-for"]) {
      const values = configuration([header]);
      compute.validateConfiguration(values);
      if (routed) {
        assert.throws(
          () => compute.validateGatewaySettings(values),
          (error: unknown) =>
            error instanceof ComputeGatewaySettingError &&
            error.setting === setting &&
            error.message.includes("route removes"),
        );
      } else {
        compute.validateGatewaySettings(values);
      }
    }
    assert.equal(clusterCalls(), 0);
  }
});

test("Kubernetes required-header shape errors have one value-free refusal", () => {
  const { compute, clusterCalls } = driver();
  for (const headers of [null, {}, "x-synthetic", [""], [" x-synthetic"], ["x-synthetic "], [42]]) {
    const values = configuration(headers);
    assert.throws(() => compute.validateConfiguration(values), saveRefusal);
    assert.throws(() => compute.validateGatewaySettings(values), gatewayRefusal);
  }
  assert.equal(clusterCalls(), 0);
});

function presetValues(settings: PresetLaunchSettings): OpenClawConfigurationDocument {
  const values = settings.configuration?.values;
  assert.ok(values !== undefined);
  return values;
}

function template(headers: OpenClawConfigurationValue): PresetDraftTemplate {
  return {
    variables: { header: { type: "string" }, suffix: { type: "string" } },
    configuration: { values: configuration(headers) },
  };
}

test("Kubernetes required-header Preset values retain literal checks while pending", () => {
  const { compute, clusterCalls } = driver();
  for (const headers of [["{{ vars.header }}"], ["X-{{ vars.header }}-{{ vars.suffix }}"]]) {
    const draft = template(headers);
    const { settings, unresolved, unresolvedType } = presetTemplateDefaultsWithPlaceholders(draft);
    const values = presetValues(settings);
    assert.ok(unresolved(["gateway", "auth", "trustedProxy", "requiredHeaders", 0]));
    assert.equal(
      unresolved(["gateway", "auth", "trustedProxy", "requiredHeaders", 0], true),
      undefined,
    );
    compute.validateConfiguration(values, { unresolved, unresolvedType });
    assert.throws(
      () => compute.validateGatewaySettings(values),
      gatewayRefusal,
      "unresolved admission",
    );
    const valid = presetValues(renderPresetTemplate(draft, { header: "Mixed", suffix: "Name" }));
    compute.validateConfiguration(valid);
    compute.validateGatewaySettings(valid);
    const invalid = presetValues(
      renderPresetTemplate(draft, { header: malformed[0][1], suffix: "Name" }),
    );
    assert.throws(() => compute.validateConfiguration(invalid), saveRefusal, "resolved save");
    assert.throws(
      () => compute.validateGatewaySettings(invalid),
      gatewayRefusal,
      "resolved admission",
    );
  }
  for (const headers of [
    ["X:{{ vars.header }}"],
    ["{{ vars.header }} suffix"],
    ["{{ vars.header }}", malformed[1][1]],
    ["\\{{ vars.header }}", "{{ vars.header }}"],
  ]) {
    const { settings, unresolved, unresolvedType } = presetTemplateDefaultsWithPlaceholders(
      template(headers),
    );
    assert.throws(
      () => compute.validateConfiguration(presetValues(settings), { unresolved, unresolvedType }),
      saveRefusal,
      "invalid literal fragment",
    );
  }

  // A pending whole-token boolean still looks like a string until launch supplies its value.
  const { settings, unresolved, unresolvedType } = presetTemplateDefaultsWithPlaceholders({
    ...template(["{{ vars.header }}"]),
    variables: { header: { type: "boolean" } },
  });
  assert.throws(
    () => compute.validateConfiguration(presetValues(settings), { unresolved, unresolvedType }),
    saveRefusal,
    "pending whole-token boolean at Configuration save",
  );
  assert.equal(clusterCalls(), 0);
});
