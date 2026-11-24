import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function configurePodmanComposeProvider(
  containerEngine: "docker" | "podman",
  environment: NodeJS.ProcessEnv,
): void {
  if (containerEngine !== "podman" || environment.PODMAN_COMPOSE_PROVIDER) {
    return;
  }

  // docker-compose supports --project-directory and uses the recorded Podman DOCKER_HOST.
  const hasDockerCompose = (environment.PATH ?? "").split(delimiter).some((directory) => {
    if (!directory) {
      return false;
    }
    try {
      const provider = join(directory, "docker-compose");
      accessSync(provider, constants.X_OK);
      return statSync(provider).isFile();
    } catch {
      return false;
    }
  });
  environment.PODMAN_COMPOSE_PROVIDER = hasDockerCompose ? "docker-compose" : "podman-compose";
}
