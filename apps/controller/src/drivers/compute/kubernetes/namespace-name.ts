import { sha256Hex } from "@openclaw-enterprise/utils";

export function managedNamespaceName(namespaceId: string): string {
  return `oce-${sha256Hex(namespaceId, 15)}`;
}
