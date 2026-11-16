import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));

function credentialInputs(directory, password = "openclaw-development-password") {
  const passwordPath = join(directory, "admin-password-input");
  const keyPath = join(directory, "admin-service-key-input");
  if (!existsSync(passwordPath)) {
    writeFileSync(passwordPath, password, { mode: 0o600, flag: "wx" });
  }
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, `occ_${randomBytes(32).toString("base64url")}`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  return {
    OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE: passwordPath,
    OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE: keyPath,
  };
}

export async function privateBootstrapDirectory(context, prefix = "openclaw-bootstrap-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export function developmentBootstrapEnvironment({
  databaseUrl,
  directory,
  email,
  password,
  authSecret,
  authBaseURL = "https://console.oce.localhost",
  agentDomain = "agents.oce.localhost",
  installationName,
  environment = process.env,
}) {
  return {
    ...environment,
    NODE_ENV: "development",
    OCC_DATABASE_URL: databaseUrl,
    OCC_AUTH_SECRET: authSecret,
    OCC_AUTH_BASE_URL: authBaseURL,
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: agentDomain,
    OPENCLAW_DEV_EMAIL: email,
    OPENCLAW_DEV_INSTALLATION_NAME: installationName,
    ...credentialInputs(directory, password),
  };
}

export function productionBootstrapEnvironment({
  databaseUrl,
  directory,
  email,
  authSecret,
  authBaseURL = "https://console.oce.localhost",
  agentDomain = "agents.oce.localhost",
  installationName,
  environment = process.env,
}) {
  return {
    ...environment,
    NODE_ENV: "production",
    OCC_DATABASE_URL: databaseUrl,
    OCC_AUTH_SECRET: authSecret,
    OCC_AUTH_BASE_URL: authBaseURL,
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: agentDomain,
    OCC_BOOTSTRAP_ADMIN_EMAIL: email,
    ...credentialInputs(directory),
    OCC_BOOTSTRAP_INSTALLATION_NAME: installationName,
  };
}

export async function runBootstrapInstallation(environment, options = {}) {
  try {
    const result = await run(
      process.execPath,
      ["scripts/bootstrap-installation.mjs", ...(options.args ?? [])],
      {
        cwd: repository,
        env: environment,
        timeout: options.timeout ?? 20_000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
      },
    );
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      message: error instanceof Error ? error.message : "bootstrap failed",
    };
  }
}

/** Collects what the in-process command writes to one of its streams. */
export function outputSink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

/**
 * The initialization Job's code (`bootstrapInstallation`, what scripts/bootstrap-installation.mjs
 * runs) in this process, with `environment` instead of process.env. It returns the same shape as
 * runBootstrapInstallation: stdout carries the result line, stderr the diagnostics and log events,
 * in the order the Job writes them to its streams.
 */
export async function bootstrapInstallationInProcess(environment) {
  const { bootstrapInstallation } = await import("../../scripts/bootstrap-installation.mjs");
  const stdout = outputSink();
  const stderr = outputSink();
  const status = await bootstrapInstallation({
    environment,
    args: [],
    stdout,
    stderr,
    logDestination: stderr,
  });
  return status === 0
    ? { ok: true, stdout: stdout.text(), stderr: stderr.text() }
    : {
        ok: false,
        stdout: stdout.text(),
        stderr: stderr.text(),
        message: `bootstrap exited with status ${status}`,
      };
}

/**
 * Bootstraps the development Installation. `inProcess: true` runs the Job's code in this process
 * (bootstrapInstallationInProcess), saving a Node start; otherwise it runs the real script.
 */
export async function ensureDevelopmentBootstrap(context, options) {
  const directory =
    options.directory ??
    (await privateBootstrapDirectory(context, "openclaw-development-bootstrap-"));
  const environment = developmentBootstrapEnvironment({ ...options, directory });
  const result = options.inProcess
    ? await bootstrapInstallationInProcess(environment)
    : await runBootstrapInstallation(environment, options);
  if (!result.ok) {
    throw new Error(`Development bootstrap failed:\n${result.stderr || result.stdout}`);
  }
  return { directory, environment, result };
}
