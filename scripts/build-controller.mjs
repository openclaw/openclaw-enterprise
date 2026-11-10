import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve the source checkout, even when the caller starts outside the repository.
const repository = fileURLToPath(new URL("../", import.meta.url));
const [engine = "docker", ...args] = process.argv.slice(2);
if (!["docker", "podman"].includes(engine)) {
  throw new Error("Usage: node scripts/build-controller.mjs [docker|podman] [build options]");
}
const revision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) {
  throw new Error("Controller builds require a full lowercase Git commit SHA.");
}
console.error(`Building controller from Git HEAD ${revision}; local edits are included.`);
const result = spawnSync(
  engine,
  [
    "build",
    ...args,
    "--build-arg",
    `OCC_BUILD_REVISION=${revision}`,
    "--label",
    `org.opencontainers.image.revision=${revision}`,
    repository,
  ],
  { cwd: repository, stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
