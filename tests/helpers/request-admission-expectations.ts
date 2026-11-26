// Only requests that send an Authorization header receive the header remedy.
export const CREDENTIAL_REQUIRED =
  "A valid session cookie or service API key is required: the credential sent is missing, invalid, expired, or revoked. Sign in again, or use a current service API key.";
export const AUTHORIZATION_HEADER_REFUSED =
  "The API does not accept an Authorization header. Send a service API key in the x-api-key header, or sign in for a session cookie.";
// A Namespace-scoped service key outside its Namespace: the text names only the key's own
// Namespace, never the requested one.
export function serviceKeyOutsideNamespace(namespaceId: string): string {
  return `This service key works only in Namespace ${namespaceId}; this request is outside it. Ask an Installation administrator to run it.`;
}
