import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// A development profile needs no provider credentials or shell startup hooks.
export function developmentEnvironment(input = process.env) {
  const env = { HOME: userInfo().homedir };
  for (const name of [
    "PATH",
    "TMPDIR",
    "DOCKER_HOST",
    "XDG_RUNTIME_DIR",
    "GOCACHE",
    "GOMODCACHE",
    "GOTOOLCHAIN",
    "GOPROXY",
    "GOSUMDB",
    "NODE_BASE_IMAGE",
  ]) {
    if (input[name]) {
      env[name] = input[name];
    }
  }
  return env;
}

export async function developmentCommand(command, args, { cwd, env, timeout = 120_000 } = {}) {
  return execute(command, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
}

// Recovery belongs to occdev. In particular, never remove its uncertain marker
// or its claims when the CLI refuses cleanup after an interrupted operation.
export async function cleanupDevelopmentProfile(resource, repositoryRoot) {
  const state = join(resource.directory, "state");
  try {
    await access(state);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return;
  }
  await developmentCommand(join(resource.directory, "occ"), ["dev", "down"], {
    cwd: repositoryRoot,
    env: {
      ...developmentEnvironment(),
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
      OCC_DEVELOPMENT_STATE_DIRECTORY: state,
    },
    timeout: 180_000,
  });
}

export async function removeDevelopmentProfileDirectory(resource, repositoryRoot) {
  // A killed test may not have entered occdev yet. Absence alone cannot prove
  // that its CLI will not start; normal test cleanup leaves an explicit receipt.
  if (resource.status === "ready") {
    try {
      await access(join(resource.directory, "state"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await access(join(resource.directory, "cleanup-complete"));
    }
  }
  await cleanupDevelopmentProfile(resource, repositoryRoot);
  await rm(resource.directory, { recursive: true, force: true });
}
