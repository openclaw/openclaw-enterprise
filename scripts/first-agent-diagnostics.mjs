import {
  CODEX_FAILURE_OUTPUT_CLASSES,
  RUNTIME_DIAGNOSTIC_CODES,
} from "../packages/contracts/src/runtime-failure.mjs";

const states = new Set(["waiting", "running", "terminated", "unknown"]);
const events = new Set([
  "codex.login",
  "codex.model_probe",
  "openclaw.model_probe",
  "runtime.startup_phase",
]);
const namePattern = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;

function sameStream(stream, role, target) {
  return (
    stream?.source === role &&
    stream.pod === target.name &&
    stream.podUid === target.uid &&
    stream.container === target.container &&
    stream.restartCount === target.restartCount
  );
}

function observation(record) {
  if (record.type !== "line" || record.contentClass !== "operational") {
    return undefined;
  }
  // The public runtime API has already classified and redacted these messages.
  // Activity/content records and unstructured text are not diagnostic evidence.
  if (
    ["codex", "openclaw"].includes(record.kind) &&
    ["warn", "error"].includes(record.level) &&
    typeof record.message === "string"
  ) {
    return `${record.level}: ${record.message.slice(0, 512).replace(/\p{C}/gu, " ")}`;
  }
  if (record.kind !== "wrapper" || !events.has(record.message)) {
    return undefined;
  }
  const fields = record.fields ?? {};
  const detail = [];
  if (RUNTIME_DIAGNOSTIC_CODES.includes(fields.code)) {
    detail.push(`code=${fields.code}`);
  }
  if (CODEX_FAILURE_OUTPUT_CLASSES.includes(fields.failureClass)) {
    detail.push(`failureClass=${fields.failureClass}`);
  }
  if (Number.isInteger(fields.exitCode) && fields.exitCode >= 0 && fields.exitCode <= 255) {
    detail.push(`exitCode=${fields.exitCode}`);
  }
  if (
    Number.isInteger(fields.providerStatus) &&
    fields.providerStatus >= 100 &&
    fields.providerStatus <= 599
  ) {
    detail.push(`providerStatus=${fields.providerStatus}`);
  }
  return detail.length ? `${record.message} ${detail.join(" ")}` : undefined;
}

/** A bounded post-failure snapshot, never a replacement for the original model error. */
export async function collectFirstAgentDiagnostics(
  api,
  { namespaceId, agentId, revisionId, gateway },
) {
  const lines = [
    "Runtime snapshot after model failure (observations do not establish the request's cause):",
  ];
  const path = `/namespaces/${encodeURIComponent(namespaceId)}/agents/${encodeURIComponent(agentId)}/deployments/${encodeURIComponent(revisionId)}/runtime`;
  const request = { signal: AbortSignal.timeout(10_000), maxBytes: 65_536 };
  try {
    const description = await api("GET", path, undefined, request);
    if (
      description.revisionId !== revisionId ||
      !Array.isArray(description.pods) ||
      !Array.isArray(description.sources)
    ) {
      throw new Error("Unusable runtime description");
    }
    if (["running", "starting", "lost", "unknown"].includes(description.harness?.state)) {
      const { state, exitCode, restarts } = description.harness;
      lines.push(
        `Harness: ${state}${validCount(restarts) ? `, restarts=${restarts}` : ""}${Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? `, lastExit=${exitCode}` : ""}`,
      );
    }
    for (const role of ["gateway", "agent"]) {
      const sources = description.sources.filter(
        (source) => source.id === role && source.kind === "container",
      );
      if (role === "agent" && sources.length === 0) {
        continue;
      }
      const pods = description.pods.filter((pod) => pod.role === role);
      if (sources.length !== 1 || pods.length !== 1) {
        lines.push(`${role}: runtime evidence unavailable (no unique owned Pod).`);
        continue;
      }
      const pod = pods[0];
      if (
        role === "gateway" &&
        (!gateway.uid || pod.name !== gateway.pod || pod.uid !== gateway.uid)
      ) {
        lines.push("gateway: original Pod unavailable or replaced; logs omitted.");
        continue;
      }
      if (
        !namePattern.test(pod.name) ||
        !Array.isArray(pod.containers) ||
        !Array.isArray(sources[0].pods)
      ) {
        throw new Error("Unusable runtime Pod");
      }
      lines.push(`${role}: ready=${pod.ready === true}`);
      // The API orders main containers before init containers. Bound work even for malformed responses.
      const targets = sources[0].pods.filter(
        (target) => target.name === pod.name && target.uid === pod.uid,
      );
      if (targets.length > 2) {
        lines.push(`${role}: additional container evidence omitted.`);
      }
      for (const target of targets.slice(0, 2)) {
        const container = pod.containers.find((item) => item.name === target.container);
        if (
          !container ||
          !namePattern.test(target.container) ||
          !states.has(container.state) ||
          !validCount(target.restartCount) ||
          container.restartCount !== target.restartCount
        ) {
          lines.push(`${role}: container evidence unavailable.`);
          continue;
        }
        if (
          role === "gateway" &&
          (target.container !== "gateway" || target.restartCount !== gateway.restartCount)
        ) {
          lines.push("gateway: original container unavailable or restarted; logs omitted.");
          continue;
        }
        const exit = container.lastTermination?.exitCode;
        lines.push(
          `${role}/${target.container}: ${container.state}, ready=${container.ready === true}, restarts=${target.restartCount}${Number.isInteger(exit) && exit >= 0 && exit <= 255 ? `, lastExit=${exit}` : ""}`,
        );
        try {
          const query = new URLSearchParams({
            source: role,
            pod: target.name,
            container: target.container,
            tailLines: "100",
            sinceSeconds: "600",
          });
          const page = await api("GET", `${path}/logs?${query}`, undefined, request);
          if (
            page.revisionId !== revisionId ||
            page.source !== role ||
            !sameStream(page.stream, role, target) ||
            !Array.isArray(page.records) ||
            page.records.some(
              (record) => !sameStream(record.stream, role, target) || record.type === "gap",
            )
          ) {
            lines.push(`${role}: log stream unavailable or replaced.`);
            continue;
          }
          const observed = new Set(page.records.map(observation).filter(Boolean));
          for (const item of [...observed].slice(0, 8)) {
            lines.push(`${role}: observed ${item}`);
          }
          const incomplete =
            page.truncated ||
            page.withheld > 0 ||
            page.records.some((record) => record.type === "withheld" || record.truncated) ||
            observed.size > 8;
          lines.push(
            `${role}: ${incomplete ? "incomplete log evidence" : "bounded log sample"}${observed.size === 0 ? "; no classified observation" : ""}.`,
          );
        } catch {
          lines.push(`${role}: log evidence unavailable (request failed or exceeded its limit).`);
        }
      }
    }
  } catch {
    lines.push("Runtime evidence unavailable (request failed or exceeded its limit).");
  }
  return lines.join("\n");
}
