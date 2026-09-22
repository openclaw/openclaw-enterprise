export default {
  framework: "@storybook/html-vite",
  stories: ["../*.stories.mjs"],
  staticDirs: [
    { from: "../dist/assets", to: "/" },
    { from: "../public", to: "/storybook-fixtures" },
  ],
  core: { disableTelemetry: true },
};
