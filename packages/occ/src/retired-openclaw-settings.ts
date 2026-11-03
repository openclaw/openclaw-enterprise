// Settings the pinned OpenClaw retired. Configuration save, Agent save and deploy admission
// refuse them (configuration-settings.ts); the Console also serves this module
// (`console-assets.ts`) so a version draft that keeps one shows the same refusal before Deploy
// (finding 2810). Keep it free of imports and of TypeScript syntax that type stripping cannot
// erase.

/**
 * Settings the pinned OpenClaw (the commit in `deploy/runtime/openclaw-source.json`) retired,
 * with what replaces each. Its config validation refuses them and the Gateway does not start;
 * its `doctor --fix` would remove them, but it cannot rewrite the read-only Configuration OCE
 * mounts. The runtime image test checks the core settings against the pinned schema.
 */
export const RETIRED_OPENCLAW_SETTINGS: readonly (readonly [string, string])[] = [
  ["security.preset", "configure the individual security controls explicitly"],
  [
    "agents.defaults.compaction.memoryFlush.model",
    "memory flushes use the session model and its fallbacks",
  ],
  [
    "agents.defaults.embeddedAgent.cyberFailover.model",
    "cyber-policy retries use the active model",
  ],
  [
    "plugins.entries.codex.config.appServer.cyberFailover.model",
    "cyber-policy retries use the active model",
  ],
];

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * OCC's refusal of the first retired setting the Configuration values set, whatever its value,
 * or null when they set none.
 */
export function retiredOpenClawSettingMessage(values: unknown): string | null {
  for (const [setting, replacement] of RETIRED_OPENCLAW_SETTINGS) {
    const path = setting.split(".");
    let parent = asObject(values);
    for (const key of path.slice(0, -1)) {
      parent = asObject(parent?.[key]);
    }
    if (parent !== undefined && Object.hasOwn(parent, path.at(-1)!)) {
      return `Configuration setting ${setting} must be removed: the OpenClaw runtime retired it (${replacement}).`;
    }
  }
  return null;
}
