import type { SandboxDriver } from "@openclaw-enterprise/contracts";

export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  properties: { malformed: { type: "object" } },
};

export function validateConfiguration() {
  return [];
}

export function createDriver(input: {
  readonly id: string;
  readonly implementation: string;
  readonly configuration: { readonly malformed?: Readonly<Record<string, unknown>> };
}) {
  const driver = {
    id: input.id,
    implementation: input.implementation,
    capability: "sandbox",
    facets: ["networking", "filesystem", "process"],
    supportsHarnessExecutionMode: Object.freeze({
      openclaw: Object.freeze({
        embedded: Object.freeze({ supported: false }),
        dedicated: Object.freeze({ supported: true }),
      }),
    }),
    async provisionHarness(): Promise<never> {
      throw new Error("The registration fixture does not provision a Harness.");
    },
    async cleanup() {},
  } satisfies SandboxDriver;

  // Replace declarations after building a valid baseline so the real loader checks them.
  return Object.assign(driver, input.configuration.malformed);
}
