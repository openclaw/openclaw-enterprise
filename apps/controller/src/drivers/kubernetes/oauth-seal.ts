/**
 * Annotations the Kubernetes Compute Driver writes on a Codex OAuth source Secret while it
 * hands the credential to the Agent volume. The Kubernetes Secret Driver refuses ordinary
 * updates and compare-and-swap once the phase is set, so both drivers share these names.
 */
export const OAUTH_AGENT_ANNOTATION = "openclaw.dev/oauth-agent-id";
export const OAUTH_VOLUME_ANNOTATION = "openclaw.dev/oauth-volume-uid";
export const OAUTH_PHASE_ANNOTATION = "openclaw.dev/oauth-phase";
