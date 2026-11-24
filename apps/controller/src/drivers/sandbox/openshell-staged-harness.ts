/** The canonical Sandbox process stays idle until Compute activates its prepared launch. */
export function stagedHarnessSupervisor(command: readonly string[]): string {
  return String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
process.umask(0o077);
const socketPath = path.join(process.env.HOME, ".oce-staged-harness.sock");
const planPath = path.join(process.env.HOME, ".oce-staged-harness.json");
const command = ${JSON.stringify(command)};
fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
fs.writeFileSync(planPath, JSON.stringify({ state: "idle", command }), { mode: 0o600 });
let child;
let activated = false;
let stopping = false;
fs.rmSync(socketPath, { force: true });
const server = net.createServer((peer) => {
  let input = "";
  peer.on("data", (chunk) => {
    input += chunk.toString("utf8");
    if (input.length > 400000) return peer.destroy();
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    if (activated) return peer.end("refused");
    try {
      const supplied = JSON.parse(input.slice(0, newline));
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      if (plan.state !== "prepared") throw new Error();
      const environment = { ...process.env };
      for (const projection of plan.projections) {
        delete environment[projection.environment];
        const value = projection.placeholder.kind === "runtime"
          ? supplied[projection.environment]
          : projection.placeholder.value;
        if (typeof value !== "string" || value.length === 0) throw new Error();
        environment[projection.environment] = value;
      }
      activated = true;
      child = spawn(plan.command[0], plan.command.slice(1), {
        env: environment,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.once("spawn", () => {
        fs.writeFileSync(planPath, JSON.stringify({ state: "active" }), { mode: 0o600 });
        server.close();
        fs.rmSync(socketPath, { force: true });
        peer.end("ok");
      });
      child.once("error", () => { peer.end("failed"); process.exitCode = 1; server.close(); });
      child.once("exit", (code, signal) => process.exit(stopping ? 0 : (code ?? (signal ? 1 : 0))));
    } catch {
      peer.end("refused");
    }
  });
});
server.listen(socketPath);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  stopping = true;
  if (child) child.kill(signal);
  else process.exit(0);
});
`;
}

/** Preparation carries launch inputs privately on ExecSandbox stdin. */
export const STAGED_HARNESS_PREPARE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const input = fs.readFileSync(0);
if (input.length > 400000) process.exit(1);
const planPath = path.join(process.env.HOME, ".oce-staged-harness.json");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (plan.state === "active") process.exit(0);
const projections = JSON.parse(input.toString("utf8"));
if ((plan.state !== "idle" && plan.state !== "prepared") || !Array.isArray(plan.command) || plan.command.length === 0 || !Array.isArray(projections)) process.exit(1);
fs.writeFileSync(planPath, JSON.stringify({ state: "prepared", command: plan.command, projections }), { mode: 0o600 });
`;

/** ExecSandbox receives the supervisor's current provider environment on each fresh launch. */
export const STAGED_HARNESS_ACTIVATE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const plan = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".oce-staged-harness.json"), "utf8"));
if (plan.state === "active") process.exit(0);
if (plan.state !== "prepared") process.exit(1);
const environment = {};
for (const projection of plan.projections) {
  if (projection.placeholder.kind !== "runtime") continue;
  const value = process.env[projection.environment];
  const match = typeof value === "string" && /^openshell:resolve:env:(?:v[0-9]+|s[0-9a-f]{64})_([A-Z][A-Z0-9_]*)$/.exec(value);
  if (!match || match[1] !== projection.environment) process.exit(1);
  environment[projection.environment] = value;
}
const peer = net.connect(path.join(process.env.HOME, ".oce-staged-harness.sock"));
let result = "";
peer.setTimeout(10000, () => peer.destroy(new Error()));
peer.on("connect", () => peer.write(JSON.stringify(environment) + "\n"));
peer.on("data", (chunk) => { result += chunk.toString("utf8"); });
peer.on("error", () => process.exitCode = 1);
peer.on("end", () => { if (result !== "ok") process.exitCode = 1; });
`;
