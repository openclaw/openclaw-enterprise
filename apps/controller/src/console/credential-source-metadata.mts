import type { CredentialSourceReference } from "@openclaw-enterprise/contracts";
import { responseFields } from "./api-client.mjs";

export type CredentialSourceSummary = {
  id: string;
  namespaceId: string;
  name: string;
  type: "static" | "oauth2-refresh-token" | "github-app-installation";
  state: "ready" | "deleting";
  createdAt: string;
  ref: CredentialSourceReference;
  connectionTemplateId?: string;
  modelPreset?: "openai" | "codex-pat";
};

/** Keep only the public fields the Console needs, and require the exact Namespace identity. */
export function readCredentialSourceMetadata(
  value: unknown,
  namespaceId: string,
): CredentialSourceSummary | null {
  const data = responseFields(value);
  const ref = responseFields(data.ref);
  if (
    typeof data.id !== "string" ||
    !data.id ||
    data.namespaceId !== namespaceId ||
    typeof data.name !== "string" ||
    !data.name ||
    (data.type !== "static" &&
      data.type !== "oauth2-refresh-token" &&
      data.type !== "github-app-installation") ||
    Object.hasOwn(data, "ownerCapability") ||
    (data.state !== "ready" && data.state !== "deleting") ||
    typeof data.createdAt !== "string" ||
    !data.createdAt ||
    ref.kind !== "credential_source" ||
    ref.id !== data.id ||
    ref.namespaceId !== namespaceId ||
    Object.keys(ref).length !== 3 ||
    (data.connectionTemplateId !== undefined &&
      (typeof data.connectionTemplateId !== "string" || !data.connectionTemplateId))
  ) {
    return null;
  }
  const preset = data.type === "static" ? responseFields(data.config).provider_preset : undefined;
  return {
    id: data.id,
    namespaceId,
    name: data.name,
    type: data.type,
    state: data.state,
    createdAt: data.createdAt,
    ref: { kind: "credential_source", namespaceId, id: data.id },
    ...(typeof data.connectionTemplateId === "string"
      ? { connectionTemplateId: data.connectionTemplateId }
      : {}),
    ...(preset === "openai" || preset === "codex-pat" ? { modelPreset: preset } : {}),
  };
}
