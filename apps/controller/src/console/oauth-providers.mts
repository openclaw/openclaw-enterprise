// Google's published OAuth metadata: https://accounts.google.com/.well-known/openid-configuration
export const googleOAuthProvider = {
  displayName: "Google OAuth",
  authorizationParameters: { access_type: "offline", prompt: "consent" },
  issuer: "https://accounts.google.com",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revocationUrl: "https://oauth2.googleapis.com/revoke",
} as const;
