import { pathToFileURL } from "node:url";
import { startCredentialService } from "./composition/repository-credentials/service.ts";

export { startCredentialService } from "./composition/repository-credentials/service.ts";
export type { RunningService } from "./composition/repository-credentials/service.ts";
export type { CredentialService } from "./drivers/repo/credentials/service-contracts.ts";

/** Direct process composition; check-config loads no session or listener owner. */
// Usage: --config FILE [--check-config] [--development-authority]; each flag at most once.
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const count = (flag: string) => args.filter((arg) => arg === flag).length;
  const check = count("--check-config") === 1;
  const developmentAuthority = count("--development-authority") === 1;
  const pathIndex = args.indexOf("--config");
  const path = pathIndex < 0 ? undefined : args[pathIndex + 1];
  const permitted = 2 + (check ? 1 : 0) + (developmentAuthority ? 1 : 0);
  if (
    !path ||
    path.startsWith("--") ||
    args.length !== permitted ||
    count("--config") !== 1 ||
    count("--check-config") > 1 ||
    count("--development-authority") > 1
  ) {
    throw new Error("invalid-arguments");
  }
  if (check) {
    const { checkConfiguration } =
      await import("./composition/repository-credentials/check-config.ts");
    process.stdout.write(
      `${JSON.stringify(await checkConfiguration(path, { developmentAuthority }))}\n`,
    );
    return;
  }
  await startCredentialService(path, { developmentAuthority });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("repository credential service failed\n");
    process.exitCode = 1;
  });
}
