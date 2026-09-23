const SUPPORTED_NATIVE_GATEWAY_AUTH_FIELDS = new Set([
  "mode",
  "password",
  "allowTailscale",
  "identityScopes",
  "rateLimit",
  "trustedProxy",
]);

export function unsupportedNativeGatewayAuthFields(
  auth: Readonly<Record<string, unknown>>,
): readonly string[] {
  return Object.keys(auth).filter((key) => !SUPPORTED_NATIVE_GATEWAY_AUTH_FIELDS.has(key));
}
