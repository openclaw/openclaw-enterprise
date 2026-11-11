import type {
  InstallationSandboxNetworkPolicyCeiling,
  SandboxNetworkGrant,
} from "@openclaw-enterprise/contracts";
import { fixtureError, fixtureResponse } from "./preview-rules.mts";

export type CeilingScenario = { ceilingState?: "empty" | "startup" | "conflict" | "invalid" };

/** Simulated storage for the production Settings renderer; backend proof runs separately. */
export function createCeilingFixture(scenario: CeilingScenario, createdAt: string) {
  const rule: SandboxNetworkGrant = {
    id: "python-docs",
    binary: "/usr/bin/python3.11",
    host: "docs.example.org",
    ports: [{ from: 443, to: 443 }],
  };
  let ceiling: InstallationSandboxNetworkPolicyCeiling = {
    installationId: "ins_00000000-0000-4000-8000-000000000001",
    version: 1,
    rules: scenario.ceilingState === "empty" ? [] : [rule],
    managementMode: scenario.ceilingState === "startup" ? "startup" : "console",
    updatedAt: createdAt,
    updatedBy: "storybook-operator",
  };
  let conflicted = false;
  return (path: string, method: string, body: unknown): Response | undefined => {
    if (!path.startsWith("/installation/sandbox-network-policy-ceiling")) {
      return undefined;
    }
    if (method === "GET" && path === "/installation/sandbox-network-policy-ceiling") {
      return fixtureResponse(ceiling);
    }
    const input = body as { expectedVersion: number; rules: SandboxNetworkGrant[] };
    if (ceiling.managementMode === "startup" || input.expectedVersion !== ceiling.version) {
      return fixtureError(409, "RESOURCE_STATE_CONFLICT");
    }
    if (method === "POST" && path.endsWith("/validate")) {
      return fixtureResponse(
        scenario.ceilingState === "invalid"
          ? {
              success: false,
              error: {
                details: [
                  {
                    path: "/rules/0/host",
                    code: "INVALID_VALUE",
                    message: "Use a valid DNS host or single-label wildcard.",
                  },
                ],
              },
            }
          : { success: true, data: { rules: input.rules } },
      );
    }
    if (method === "PUT" && path === "/installation/sandbox-network-policy-ceiling") {
      if (scenario.ceilingState === "conflict" && !conflicted) {
        conflicted = true;
        ceiling = {
          ...ceiling,
          version: ceiling.version + 1,
          rules: [{ ...rule, host: "newer.example.org" }],
        };
        return fixtureError(409, "RESOURCE_STATE_CONFLICT");
      }
      ceiling = {
        ...ceiling,
        version: ceiling.version + 1,
        rules: structuredClone(input.rules),
        updatedBy: "storybook-operator",
      };
      return fixtureResponse(ceiling);
    }
    return undefined;
  };
}
