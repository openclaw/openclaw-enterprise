export const protectedSourceInputs = {
  "credential-free-repository-metadata": (agentId: string) => ({
    name: "credential-free",
    type: "credential-free-repository-metadata",
    config: {
      origin: "https://api.github.com",
      repository_id: "7311",
      repository: "fixture/credential-free",
      agent_id: agentId,
      authority: "execution",
    },
  }),
};
