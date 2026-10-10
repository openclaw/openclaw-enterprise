// Startup steps shared by the Kubernetes and Docker runtime wrappers. Each
// returns program text that a wrapper embeds in its generated Node program.

const STARTUP_PHASE_EVENT = "runtime.startup_phase";

// One stderr JSON line per startup phase, for deploy-time measurement. Callers
// pass fixed phase names only: never provider, model, credential or path values.
// A failed phase may add a fixed upper-case cause code, which the Collector exports.
// Date.now() keeps this usable in every wrapper, including stubbed test contexts.
export function startupPhaseHelper(container: "gateway" | "agent"): string {
  return String.raw`
const startupPhaseOrigin = Date.now();
function logStartupPhase(phase, startedAt, outcome = "ok", code) {
  const now = Date.now();
  const failed = outcome !== "ok";
  console.error(JSON.stringify({
    event: ${JSON.stringify(STARTUP_PHASE_EVENT)},
    container: ${JSON.stringify(container)},
    phase,
    outcome: failed ? "failed" : "ok",
    ms: now - startedAt,
    sinceStartMs: now - startupPhaseOrigin,
    ...(failed && typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
  }));
}
async function timeStartupPhase(phase, run) {
  const startedAt = Date.now();
  const result = await run();
  logStartupPhase(phase, startedAt);
  return result;
}
`;
}

/**
 * OpenClaw's agent database schema (`OPENCLAW_AGENT_SCHEMA_VERSION` in
 * src/state/openclaw-agent-db-contract.ts) at the runtime image's pinned
 * OPENCLAW_COMMIT. The runtime image test that migrates a released Gateway
 * fails when a pin moves it; update it with the pin.
 */
export const OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION = 24;

// A Gateway keeps its agent databases across runtime image upgrades. OpenClaw
// refuses one with an older schema (exit 78) until "openclaw doctor --fix"
// migrates it, and its own image entrypoint runs that Doctor pass before every
// Gateway start. The Kubernetes and Docker Gateway wrappers replace that
// entrypoint, so they run the same pass, but only when a database needs it:
// fresh and current state start without Doctor's ~15 s. Doctor must not
// rewrite the controller-owned configuration (OPENCLAW_CONFIG_READONLY). The
// schema versions after Doctor, not its exit status, decide: Doctor also exits
// non-zero for problems it can only report here. On failure the step is named
// and the wrapper must not start OpenClaw; `retry` completes the log line's
// remedy. The wrapper provides `spawn`, `logStartupPhase` and
// `publishRuntimeFailure`.
export function gatewayStateMigrationHelper(retry: string): string {
  return String.raw`
function outdatedAgentDatabases() {
  const agentsDirectory = require("node:path").join(process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw", "agents");
  let agentIds;
  try {
    agentIds = require("node:fs").readdirSync(agentsDirectory);
  } catch {
    // Fresh state has no agents directory.
    return [];
  }
  // Outside the per-database try: without the module, startup fails instead of skipping.
  const { DatabaseSync } = require("node:sqlite");
  const outdated = [];
  for (const agentId of agentIds) {
    const path = require("node:path").join(agentsDirectory, agentId, "agent", "openclaw-agent.sqlite");
    let version;
    try {
      // A read-only open of a missing database fails here.
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        version = database.prepare("PRAGMA user_version").get().user_version;
      } finally {
        database.close();
      }
    } catch {
      // OpenClaw's own startup check reports a database it cannot read.
      continue;
    }
    // 0 is a database OpenClaw has not initialized; a newer one needs its backup.
    if (version > 0 && version < ${OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION}) outdated.push({ path, version });
  }
  return outdated;
}

function runStateMigrationDoctor() {
  return new Promise((resolve) => {
    const doctor = spawn(
      process.execPath,
      ["/app/openclaw.mjs", "doctor", "--fix", "--non-interactive"],
      { stdio: "inherit", env: { ...process.env, OPENCLAW_CONFIG_READONLY: "1" } },
    );
    let terminating = false;
    // Doctor's maintenance lease owns termination: let it stop its transaction.
    const stop = (signal) => {
      terminating = true;
      doctor.kill(signal);
    };
    const onTerm = () => stop("SIGTERM");
    const onInt = () => stop("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    const settle = (outcome) => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve({ outcome, terminating });
    };
    doctor.on("error", (error) => settle("error-" + (error?.code ?? "spawn")));
    doctor.on("exit", (code, signal) => settle(signal ?? "exit-" + code));
  });
}

// Resolves true once Doctor brought every outdated database current, false
// after naming the failure; exits when terminated during Doctor.
async function migrateGatewayState(outdated) {
  const startedAt = Date.now();
  console.error(
    "Migrating " + outdated.length + " OpenClaw agent database(s) from schema " +
      outdated.map(({ version }) => version).join(", ") + " to ${OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION} with openclaw doctor --fix.",
  );
  const doctor = await runStateMigrationDoctor();
  if (doctor.terminating) process.exit(0);
  const remaining = outdatedAgentDatabases();
  if (remaining.length === 0) {
    logStartupPhase("state-migration", startedAt);
    return true;
  }
  logStartupPhase("state-migration", startedAt, "failed");
  publishRuntimeFailure("state-migration", "UNAVAILABLE");
  console.error(
    "Gateway state migration failed: openclaw doctor --fix (" + doctor.outcome + ") left " +
      remaining.map(({ path, version }) => path + " at schema " + version).join(", ") +
      ". OpenClaw was not started. Read the Doctor output above, fix the cause, then ${retry}.",
  );
  return false;
}
`;
}
