import { readFileSync } from "node:fs";

export default {
  framework: "@storybook/html-vite",
  stories: ["../*.stories.mjs"],
  staticDirs: [{ from: "../dist/assets", to: "/" }],
  async viteFinal(config) {
    return {
      ...config,
      define: {
        ...config.define,
        __CONSOLE_STORY_BUILD__: readFileSync(
          new URL("../dist/asset-version.json", import.meta.url),
          "utf8",
        ),
      },
    };
  },
  core: { disableTelemetry: true },
};
