// The harness authentication caller's contract, until secret-picker.mjs moves to TypeScript.
import type { SecretMetadata, SecretReference } from "@openclaw-enterprise/contracts";
import type { AgentAccessContext } from "./credential-access.mjs";

export function renderSecretReference(
  context: AgentAccessContext,
  source: SecretReference,
): HTMLSpanElement;

export function createSecretReferenceField(options: {
  context: AgentAccessContext;
  id: string;
  label: string;
  getCurrentSource(): SecretReference | null;
  onSecretSelected(secret: SecretMetadata): void;
  createSecretName(): string;
  createDialogTitle: string;
  metadataLabel: string;
  required: boolean;
}): {
  field: HTMLElement;
  refresh(): void;
  setRequired(required: boolean): void;
  setDisabled(disabled: boolean): void;
};
