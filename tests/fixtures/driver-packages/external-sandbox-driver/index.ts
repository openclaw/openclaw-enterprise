/**
 * A provider-free external Sandbox package for the external Sandbox conformance kit
 * (RFC-0040). It owns a dedicated Codex Harness through the existing optional Sandbox members
 * only. Installed only in a kit test's private controller package root.
 */
import type {
  ErrorDetail,
  SandboxHarnessContext,
  SandboxHarnessEndpoint,
  SandboxHarnessStatus,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";

export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["endpoint", "caBundle", "workspaceRoot", "generationSha256"],
  properties: {
    endpoint: { type: "string" },
    caBundle: { type: "string" },
    workspaceRoot: { type: "string" },
    generationSha256: { type: "string" },
    // Kit-only: replace one declared member with an invalid value to exercise the loader.
    malformed: { type: "object" },
  },
};

type Configuration = {
  readonly endpoint: string;
  readonly caBundle: string;
  readonly workspaceRoot: string;
  readonly generationSha256: string;
  readonly malformed?: Readonly<Record<string, unknown>>;
};

export function validateConfiguration(config: Readonly<Configuration>): readonly ErrorDetail[] {
  const strings = ["endpoint", "caBundle", "workspaceRoot", "generationSha256"] as const;
  return strings.every((key) => typeof config[key] === "string" && config[key].length > 0)
    ? []
    : [{ path: "", code: "INVALID_VALUE", message: "The fixture needs its four strings." }];
}

const SUPPORT = Object.freeze({
  openclaw: Object.freeze({
    embedded: Object.freeze({ supported: false }),
    dedicated: Object.freeze({ supported: true }),
  }),
});

export function createDriver(input: {
  readonly id: string;
  readonly implementation: string;
  readonly configuration: Readonly<Configuration>;
}) {
  const { configuration } = input;
  const provisions: SandboxHarnessContext[] = [];
  const driver = {
    id: input.id,
    capability: "sandbox" as const,
    implementation: input.implementation,
    facets: Object.freeze(["networking", "filesystem", "process"] as const),
    supportsHarnessExecutionMode: SUPPORT,
    provisions,
    async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
      provisions.push(context);
      return {
        namespaceName: context.namespace.name,
        resourceName: `external-${context.revision.id}`,
        agentId: context.revision.agentId,
        revisionId: context.revision.id,
      };
    },
    async harnessEndpoint(): Promise<SandboxHarnessEndpoint> {
      return {
        url: configuration.endpoint,
        tls: { caBundle: configuration.caBundle },
        workspaceRoot: configuration.workspaceRoot,
      };
    },
    async harnessStatus(): Promise<SandboxHarnessStatus> {
      return { state: "starting" };
    },
    async cleanup() {},
  };
  return Object.assign(driver, configuration.malformed ?? {});
}
