import { pathToFileURL } from "node:url";
import type { SafeConfigurationSummary } from "../../drivers/repo/credentials/service-contracts.ts";
import { loadConfiguration } from "./config.ts";
import { createSystemClock } from "../../drivers/repo/credentials/clock.ts";

export async function checkConfiguration(
  path: string,
  options: Readonly<{ developmentAuthority?: boolean }> = {},
): Promise<SafeConfigurationSummary> {
  const loaded = await loadConfiguration(path, createSystemClock(), {
    developmentAuthority: options.developmentAuthority === true,
  });
  try {
    return Object.freeze({
      valid: true,
      gatewayOrigin: loaded.config.gateway.publicOrigin,
      profiles: loaded.config.sessionPolicy.allowedProfiles,
      maximumDurationSeconds: loaded.config.sessionPolicy.maximumDurationSeconds,
      authority: loaded.authority,
      ...(loaded.tokenClass === undefined ? {} : { tokenClass: loaded.tokenClass }),
    });
  } finally {
    loaded.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const development = args[2] === "--development-authority";
  if (args.length !== (development ? 3 : 2) || args[0] !== "--check-config") {
    process.stderr.write("usage: check-config --check-config FILE [--development-authority]\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(
        `${JSON.stringify(await checkConfiguration(args[1]!, { developmentAuthority: development }))}\n`,
      );
    } catch {
      process.stderr.write("invalid-configuration\n");
      process.exitCode = 1;
    }
  }
}
