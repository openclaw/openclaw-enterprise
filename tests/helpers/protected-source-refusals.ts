import { metadataSourceFields } from "./static-egress-metadata.ts";

export const protectedSourceInputs = {
  "credential-free-repository-metadata": (agentId: string) => ({
    name: "credential-free",
    ...metadataSourceFields({ origin: "https://api.github.com", agentId }),
  }),
};
