import { readFileSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { nativeStatus } from "./status.mjs";
import { serveHarness } from "./supervisor.mjs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (
  manifest.proxyOpenAiModelCredential !== undefined &&
  manifest.proxyOpenAiModelCredential !== true
) {
  throw new Error("Invalid Strands Box model credential mode.");
}
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
const directory = "/run/strands-listener";
const probePath = directory + "/probe.sock";
const tls = {
  key: readFileSync(directory + "/key.pem"),
  cert: readFileSync(directory + "/peer.pem"),
};
// A restarted supervisor cannot inherit the admitted execution's TLS identity.
unlinkSync(directory + "/key.pem");
let modelEnvironment = {};
if (manifest.proxyOpenAiModelCredential === true && !startupFailure) {
  const key = readFileSync("/run/strands-model/key", "utf8");
  if (!/^[!-~]{1,8192}$/u.test(key) || key.startsWith("strands_box_")) {
    throw new Error("Strands Box model credential is missing or invalid.");
  }
  modelEnvironment = { OPENAI_API_KEY: key };
}
const box = startupFailure
  ? undefined
  : spawn("/opt/strands-box/strands-box", ["run", "--config", "/etc/strands-box/box.toml"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        HOME: "/home/node",
        PATH: process.env.PATH,
        EXPERIMENTAL_LINUX_SUPPORT: "TRUE",
        ...modelEnvironment,
      },
    });
let shutdownRequested = false;
const { stop } = serveHarness(manifest, {
  tls,
  probePath,
  reader: box?.stdout,
  writer: box?.stdin,
  status: () => nativeStatus(probePath, startupFailure),
  terminate() {
    box?.kill("SIGTERM");
    if (box) setTimeout(() => box.kill("SIGKILL"), 8000).unref();
  },
});
box?.once("error", () => {
  console.error("Strands Box child process failed.");
  process.exitCode = 1;
  stop();
});
box?.once("exit", (code) => {
  stop();
  process.exitCode = shutdownRequested || code === 0 ? 0 : 1;
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    shutdownRequested = true;
    stop();
  });
}
