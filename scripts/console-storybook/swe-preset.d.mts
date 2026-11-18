// Type binding for the JavaScript module emitted from this JSON by prepare-assets.ts.
declare const preset: typeof import("../../deploy/presets/swe-preset.json", {
  with: { type: "json" },
}).default;
export default preset;
