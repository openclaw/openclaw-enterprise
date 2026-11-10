export const SHARING_RECIPIENT_SEARCH_MIN_LENGTH = 2;
export const SHARING_RECIPIENT_SEARCH_MAX_LENGTH = 120;
export const SHARING_RECIPIENT_SEARCH_LIMIT = 10;

export interface SharingRecipient {
  readonly principalId: string;
  readonly name: string;
  readonly email?: string;
}
