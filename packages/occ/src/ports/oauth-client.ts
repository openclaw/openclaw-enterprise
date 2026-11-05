import type { OAuthClient } from "@openclaw-enterprise/contracts";

/** Private registration ownership. Only the selected Secret Driver can resolve the material. */
export interface StoredOAuthClient extends OAuthClient {
  readonly secretDriverId?: string;
}
