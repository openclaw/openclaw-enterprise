/** Native workspace authentication uses the same fixed client profile at startup and in the app server. */
export const PROTECTED_EGRESS_MARKER = "oce-protected-egress";
const providerId = "oce-codex-workspace";
const settings = {
  name: "OpenAI",
  base_url: "https://chatgpt.com/backend-api/codex",
  wire_api: "responses",
  requires_openai_auth: true,
  supports_websockets: false,
  request_max_retries: 0,
  stream_max_retries: 0,
} as const;

export function codexWorkspaceProviderToml(configuration: string): string {
  const lines = Object.entries(settings).map(
    ([name, value]) => `${name} = ${JSON.stringify(value)}`,
  );
  return `model_provider = "${providerId}"\n\n${configuration}\n[model_providers.${providerId}]\n${lines.join("\n")}\n`;
}

export function codexWorkspaceProviderArguments(): readonly string[] {
  return [
    `model_provider="${providerId}"`,
    ...Object.entries(settings).map(
      ([name, value]) => `model_providers.${providerId}.${name}=${JSON.stringify(value)}`,
    ),
  ].flatMap((setting) => ["-c", setting]);
}
