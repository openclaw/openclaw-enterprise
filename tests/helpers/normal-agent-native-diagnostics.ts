// TODO: Remove refusal-only metadata after the managed native-profile blocker is resolved.
// Return only fixed diagnostic labels. Never retain text from a native error,
// HTTP body or process log, which can contain model data and credentials.
export function nativeTaskFailureSummary(value: unknown) {
  const text = typeof value === "string" ? value.slice(0, 65_536) : "";
  const patterns: [string, RegExp][] = [
    ["profile-grant-mismatch", /Codex did not grant the requested (?:named )?permission profile/i],
    [
      "profile-not-found",
      /(?:unknown|missing|unrecognized|not found).*permission.*profile|permission.*profile.*(?:not found|not configured|does not exist|unknown)/i,
    ],
    [
      "managed-profile-refusal",
      /allowed_permission_profiles|allowedPermissionProfiles|permission profile.*(?:not allowed|disallowed|requirements|managed)|requirements.*permission.*profile/i,
    ],
    [
      "native-policy-refusal",
      /sandbox policy.*(?:refused|denied|not allowed)|approval.*(?:required|denied)|permission.*(?:denied|not allowed)/i,
    ],
    ["thread-unavailable", /thread.*(?:not found|not loaded|unavailable|missing)/i],
    [
      "gateway-authentication",
      /gateway.*(?:unauthorized|authentication failed|password mismatch|auth failed)|missing gateway token|gateway token mismatch/i,
    ],
    [
      "device-identity-required",
      /device identity required|pairing required|device identity.*(?:missing|required)/i,
    ],
    [
      "model-authentication",
      /invalid api key|incorrect api key|authentication_error|invalid authentication|Codex.*(?:unauthorized|authentication failed)/i,
    ],
    ["model-rate-or-quota", /rate.limit|quota exceeded|insufficient_quota|too many requests/i],
    [
      "network-or-tls",
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connection refused|failed to connect|certificate.*(?:failed|invalid)|SSL_ERROR/i,
    ],
  ];
  const classes = patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const method = ["thread/start", "thread/resume", "thread/fork", "turn/start"].find((name) =>
    text.includes(name),
  );
  return {
    classes: classes.length ? classes : ["unclassified"],
    nativeMethod: method ?? "unknown",
  };
}

export function nativePolicyRequirementsSummary(response: unknown) {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(response) || !Object.hasOwn(response, "requirements")) {
    return { available: false };
  }
  const requirements = response.requirements;
  if (requirements === null) {
    return { available: true, requirementsPresent: false };
  }
  if (!record(requirements)) {
    return { available: false };
  }
  const allowlist = requirements.allowedPermissionProfiles;
  const present =
    record(allowlist) && Object.values(allowlist).every((value) => typeof value === "boolean");
  const allowlistKnown =
    Object.hasOwn(requirements, "allowedPermissionProfiles") && (allowlist === null || present);
  const keys = present ? Object.keys(allowlist) : [];
  const defaultId = requirements.defaultPermissions;
  const defaultKey = String(defaultId);
  const builtin: Readonly<Record<string, string>> = {
    ":workspace": "builtin-workspace",
    ":read-only": "builtin-read-only",
    ":danger-full-access": "builtin-danger-full-access",
  };
  return {
    available: true,
    requirementsPresent: true,
    profileAllowlistKnown: allowlistKnown,
    profileAllowlistPresent: allowlistKnown ? present : "unknown",
    profileAllowlistCount: present ? keys.length : "unknown",
    workspaceAllowed: present ? allowlist[":workspace"] === true : "unknown",
    readOnlyAllowed: present ? allowlist[":read-only"] === true : "unknown",
    generatedNetworkProfilesAllowed: present
      ? keys.filter((key) => /^openclaw-network-[a-f0-9]{16}$/.test(key) && allowlist[key] === true)
          .length
      : "unknown",
    defaultProfileKind: Object.hasOwn(builtin, defaultKey)
      ? builtin[defaultKey]
      : typeof defaultId === "string"
        ? "other-named"
        : "unknown",
  };
}
