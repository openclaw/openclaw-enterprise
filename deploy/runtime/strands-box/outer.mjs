import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { serveStatus } from "./status.mjs";
import { serveHarness } from "./supervisor.mjs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
// The private socket belongs to the file-node init container. Kubernetes starts
// this supervisor once the node can report either terminal baseline outcome.
let startupFailure;
if (manifest.workspaceOutcome) {
  const socket = connect(manifest.workspaceOutcome);
  socket.setTimeout(3000, () => socket.destroy(new Error("Workspace outcome timed out")));
  let body = "";
  for await (const chunk of socket) {
    body += chunk;
    if (body.length > 1024) throw new Error("Invalid workspace outcome size");
  }
  const outcome = JSON.parse(body);
  if (
    outcome.state === "failed" &&
    outcome.runtimeFailure?.component === "agent" &&
    ["workspace-baseline", "state-migration"].includes(outcome.runtimeFailure.check) &&
    outcome.runtimeFailure.code === "UNAVAILABLE" &&
    Number.isFinite(Date.parse(outcome.runtimeFailure.checkedAt))
  ) {
    startupFailure = outcome.runtimeFailure;
  } else if (outcome.state !== "ready") {
    throw new Error("Invalid workspace outcome");
  }
}
const status = serveStatus(manifest, startupFailure);
if (!startupFailure) startBox();

function startBox() {
  const box = spawn(
    "/opt/strands-box/strands-box",
    ["run", "--config", "/etc/strands-box/box.toml"],
    {
      stdio: ["pipe", "pipe", "inherit"],
      // The supervisor receives no model Secret environment. Private Secret files
      // are opened by the contained bootstrap, not serialized into Box config.
      env: { HOME: "/home/node", PATH: process.env.PATH, EXPERIMENTAL_LINUX_SUPPORT: "TRUE" },
    },
  );
  let shutdownRequested = false;
  const { stop } = serveHarness(manifest, {
    reader: box.stdout,
    writer: box.stdin,
    terminate() {
      status.close();
      status.closeAllConnections();
      box.kill("SIGTERM");
      setTimeout(() => box.kill("SIGKILL"), 8000).unref();
    },
  });
  box.on("error", stop);
  box.on("exit", (code) => {
    stop();
    process.exitCode = shutdownRequested || code === 0 ? 0 : 1;
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      shutdownRequested = true;
      stop();
    });
  }
}
