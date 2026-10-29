// Startup steps shared by the Kubernetes and Docker runtime wrappers. Each
// returns program text that a wrapper embeds in its generated Node program.

const STARTUP_PHASE_EVENT = "runtime.startup_phase";

// Apply the controls to the Gateway child, after OCE finishes configuration and plugin setup.
export function gatewayManagedModeEnvironment(managedMode: boolean): string {
  return JSON.stringify(
    managedMode
      ? {
          OPENCLAW_CONFIG_READONLY: "1",
          OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS: "1",
          OPENCLAW_DISABLE_CRON_HOST_EXECUTION: "1",
          OPENCLAW_CONFIG_READONLY_NOTICE:
            "OpenClaw Enterprise manages this Gateway’s configuration. In the OCE Console, edit and save the Agent’s draft Configuration, then select Deploy new version. https://docs-enterprise.openclaw.org/reference/agents/gateway-managed-mode/",
        }
      : {},
  );
}

// V8 sizes each isolate's young generation from the memory it sees: in a 4 GiB
// container a semi-space may grow to 64 MiB, in the Gateway's main isolate and in
// each of its ~25 worker_threads isolates. The flag is process-wide and overrides
// per-worker resourceLimits. On a remote test VM (median of 5, 1 CPU, finding
// 2700), 8 MiB cut the first-turn peak 2.56 -> 2.26 GiB (-12%) for +1.5% CPU to
// readiness and no slower first turn; 4 MiB saved 0.15 GiB more but cost +7% CPU
// and +14% first-turn time. An operator's NODE_OPTIONS comes last, so it wins.
const GATEWAY_NODE_OPTIONS = "--max-semi-space-size=8";

// Program text for the Gateway child's NODE_OPTIONS entry, spread after its environment.
export function gatewayNodeOptionsEnvironment(): string {
  return `{ NODE_OPTIONS: [${JSON.stringify(GATEWAY_NODE_OPTIONS)}, process.env.NODE_OPTIONS].filter(Boolean).join(" ") }`;
}

