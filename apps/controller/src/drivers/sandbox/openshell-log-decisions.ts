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
 * OpenShell's policy DNS answers a lookup with a placeholder address from 198.18.0.0/15 or
 * fd23:6f70:656e::/48 (openshell-supervisor-network `policy_dns/runtime.rs` at the pinned rev)
 * and dials the real host itself. A denial that its mapping could not resolve names only the
 * placeholder, which is no destination a rule can name.
 */
function openShellPlaceholderAddress(host: string): boolean {
  return /^198\.1[89]\.\d{1,3}\.\d{1,3}$/.test(host) || /^fd23:6f70:656e:/i.test(host);
}

// `CONFIG:PUBLISHED [INFO] Policy DNS mapped <host> resolved=<ips> synthetic=<ip> ports=...` and
// `CONFIG:OBSERVATION [INFO] Policy DNS staged unapproved name <host> synthetic=<ip> for TCP
// policy review`: the only records that tie a placeholder address to its host.
const PLACEHOLDER_MAPPING =
  /^CONFIG:[A-Z_]{1,32} \[[A-Z]{3,5}\] Policy DNS (?:mapped|staged unapproved name) ([^\s]{1,253}) (?:resolved=\S{0,4096} )?synthetic=([0-9a-f.:]{3,45})(?:\s|$)/i;

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
    // `... curl(42) -> host:443`, or `NET:REFUSE [MED] DENIED host` when no process is known
    // (a DNS refusal names the query only, D772). An IPv6 literal is written bare, so its port
    // is the last `:<digits>`.
    const target =
      /-> ((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}):(\d{1,5})(?=[\s/]|$)/i.exec(rest) ??
      /-> ([^\s:/]{1,253})(?::(\d{1,5}))?/.exec(rest) ??
      (actor === null && fields.action !== undefined
        ? /^NET:[A-Z_]{1,32} \[[A-Z]{3,5}\] [A-Z]{3,16} ([^\s:/()[\]]{1,253})(?::(\d{1,5}))?(?:\s|$)/.exec(
            rest,
          )
        : null);
    if (target !== null) {
      // OpenShell's policy DNS answers with a placeholder address and logs the host it stands
      // for separately (D771); the address alone names no destination.
      if (openShellPlaceholderAddress(target[1]!)) {
        fields.dst_placeholder_ip = target[1]!;
      } else {
        fields.dst_host = target[1]!;
      }
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

/**
 * Decorates a read in log order. A denial that names a placeholder address takes its host
 * from the latest policy DNS record for that address earlier in the same read (D771): the
 * mapping is logged when the lookup is answered, just before the connection it serves, and
 * moves to a new address when the policy changes. Without such a record the decision names
 * no host, so nothing proposes a rule for the placeholder. Only `decision` depends on the
 * other lines; `fields` stay a function of the line alone, which keeps the line hashes that
 * de-duplicate overlapping reads stable.
 */
export function openShellLogDecisions(
  lines: readonly Readonly<SandboxLogLine>[],
): SandboxLogLine[] {
  const hosts = new Map<string, string>();
  return lines.map((line) => {
    const decorated = openShellLogDecision(line);
    if (decorated === line) {
      return decorated;
    }
    const mapping = PLACEHOLDER_MAPPING.exec(decorated.message);
    // Only a placeholder address is ever looked up below (`dst_placeholder_ip`), so a record
    // whose `synthetic=` lies outside the range is never read and needs no check of its own.
    if (mapping !== null) {
      // A workload can look up a placeholder-shaped name such as `198.18.0.5.`, and policy DNS
      // maps it like any other name. That name is no destination either, so the address names
      // no host until a later record maps it to a real one.
      if (openShellPlaceholderAddress(mapping[1]!.replace(/\.$/, ""))) {
        hosts.delete(mapping[2]!.toLowerCase());
      } else {
        hosts.set(mapping[2]!.toLowerCase(), mapping[1]!);
      }
    }
    const placeholder = decorated.fields.dst_placeholder_ip;
    const host = placeholder === undefined ? undefined : hosts.get(placeholder.toLowerCase());
    return host === undefined || decorated.decision === undefined
      ? decorated
      : { ...decorated, decision: { ...decorated.decision, host } };
  });
}
