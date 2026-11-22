import assert from "node:assert/strict";

const modules = {
  delegation: "./automation-model-only-delegation-scenario.mjs",
  messaging: "./automation-model-only-messaging-scenario.mjs",
};

// These modules plan synthetic model requests and observe real runtime effects.
// They cannot provide a tool result to the native Harness.
export async function loadDispatchScenario(scenario, context) {
  if (scenario === undefined) {
    return undefined;
  }
  if (!Object.hasOwn(modules, scenario)) {
    throw new Error("Unknown supplemental dispatch scenario");
  }
  const module = await import(modules[scenario]);
  return { module, strategy: module.createProviderStrategy(context) };
}

export function nativeToolText(output) {
  const value = output.output;
  if (typeof value === "string") {
    return value;
  }
  assert.ok(Array.isArray(value), "native output must contain text");
  return value
    .map((part) => {
      assert.ok(["text", "input_text"].includes(part.type));
      assert.equal(typeof part.text, "string");
      return part.text;
    })
    .join("\n");
}

export function nativeToolValue(output) {
  const parsed = JSON.parse(nativeToolText(output));
  return parsed && Object.hasOwn(parsed, "value") ? parsed.value : parsed;
}

export function declaredFunction(tools, name, fields) {
  const matches = tools.filter((tool) => tool.type === "function" && tool.name === name);
  assert.equal(matches.length, 1, `positive control requires advertised ${name}`);
  const tool = matches[0];
  assert.equal(tool.namespace, undefined, "this scenario requires the declared direct callable");
  for (const field of fields) {
    assert.ok(tool.parameters?.properties?.[field], `${name} must declare ${field}`);
  }
  return tool;
}
