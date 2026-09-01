#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_RUNTIME_IMAGE,
  DEFAULT_STATE_DIR,
  createRun,
  createStateSaver,
  readSetupState,
  requireNonEmpty,
  resolveStateDirectory,
  runSetup,
  runTui,
  runInteractive,
  sameConfigIdentity,
  validatePrivateRegularFile,
  withStateLock,
  withoutModelCredential,
} from "./setup/common.mjs";
import {
  createDevelopmentBackend,
  developmentIdentity,
  validateDevelopmentTools,
} from "./setup/development.mjs";

// Keep this entrypoint dependency-free so setup can run before pnpm install.
const HELP = `Usage:
  node scripts/setup.mjs dev --model MODEL [--state-dir DIR] [--runtime-image IMAGE] [--no-tui]
  node scripts/setup.mjs production --config FILE [--state-dir DIR] [--no-tui]
  node scripts/setup.mjs tui [--state-dir DIR] [--session SESSION] [--message MESSAGE]
  node scripts/setup.mjs --help

Setup stores nonsecret IDs in DIR/state.json and the bootstrap service key in a
separate mode 0600 file. DIR defaults to ${DEFAULT_STATE_DIR} and must be mode 0700.

Prerequisite: Node.js 24. The setup CLI can run before pnpm install.
`;

async function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...rest] = argv;
  if (command === "dev") {
    await dev(rest);
    return;
  }
  if (command === "production") {
    await production(rest);
    return;
  }
  if (command === "tui") {
    await tui(rest);
    return;
  }
  throw new Error(`Unknown setup command: ${command}`);
}

async function dev(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      "state-dir": { type: "string", default: DEFAULT_STATE_DIR },
      "runtime-image": { type: "string", default: DEFAULT_RUNTIME_IMAGE },
      "no-tui": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const model = requireNonEmpty(values.model, "--model");
  if (!values["no-tui"]) assertInteractiveTui();
  requireNonEmpty(process.env.OPENAI_API_KEY, "OPENAI_API_KEY");
  const directory = resolveStateDirectory(values["state-dir"]);
  await validateDevelopmentTools(createRun({ secrets: [process.env.OPENAI_API_KEY] }));
  let launch;
  await withStateLock(directory, async () => {
    const state = await readSetupState(directory);
    state.directory = directory;
    const save = createStateSaver(directory, state);
    const config = {
      model,
      runtimeImage: values["runtime-image"],
    };
    sameConfigIdentity(state, "development", developmentIdentity(config));
    await save();
    const run = createRun({ secrets: [process.env.OPENAI_API_KEY].filter(Boolean) });
    const backend = createDevelopmentBackend({
      config,
      directory,
      state,
      save,
      run,
      progress,
    });
    const result = await runSetup({
      backend,
      state,
      save,
      model,
      noTui: values["no-tui"],
      tui: {},
    });
    if (values["no-tui"]) {
      process.stdout.write(`${result.message}\n`);
    } else {
      launch = result.command;
    }
  });
  if (launch !== undefined) {
    await runInteractive(launch.command, launch.args, {
      env: withoutModelCredential(process.env),
    });
  }
}

async function production(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      "state-dir": { type: "string", default: DEFAULT_STATE_DIR },
      "no-tui": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const configPath = requireNonEmpty(values.config, "--config");
  if (!values["no-tui"]) assertInteractiveTui();
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const model = requireNonEmpty(config.model, "production config model");
  const modelKey = await readPrivateModelKey(config);
  const directory = resolveStateDirectory(values["state-dir"]);
  const { createProductionBackend, productionIdentity } = await import("./setup/production.mjs");
  let launch;
  await withStateLock(directory, async () => {
    const state = await readSetupState(directory);
    state.directory = directory;
    const save = createStateSaver(directory, state);
    sameConfigIdentity(state, "production", productionIdentity(config, configPath));
    await save();
    const run = createRun({ secrets: [modelKey] });
    const backend = createProductionBackend({
      config,
      directory,
      state,
      save,
      run,
      progress,
      modelKey,
    });
    const result = await runSetup({
      backend,
      state,
      save,
      model,
      noTui: values["no-tui"],
      tui: {},
    });
    if (values["no-tui"]) {
      process.stdout.write(`${result.message}\n`);
    } else {
      launch = result.command;
    }
  });
  if (launch !== undefined) {
    await runInteractive(launch.command, launch.args, {
      env: withoutModelCredential(process.env),
    });
  }
}

async function tui(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "state-dir": { type: "string", default: DEFAULT_STATE_DIR },
      session: { type: "string" },
      message: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const directory = resolveStateDirectory(values["state-dir"]);
  let launch;
  await withStateLock(directory, async () => {
    assertInteractiveTui();
    const state = await readSetupState(directory);
    state.directory = directory;
    const save = createStateSaver(directory, state);
    let backend;
    if (state.mode === "development") {
      const identity = state.backend?.identity ?? {};
      const run = createRun({ secrets: [process.env.OPENAI_API_KEY].filter(Boolean) });
      backend = createDevelopmentBackend({
        config: {
          model: identity.model,
          runtimeImage: identity.runtimeImage,
        },
        directory,
        state,
        save,
        run,
        progress,
      });
    } else if (state.mode === "production") {
      const { createProductionBackend } = await import("./setup/production.mjs");
      backend = createProductionBackend({
        config: state.backend?.identity ?? {},
        directory,
        state,
        save,
        run: createRun(),
        progress,
      });
    } else {
      throw new Error("TUI reconnect requires an existing development or production state.json.");
    }
    const result = await runTui({
      backend,
      state,
      save,
      tui: { session: values.session, message: values.message },
    });
    launch = result.command;
  });
  if (launch !== undefined) {
    await runInteractive(launch.command, launch.args, {
      env: withoutModelCredential(process.env),
    });
  }
}

async function readPrivateModelKey(config) {
  const keyFile = config.modelKeyFile;
  if (typeof keyFile !== "string" || keyFile.trim().length === 0) {
    throw new Error("production config must include private modelKeyFile.");
  }
  await validatePrivateRegularFile(keyFile, "Production model-key file");
  const value = await readFile(keyFile, "utf8");
  return requireNonEmpty(value.trim(), "production model key");
}

function progress(message) {
  process.stderr.write(`[setup] ${message}\n`);
}

function assertInteractiveTui() {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new Error(
    "TUI requires an interactive terminal; rerun setup with --no-tui, then reconnect with node scripts/setup.mjs tui --state-dir DIR from a TTY.",
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
