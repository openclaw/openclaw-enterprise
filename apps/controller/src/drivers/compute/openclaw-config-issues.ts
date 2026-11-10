// Shared by the Kubernetes and Docker runtime wrappers, which embed this script.
// The invalid settings an OpenClaw config validation report names, for one bounded log
// line: up to five distinct setting paths (names, never values). A message prefixed
// "invalid config: " comes from a plugin's or channel's JSON Schema at the pinned
// OpenClaw (validation-plugin-config.ts, validation-channel-rules.ts) and names only
// schema terms and setting keys, so it is kept beside its path. Other messages can quote
// a setting's value, which the configuration may hold as a secret, so they are dropped.
// invalidOpenClawConfigurationLine is the log line of a Gateway held as check gateway-config
// (findings 3043, 3045): what happened, the settings, and the remedy.
export const OPENCLAW_CONFIG_ISSUE_HELPER = String.raw`
function openClawConfigIssues(issues) {
  const kept = new Map();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const path = issue?.path;
    if (
      typeof path !== "string" || path.length > 64 || kept.has(path) ||
      !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)
    ) {
      continue;
    }
    const schemaMessage = typeof issue.message === "string" && issue.message.startsWith("invalid config: ")
      ? issue.message.slice(16).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 160)
      : "";
    kept.set(path, schemaMessage);
    if (kept.size === 5) break;
  }
  return [...kept].map(([path, message]) => (message === "" ? { path } : { path, message }));
}
function invalidOpenClawConfigurationLine(event, issues) {
  const settings = openClawConfigIssues(issues)
    .map((issue) => issue.path + (issue.message === undefined ? "" : ": " + issue.message));
  return event + ", and OpenClaw reports its configuration invalid" +
    (settings.length > 0 ? " (" + settings.join("; ") + ")" : "") +
    ". It is held, not restarted: fix or remove the invalid settings in the Agent's Configuration, " +
    "then deploy a new version.";
}
`;
