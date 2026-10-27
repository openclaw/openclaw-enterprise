import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { serveHarness } from "./supervisor.mjs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
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
