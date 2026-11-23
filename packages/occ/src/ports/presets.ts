import type { Preset, PresetSummary } from "@openclaw-enterprise/contracts";

export interface PresetReadRepository {
  findPreset(namespaceId: string, presetId: string): Promise<Readonly<Preset> | undefined>;
  listPresets(namespaceId: string): Promise<readonly Readonly<Preset>[]>;
  /** The Namespace's Presets in listPresets order, without their templates. */
  listPresetSummaries(namespaceId: string): Promise<readonly Readonly<PresetSummary>[]>;
}

export interface PresetRepository extends PresetReadRepository {
  createPreset(preset: Preset): Promise<Readonly<Preset>>;
  lockPreset(namespaceId: string, presetId: string): Promise<Readonly<Preset> | undefined>;
  updatePreset(
    namespaceId: string,
    presetId: string,
    changes: Partial<Pick<Preset, "name" | "template">>,
  ): Promise<Readonly<Preset> | undefined>;
  deletePreset(namespaceId: string, presetId: string): Promise<boolean>;
}
