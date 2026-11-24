import type { SecretReference } from "../../packages/contracts/src/index.ts";

/** Registration bodies for the two protected metadata Source types. */
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
  "github-app-metadata": (agentId: string, issuer: SecretReference) => ({
    name: "prepared-metadata",
    type: "github-app-metadata",
    config: {
      app_id: "11",
      installation_id: "22",
      repository_id: "7311",
      repository: "fixture/prepared",
      agent_id: agentId,
      authority: "execution",
    },
    secrets: { private_key: issuer },
  }),
};
