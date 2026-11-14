import { startPreparedGitIssuer } from "./composition/repository-credentials/issuer.ts";

try {
  const [, , path, ...extra] = process.argv;
  const databaseUrl = process.env.OCC_DATABASE_URL;
  if (process.env.NODE_ENV !== "production" || !path || extra.length || !databaseUrl) {
    throw new Error("PREPARED_GIT_ISSUER_CONFIGURATION_INVALID");
  }
  const issuer = await startPreparedGitIssuer(path, databaseUrl);
  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await issuer.close();
    } catch {
      process.stderr.write('{"code":"PREPARED_GIT_ISSUER_SHUTDOWN_FAILED"}\n');
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdout.write('{"event":"prepared-git-issuer.ready"}\n');
} catch {
  process.stderr.write('{"code":"PREPARED_GIT_ISSUER_STARTUP_FAILED"}\n');
  process.exitCode = 1;
}
