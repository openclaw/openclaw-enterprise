import { maskPrivateKeyLines } from "./failure-redaction.mjs";

// Bootstrap logs can contain K3s join tokens. Never publish credential-bearing
// lines, full object specs, kubeconfigs, or container environments.
const CREDENTIAL_LINE =
  /token|password|secret|credential|authorization|bearer|private.?key|https?:\/\/[^\s/]+@/i;

export function maskPrivateKeyLogLines(lines: readonly string[]): string[] {
  const masked: unknown = maskPrivateKeyLines(lines);
  if (!Array.isArray(masked) || !masked.every((line: unknown) => typeof line === "string")) {
    throw new TypeError("Expected string log lines from private key masking.");
  }
  return masked;
}

export function redactCredentialLine<T>(line: T): T | string {
  return CREDENTIAL_LINE.test(`${line}`) ? "[redacted credential-bearing line]" : line;
}

// k3d's node entrypoint starts K3s in the background and retries `kubectl
// uncordon` every 3 seconds until it succeeds, so a plain tail of a node whose
// K3s never came up holds nothing else (findings 15 and 1174). The retries go to
// localhost:8080 until K3s writes its kubeconfig, then to its API port. If K3s
// exits, the loop keeps the container running and k3d waits for K3s forever;
// only the switch to "connection refused" on the API port dates the exit. The
// excerpt drops the retries, notes each target and outcome with its first and
// last time, keeps the start of each node's log, its first and last error and
// warning lines, and its end, and stays under about 40 KB per node.

// kubectl's own klog error line; K3s's logrus lines never match it.
const KUBECTL_DISCOVERY_RETRY =
  /^\S+ E\d{4} [\d:.]+\s+\d+ memcache\.go:\d+\] .*couldn't get current server API group list: (.*)$/;
const KUBECTL_REFUSED_RETRY = /^\S+ The connection to the server (\S+) was refused/;
const KUBECTL_SERVER_RETRY =
  /^\S+ (?:Error from server \((\w+)\): |error: You must be logged in to the server \((\w+)\)|Unable to connect to the server: (.*)$)/;
const KUBECTL_RETRY_KINDS = 12;

function retryOutcome(detail: string): string {
  if (/connection refused/.test(detail)) {
    return "connection refused";
  }
  if (/unable to handle the request/.test(detail)) {
    return "ServiceUnavailable";
  }
  return (detail.split(": ").at(-1) ?? "").slice(0, 80);
}

// The target and outcome of one kubectl retry line, or undefined for any other line.
function kubectlRetry(line: string): string | undefined {
  const discovery = KUBECTL_DISCOVERY_RETRY.exec(line);
  if (discovery) {
    // The error ends at err="..."'s first unescaped quote; a logger field may follow.
    const detail = (discovery[1] ?? "").replace(/(?<!\\)".*$/u, "");
    const server = /Get \\?"https?:\/\/([^/\\"]+)/.exec(detail)?.[1];
    return `${server ?? "the API server"} (${retryOutcome(detail)})`;
  }
  const refused = KUBECTL_REFUSED_RETRY.exec(line);
  if (refused) {
    return `${refused[1]} (connection refused)`;
  }
  const answered = KUBECTL_SERVER_RETRY.exec(line);
  if (answered) {
    return `the API server (${answered[1] ?? answered[2] ?? retryOutcome(answered[3] ?? "")})`;
  }
  return undefined;
}

// docker logs --timestamps stamps every line; anything else is a fragment.
const DOCKER_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
// logrus level=error/warning/fatal, or a klog E/W/F header after the timestamp.
const PROBLEM_LINE = /\blevel=(?:error|warning|fatal)\b|^\S+ [EWF]\d{4} /;
const NODE_LOG_LINE_CHARS = 1_000;
const NODE_LOG_HEAD = { lines: 60, chars: 8_000 };
const NODE_LOG_FIRST_PROBLEMS = { lines: 20, chars: 4_000 };
const NODE_LOG_LAST_PROBLEMS = { lines: 100, chars: 12_000 };
const NODE_LOG_TAIL_CHARS = 16_000;
function takeWithin(
  lines: string[],
  { lines: maxLines = Infinity, chars }: { lines?: number; chars: number },
  fromEnd = false,
): string[] {
  const ordered = fromEnd ? [...lines].reverse() : lines;
  const taken = [];
  let size = 0;
  for (const line of ordered) {
    if (taken.length >= maxLines || size + line.length + 1 > chars) {
      break;
    }
    taken.push(line);
    size += line.length + 1;
  }
  return fromEnd ? taken.reverse() : taken;
}

