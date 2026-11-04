// The Installation shape for native repository Git with worker-prepared GitHub
// custody. #2487 retired the top-level drivers.repo and the broker's
// github-app-registry backend; the worker now holds the App key and custody key,
// and the repository service only sends native Git. render-installation-profile
// and the QA matrix both write this shape, so they share it here (`occ dev up`
// writes the same paths from Go: internal/occdev/repository_k3d.go).

export const REPOSITORY_DRIVER_ID = "repository-credentials";
export const REPOSITORY_REGISTRY_PATH = "/etc/openclaw/repository-registry/registry.json";
export const REPOSITORY_CONTROL_SOCKET = "/run/openclaw/repository-control/private/control.sock";
export const REPOSITORY_PUBLIC_CA_PATH = "/etc/openclaw/repository-ca/ca.crt";
// Only the worker mounts this directory: private-key.pem and custody.key.
export const PREPARED_REPOSITORY_DIRECTORY = "/etc/openclaw/prepared-repository";

/** The Installation's `repository` section. */
export function preparedRepositoryInstallation({
  id = REPOSITORY_DRIVER_ID,
  sessionDurationSeconds,
}) {
  return {
    id,
    configuration: { sessionDurationSeconds },
    nativeSender: {
      controlSocket: REPOSITORY_CONTROL_SOCKET,
      publicCaPath: REPOSITORY_PUBLIC_CA_PATH,
    },
    preparedGitHub: {
      custodyKeyPath: `${PREPARED_REPOSITORY_DIRECTORY}/custody.key`,
      privateKeyPath: `${PREPARED_REPOSITORY_DIRECTORY}/private-key.pem`,
    },
  };
}

/** The GitHub Backend whose repository bindings that driver serves. */
export function preparedRepositoryBackend({ backendId, driverId = REPOSITORY_DRIVER_ID }) {
  return {
    id: backendId,
    type: "github",
    configuration: { registryPath: REPOSITORY_REGISTRY_PATH },
    drivers: { repo: driverId },
  };
}
