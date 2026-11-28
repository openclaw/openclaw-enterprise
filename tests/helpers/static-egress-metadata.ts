export function metadataSourceFields(input: { origin: string; agentId: string }) {
  return {
    type: "credential-free-repository-metadata" as const,
    config: {
      origin: input.origin,
      repository_id: "7311",
      repository: "fixture/credential-free",
      agent_id: input.agentId,
      authority: "execution",
    },
  };
}
