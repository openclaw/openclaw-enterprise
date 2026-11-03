// console-assets.ts serves deploy/presets/default-codex.json at this browser URL.
declare const preset: {
  template: {
    configuration: {
      values: Record<string, unknown> & {
        plugins: { allow: string[]; entries: { codex: Record<string, unknown> } };
      };
    };
  };
};
export default preset;
