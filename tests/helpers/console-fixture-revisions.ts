import assert from "node:assert/strict";

import type { PlatformStateStore } from "../../packages/occ/src/state/platform-state.ts";
import { AgentRevisionResponse } from "../../packages/contracts/src/api/resources.ts";
import type { createFixtureResponse } from "./console-fixture-response.ts";

export function createConsoleFixtureRevisions(
  request: (method: "POST", path: string) => Promise<{ status: number; body: unknown }>,
  fixtureResponse: ReturnType<typeof createFixtureResponse>,
  activeStore: () => PlatformStateStore,
) {
  async function deployAgent(namespaceId: string, agentId: string) {
    const revision = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
    return fixtureResponse(revision, 202, AgentRevisionResponse, "deploy Agent").data;
  }

  async function activateRevision(
    namespaceId: string,
    agentId: string,
    revisionId: string,
    expectedRevisionId?: string,
  ) {
    // This renders a valid admitted active revision for console tests; runtime dispatch,
    // worker lease handling, and Compute Driver effects are proved by worker tests.
    const active = await activeStore().transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespaceId, agentId, expectedRevisionId, revisionId),
    );
    assert.ok(active, "the admitted Agent revision must activate from the expected state");
    return active;
  }

  async function seedActiveAgentRevision(
    namespaceId: string,
    agentId: string,
    expectedRevisionId?: string,
  ) {
    const revision = await deployAgent(namespaceId, agentId);
    const agent = await activateRevision(namespaceId, agentId, revision.id, expectedRevisionId);
    return { agent, revision };
  }

  return { deployAgent, activateRevision, seedActiveAgentRevision };
}