// One stderr JSON line per startup phase, for deploy-time measurement. Callers
// pass fixed phase names only: never provider, model, credential or path values.
// A failed phase may add a fixed upper-case cause code, which the Collector exports,
// and a fixed lower-case class of a native process's error output (finding 2017): callers
// pass only codexFailureOutputClass's literals, and OCC keeps only the contract's list.
// Date.now() keeps this usable in every wrapper, including stubbed test contexts.
export function startupPhaseHelper(container: "gateway" | "agent"): string {
  return String.raw`
const startupPhaseOrigin = Date.now();
function logStartupPhase(phase, startedAt, outcome = "ok", code, failureClass) {
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
    ...(failed && typeof failureClass === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(failureClass) ? { failureClass } : {}),
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
 * OpenClaw's agent and shared state database schemas (`OPENCLAW_AGENT_SCHEMA_VERSION`
 * and `OPENCLAW_STATE_SCHEMA_VERSION` in src/state/openclaw-schema-versions.ts) at
 * the runtime image's pinned OPENCLAW_COMMIT. The runtime image tests that migrate
 * a released Gateway and a released workspace node fail when a pin moves either;
 * update them with the pin.
 */
export const OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION = 38;
export const OPENCLAW_STATE_DATABASE_SCHEMA_VERSION = 36;

// A Gateway and a dedicated Harness's workspace node keep OpenClaw state across
// runtime image upgrades. OpenClaw refuses an older agent database (exit 78) and
// moves the client credentials of an older shared state database (schema 29)
// only under Doctor's backed-up migration custody, so it needs
// "openclaw doctor --fix" first. OpenClaw's own image entrypoint runs that Doctor
// pass before every Gateway start. The Kubernetes and Docker wrappers replace
// that entrypoint, so they run the same pass for each state directory they start
// OpenClaw on, but only when a database needs it: fresh and current state start
// without Doctor's ~15 s. Doctor must not rewrite the controller-owned
// configuration (OPENCLAW_CONFIG_READONLY), and it never deletes state: it saves
// a pre-migration copy beside each database and verifies integrity first. The
// schema versions after Doctor, not its exit status, decide: Doctor also exits
// non-zero for problems it can only report here. On failure the step is named
// and the wrapper must not start OpenClaw; `retry` completes the log line's
// remedy. The wrapper provides `spawn`, `logStartupPhase` and
// `publishRuntimeFailure`.
export function openClawStateMigrationHelper(
  owner: "Gateway" | "Harness" | "Native worker",
  retry: string,
): string {
  return String.raw`
function outdatedOpenClawDatabases(stateDirectory) {
  const { join } = require("node:path");
  const candidates = [
    { path: join(stateDirectory, "state", "openclaw.sqlite"), current: ${OPENCLAW_STATE_DATABASE_SCHEMA_VERSION}, shared: true },
  ];
  let agentIds = [];
  try {
    agentIds = require("node:fs").readdirSync(join(stateDirectory, "agents"));
  } catch {
    // Fresh state, and a workspace node's, has no agents directory.
  }
  for (const agentId of agentIds) {
    candidates.push({
      path: join(stateDirectory, "agents", agentId, "agent", "openclaw-agent.sqlite"),
      current: ${OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION},
    });
  }
  // Outside the per-database try: without the module, startup fails instead of skipping.
  const { DatabaseSync } = require("node:sqlite");
  const outdated = [];
  for (const { path, current, shared } of candidates) {
    let version;
    try {
      // A read-only open of a missing database fails here.
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        version = database.prepare("PRAGMA user_version").get().user_version;
        if (shared) {
          // OpenClaw can publish current shared content under an older header
          // while an older updater runs; its content marker then names the schema.
          try {
            const marker = Number(JSON.parse(database.prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
            ).get()?.value_json ?? "0"));
            if (Number.isSafeInteger(marker) && marker > version) version = marker;
          } catch {
            // No marker table or row: the header names the schema.
          }
        }
      } finally {
        database.close();
      }
    } catch {
      // OpenClaw's own startup check reports a database it cannot read.
      continue;
    }
    // 0 is a database OpenClaw has not initialized; a newer one needs its backup.
    if (version > 0 && version < current) outdated.push({ path, version, current });
  }
  return outdated;
}

function runStateMigrationDoctor(environment) {
  return new Promise((resolve) => {
    const doctor = spawn(
      process.execPath,
      ["/app/openclaw.mjs", "doctor", "--fix", "--non-interactive"],
      { stdio: "inherit", env: { ...environment, OPENCLAW_CONFIG_READONLY: "1" } },
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

// Runs Doctor with the environment OpenClaw itself starts with on stateDirectory.
// Resolves true once Doctor brought every outdated database current, false after
// naming the failure; exits when terminated during Doctor.
async function migrateOpenClawState(stateDirectory, outdated, environment) {
  const startedAt = Date.now();
  console.error(
    "Migrating " + outdated.length + " OpenClaw database(s) from schema " +
      outdated.map(({ version, current }) => version + " to " + current).join(", ") +
      " with openclaw doctor --fix.",
  );
  const doctor = await runStateMigrationDoctor(environment);
  if (doctor.terminating) process.exit(0);
  const remaining = outdatedOpenClawDatabases(stateDirectory);
  if (remaining.length === 0) {
    logStartupPhase("state-migration", startedAt);
    return true;
  }
  logStartupPhase("state-migration", startedAt, "failed");
  publishRuntimeFailure("state-migration", "UNAVAILABLE");
  console.error(
    "${owner} state migration failed: openclaw doctor --fix (" + doctor.outcome + ") left " +
      remaining.map(({ path, version }) => path + " at schema " + version).join(", ") +
      ". OpenClaw was not started. Read the Doctor output above, fix the cause, then ${retry}.",
  );
  return false;
}
`;
}
