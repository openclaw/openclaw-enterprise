import type { ImportedPluginSkill } from "@openclaw-enterprise/contracts";
import { ConfigurationHarnessError } from "@openclaw-enterprise/occ";

/** OpenClaw sends the selected skills and their supporting files together on each worker turn. */
export function validateImportedSkillSize(skills: readonly ImportedPluginSkill[]): void {
  let bytes = 0;
  for (const skill of skills) {
    for (const file of skill.files) {
      bytes += Buffer.byteLength(file.contentBase64, "base64");
      if (bytes > 8 * 1024 * 1024) {
        throw new ConfigurationHarnessError(
          "Selected imported skills exceed OpenClaw's combined 8 MiB turn resource limit.",
        );
      }
    }
  }
}
