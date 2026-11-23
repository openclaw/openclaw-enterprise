import type { TestContext } from "node:test";
import { inspectedWorkspaceBuild } from "../../apps/controller/src/drivers/sandbox/inspected-workspace-release.ts";

export const fixtureRelease = {
  gateway: "registry.example.test/runtime/gateway@sha256:" + "a".repeat(64),
  agent: "registry.example.test/runtime/agent@sha256:" + "b".repeat(64),
};

export function selectFixtureRelease(t: TestContext, agentDigest = "sha256:" + "b".repeat(64)) {
  return t.mock.getter(inspectedWorkspaceBuild, "release", () => ({
    gatewayDigest: "sha256:" + "a".repeat(64),
    agentDigest,
  }));
}
