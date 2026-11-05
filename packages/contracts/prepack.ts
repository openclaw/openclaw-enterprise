// pnpm applies publishConfig to the archive; npm retains the source entry.
if (process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  const { buildPackOutput } = await import("../../scripts/pack-private-package.ts");
  buildPackOutput(import.meta.dirname, "tsconfig.pack.json");
}
