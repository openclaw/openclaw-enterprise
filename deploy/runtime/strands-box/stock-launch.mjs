import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { holdStockKey, requireModelKey } from "./stock-stage.mjs";
import { prepareStockConfig, requireStockProfile } from "./stock-guard.mjs";
import { connectStockControl, pipeStockBox } from "./stock-launch-transport.mjs";

const executable = "/opt/strands-box/strands-box";
let control;
try {
  // Container PID 1 exiting also retires descendants if Box loses supervision.
  if (process.pid !== 1) throw new Error();
  requireStockProfile();
  const manifest = JSON.parse(readFileSync("/etc/strands-box/workload.json", "utf8"));
  const supplied = process.env.OCE_STRANDS_OPENAI_KEY;
  delete process.env.OCE_STRANDS_OPENAI_KEY;
  const podUid = process.env.OCE_STRANDS_POD_UID;
  const staged = manifest.stockStaged !== undefined;
  if (
    manifest.stockTransport !== true ||
    (staged ? supplied !== undefined || !podUid : podUid !== undefined)
  ) {
    throw new Error();
  }
  let key = staged ? undefined : requireModelKey(supplied);
  const env = { HOME: "/home/node", PATH: process.env.PATH, EXPERIMENTAL_LINUX_SUPPORT: "TRUE" };
  const version = execFileSync(executable, ["--version"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (version.trim() !== "strands-box 0.3.1") throw new Error();
  const input = readFileSync("/etc/strands-box/box.toml");
  const config = prepareStockConfig(input.toString());
  control = await connectStockControl();
  if (staged) {
    key = await holdStockKey(
      control,
      manifest.stockStaged,
      podUid,
      input,
      readFileSync("/etc/strands-box/policy.dw"),
    );
  }
  // Only Box run receives the real value. Its env:// route substitutes the
  // placeholder in the nested namespace. Never forward raw Box diagnostics.
  const box = spawn(executable, ["run", "--config", config], {
    env: { ...env, OPENAI_API_KEY: key },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const { stop, done } = pipeStockBox(control, box);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => stop());
  }
  process.exitCode = await done;
  if (process.exitCode) console.error("Stock Strands Box supervision ended.");
} catch {
  control?.destroy();
  console.error("Stock Strands Box launcher failed to start.");
  process.exitCode = 1;
}
