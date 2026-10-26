import type { Agent } from "@openclaw-enterprise/contracts";

export declare function deriveNativeAdminHost(
  installationId: string,
  agent: Pick<Agent, "namespaceId" | "id">,
  domain: string,
): string;
