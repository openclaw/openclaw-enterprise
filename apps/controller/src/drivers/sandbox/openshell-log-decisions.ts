import type {
  SandboxLogLine,
  RuntimeLogLevel,
  SandboxPolicyDecision,
} from "@openclaw-enterprise/contracts";

const OCSF_SEVERITIES: Readonly<Record<string, RuntimeLogLevel>> = Object.freeze({
  INFO: "info",
  LOW: "info",
  MED: "warn",
  HIGH: "error",
  CRIT: "error",
  FATAL: "error",
});

/**
 * Fields recovered from one OpenShell OCSF shorthand line, for example
 * `HTTP:GET [INFO] ALLOWED curl(42) -> GET https://host/p?q=1 [policy:web engine:opa]` or
 * `PROC:LAUNCH [INFO] git(7) [cmd:git clone https://...]`. OpenShell pushes OCSF events
 * with an empty field map, so the shorthand is the only structure. Every pattern is
 * anchored on a fixed keyword and scans bounded tokens.
 */
function ocsfFields(message: string): {
  readonly fields: Record<string, string>;
  readonly message: string;
  readonly level: RuntimeLogLevel;
} {
  const fields: Record<string, string> = {};
  let rest = message;
  // The command line closes the PROC shorthand and may itself contain brackets. A string
  // search, not a regex, keeps hostile lines full of ` [cmd:` linear.
  const command = rest.startsWith("PROC:") && rest.endsWith("]") ? rest.indexOf(" [cmd:") : -1;
  if (command !== -1) {
    fields.cmd_line = rest.slice(command + " [cmd:".length, -1);
    rest = rest.slice(0, command);
  }
  const head = /^([A-Z]{2,16}:[A-Z_]{1,32}) \[([A-Z]{3,5})\]/.exec(rest);
  if (head !== null) {
    fields.activity = head[1]!;
  }
  const action = /^[A-Z]{2,16}:[A-Z_]{1,32} \[[A-Z]{3,5}\] ([A-Z]{3,16})\b/.exec(rest);
  if (action !== null && action[1] !== "UNKNOWN") {
    fields.action = action[1]!;
  }
  const actor = /(?:^|\s)([^\s()[\]]{1,256})\((\d{1,10})\)/.exec(rest);
  if (actor !== null) {
    fields.binary = actor[1]!;
    fields.pid = actor[2]!;
  }
  if (rest.startsWith("HTTP:")) {
    // `... curl(42) -> GET <url>`, or `... ALLOWED GET <url>` when no process is known.
    const request =
      /-> ([A-Z]{3,10}) (\S{1,32768})/.exec(rest) ??
      /^HTTP:[A-Z_]{1,32} \[[A-Z]{3,5}\] (?:[A-Z]{3,16} )?([A-Z]{3,10}) (\S{1,32768})/.exec(rest);
    if (request !== null) {
      fields.method = request[1]!;
      fields.url = request[2]!;
    }
  } else if (rest.startsWith("NET:")) {
    const target = /-> ([^\s:/]{1,253})(?::(\d{1,5}))?/.exec(rest);
    if (target !== null) {
      fields.dst_host = target[1]!;
      if (target[2] !== undefined) {
        fields.dst_port = target[2];
      }
    }
  }
  const policy = /\[policy:([^\s\]]{1,256}) engine:([^\s\]]{1,64})\]/.exec(rest);
  if (policy !== null) {
    fields.rule_name = policy[1]!;
    fields.rule_type = policy[2]!;
  }
  const reason = /[[ ]reason:([^\]]{1,512})\]/.exec(rest);
  if (reason !== null) {
    fields.reason = reason[1]!;
  }
  let severity: RuntimeLogLevel =
    head === null ? "unknown" : (OCSF_SEVERITIES[head[2]!] ?? "unknown");
  if (fields.action === "DENIED" && (severity === "info" || severity === "unknown")) {
    severity = "warn";
  }
  return { fields, message: rest, level: severity };
}

export function openShellLogDecision(line: Readonly<SandboxLogLine>): SandboxLogLine {
  if (line.level.toUpperCase() !== "OCSF" || Buffer.byteLength(line.message, "utf8") > 32 * 1024) {
    return line;
  }
  const parsed = ocsfFields(line.message);
  const fields = { ...line.fields, ...parsed.fields };
  const decision =
    fields.action === "DENIED" ? "denied" : fields.action === "ALLOWED" ? "allowed" : undefined;
  const port = Number(fields.dst_port);
  const metadata: SandboxPolicyDecision | undefined =
    decision === undefined
      ? undefined
      : {
          decision,
          // The pinned OCSF producer emits L7 audit outcomes as ALLOWED; DENIED is blocked.
          enforcement:
            decision === "denied" && /^(?:NET:OPEN|NET:REFUSE|HTTP:)/.test(line.message)
              ? "blocked"
              : "reported",
          ...(fields.binary === undefined ? {} : { binary: fields.binary }),
          ...(fields.dst_host === undefined ? {} : { host: fields.dst_host }),
          ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
          ...(fields.reason === undefined ? {} : { reason: fields.reason }),
          ...(fields.rule_name === undefined ? {} : { rule: fields.rule_name }),
          ...(fields.rule_type === undefined ? {} : { engine: fields.rule_type }),
          ...(fields.policy_generation === undefined
            ? {}
            : { policyGeneration: fields.policy_generation }),
        };
  return {
    ...line,
    message: parsed.message,
    level: parsed.level,
    fields,
    ...(metadata === undefined ? {} : { decision: metadata }),
  };
}
