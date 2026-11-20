import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const selectedImageMigrationProgram = readFileSync(
  new URL(
    "../../deploy/helm/openclaw-enterprise/files/migrate-selected-image.cjs",
    import.meta.url,
  ),
  "utf8",
);

export const selectedImageMigrationEntry = ["-e", selectedImageMigrationProgram, "--"];

// Retained initialization Jobs can name a direct executable. Route their checks
// through the selected-image loader so it verifies guarded mode support.
export function migrationEntry(args: readonly string[]): string[] | undefined {
  const option = args.at(-1);
  const entry =
    option === "--expect-empty" || option === "--require-current" ? args.slice(0, -1) : [...args];
  return isDeepStrictEqual(entry, selectedImageMigrationEntry) ||
    isDeepStrictEqual(entry, ["scripts/migrate-production.ts"]) ||
    isDeepStrictEqual(entry, ["scripts/migrate-production.mjs"])
    ? selectedImageMigrationEntry
    : undefined;
}
