import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensureEmpty, hostConfig, readConfig, smokeInput, start } from "../host/launch.ts";
import { seededNonce } from "./operator.ts";

const modelConfig = `model = "gpt-5"
model_provider = "box_repro_fixture"

[model_providers.box_repro_fixture]
name = "Controlled workspace reproduction"
base_url = "http://127.0.0.1:18949/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0

[analytics]
enabled = false

[otel]
exporter = "none"
metrics_exporter = "none"
log_user_prompt = false
`;
const canonical = (x: string | undefined): x is string =>
  Boolean(x && isAbsolute(x) && realpathSync(x) === x && lstatSync(x).isFile());
async function main() {
  const [configFile, fixture, run] = process.argv.slice(2);
  if (
    process.platform !== "linux" ||
    process.arch !== "arm64" ||
    process.getuid?.() === 0 ||
    process.argv.length !== 5 ||
    !canonical(configFile) ||
    !canonical(fixture) ||
    !fixture.endsWith("/box-workload.js")
  )
    throw Error("INPUT_REFUSED");
  const nonce = seededNonce(run);
  const config = hostConfig(readConfig(configFile));
  if (
    config.workspace !== "/home/node/workspace" ||
    !/^[a-f0-9]{64}$/.test(config.workspaceVerifierSha256 ?? "")
  )
    throw Error("PINNED_PUBLIC_VERIFIER_REQUIRED");
  ensureEmpty(config.runtimeDir);
  process.umask(0o077);
  const { input, capability } = smokeInput(config);
  const [native, verb, flag, listen, authFlag, auth, hashFlag, hash] = input.command;
  if (
    !native ||
    native !== config.codexBin ||
    verb !== "app-server" ||
    flag !== "--listen" ||
    listen !== "ws://127.0.0.1:18790" ||
    authFlag !== "--ws-auth" ||
    auth !== "capability-token" ||
    hashFlag !== "--ws-token-sha256" ||
    !hash ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    input.command.length !== 8 ||
    !input.environment.CODEX_HOME
  )
    throw Error("NORMAL_NATIVE_COMMAND_REQUIRED");
  writeFileSync(join(input.environment.CODEX_HOME, "config.toml"), modelConfig, {
    mode: 0o600,
    flag: "wx",
  });
  const execution = start(
    config,
    {
      ...input,
      command: [config.nodeBin, "--jitless", fixture, nonce, ...input.command],
      readOnly: [...input.readOnly, fixture],
    },
    capability,
  );
  const stop = () => void execution.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await execution.ready;
    process.stdout.write("BOX_REPRO_NATIVE_READY\n");
    process.exitCode = await execution.done;
  } finally {
    await execution.stop();
  }
}
if (import.meta.main)
  await main().catch(() => {
    process.stderr.write("BOX_REPRO_LAUNCH_REFUSED\n");
    process.exitCode = 1;
  });
