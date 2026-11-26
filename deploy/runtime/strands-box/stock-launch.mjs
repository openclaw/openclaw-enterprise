import { execFileSync, spawn } from "node:child_process";
import { prepareStockConfig, requireStockProfile } from "./stock-guard.mjs";
import { connectStockControl, pipeStockBox } from "./stock-launch-transport.mjs";

const executable = "/opt/strands-box/strands-box";
let control;
try {
  // Container PID 1 exiting also retires descendants if Box loses supervision.
  if (process.pid !== 1) throw new Error();
  requireStockProfile();
  const key = process.env.OCE_STRANDS_OPENAI_KEY;
  delete process.env.OCE_STRANDS_OPENAI_KEY;
  if (!key || !/^[!-~]{16,4096}$/u.test(key) || key.startsWith("strands_box_")) {
    throw new Error();
  }
  const env = { HOME: "/home/node", PATH: process.env.PATH, EXPERIMENTAL_LINUX_SUPPORT: "TRUE" };
  const version = execFileSync(executable, ["--version"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (version.trim() !== "strands-box 0.3.1") throw new Error();
  const config = prepareStockConfig();
  control = await connectStockControl();
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