// Canonical UTC keys contain ASCII digits and punctuation, independent of locale.
function compareTimestamps(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type NodeLogEntry = {
  at: string;
  stream: number;
  index: number;
  redacted: boolean;
  line: string;
  stamp: string;
};

type RetrySummary = {
  count: number;
  first: string;
  last: string;
  lastAt: string;
};

// Docker returns a container's stdout and stderr separately; --timestamps lets
// the excerpt restore their order. Unstamped fragments (an output cap can cut a
// stream mid-line) are dropped unread, and a redacted line keeps only its
// timestamp.
export function nodeLogExcerpt(stdout: unknown = "", stderr: unknown = "", note?: unknown): string {
  const entries: NodeLogEntry[] = [];
  let fragments = 0;
  const streams: [number, unknown][] = [
    [0, stdout],
    [1, stderr],
  ];
  for (const [stream, text] of streams) {
    for (const raw of String(text ?? "").split("\n")) {
      if (raw.trim() === "") {
        continue;
      }
      const stamp = raw.split(" ", 1)[0] ?? "";
      if (!DOCKER_TIMESTAMP.test(stamp)) {
        fragments += 1;
        continue;
      }
      entries.push({
        // Docker timestamps are UTC. Canonical decimal fractions preserve precision
        // and compare equal when their only difference is trailing zeroes.
        at: stamp.replace(
          /(?:\.(\d+))?Z$/u,
          (_match: string, fraction: string = "") => `.${fraction.replace(/0+$/u, "")}`,
        ),
        stream,
        index: entries.length,
        // Test the whole line for credentials before truncating it.
        redacted: CREDENTIAL_LINE.test(raw),
        line: raw.slice(0, NODE_LOG_LINE_CHARS),
        stamp,
      });
    }
  }
  entries.sort((a, b) => compareTimestamps(a.at, b.at) || a.stream - b.stream || a.index - b.index);
  const kept = [];
  const problems = new Set<number>();
  const retries = new Map<string, RetrySummary>();
  for (const { at, line, redacted, stamp } of entries) {
    const retry = redacted ? undefined : kubectlRetry(line);
    if (retry !== undefined) {
      const seen = retries.get(retry) ?? { count: 0, first: stamp, last: stamp, lastAt: at };
      seen.count += 1;
      seen.last = stamp;
      seen.lastAt = at;
      retries.set(retry, seen);
      continue;
    }
    if (PROBLEM_LINE.test(line)) {
      problems.add(kept.length);
    }
    kept.push(redacted ? `${stamp} [redacted credential-bearing line]` : line);
  }
  const notes = [
    ...(note ? [`[diagnostics: ${note}]`] : []),
    ...(fragments > 0 ? [`[diagnostics dropped ${fragments} unstamped line fragments]`] : []),
    // The latest kinds date the end of the log, so a long list keeps those, in
    // the order they first appeared.
    ...[...retries]
      .map((entry, order) => ({ entry, order }))
      .sort((a, b) => compareTimestamps(b.entry[1].lastAt, a.entry[1].lastAt))
      .slice(0, KUBECTL_RETRY_KINDS)
      .sort((a, b) => a.order - b.order)
      .map(
        ({ entry: [target, { count, first, last }] }) =>
          `[diagnostics omitted ${count} kubectl retry lines against ${target}, ${first} to ${last}]`,
      ),
    ...(retries.size > KUBECTL_RETRY_KINDS
      ? [
          `[diagnostics omitted ${retries.size - KUBECTL_RETRY_KINDS} earlier kinds of kubectl retry lines]`,
        ]
      : []),
  ];
  const budget =
    NODE_LOG_HEAD.chars +
    NODE_LOG_FIRST_PROBLEMS.chars +
    NODE_LOG_LAST_PROBLEMS.chars +
    NODE_LOG_TAIL_CHARS;
  if (kept.join("\n").length <= budget) {
    return [...notes, ...kept].join("\n");
  }
  const head = takeWithin(kept, NODE_LOG_HEAD);
  const tail = takeWithin(kept.slice(head.length), { chars: NODE_LOG_TAIL_CHARS }, true);
  const middleEnd = kept.length - tail.length;
  const middle = kept
    .slice(head.length, middleEnd)
    .filter((_, offset) => problems.has(head.length + offset));
  // An early root cause must survive later repeated warnings.
  const first = takeWithin(middle, NODE_LOG_FIRST_PROBLEMS);
  const last = takeWithin(middle.slice(first.length), NODE_LOG_LAST_PROBLEMS, true);
  const shown = first.length + last.length;
  return [
    ...notes,
    ...head,
    `[diagnostics omitted ${middleEnd - head.length - shown} lines; ${shown} of ${middle.length} error and warning lines between head and tail follow]`,
    ...first,
    ...(middle.length > shown ? ["[...]"] : []),
    ...last,
    "[diagnostics: end of log follows]",
    ...tail,
  ].join("\n");
}
