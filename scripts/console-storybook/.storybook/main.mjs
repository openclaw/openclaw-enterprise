import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default {
  framework: "@storybook/html-vite",
  stories: ["../*.stories.ts"],
  staticDirs: [{ from: "../dist/assets", to: "/" }],
  async viteFinal(config) {
    return {
      ...config,
      // Vite's root public URLs use the same prepared fixtures as /storybook-fixtures.
      publicDir: fileURLToPath(new URL("../dist/assets/storybook-fixtures/", import.meta.url)),
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
