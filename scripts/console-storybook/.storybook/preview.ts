import type { Preview } from "@storybook/html-vite";

type ConsolePreview = Preview & {
  parameters: { options: { storySort: { order: string[] } } };
};

export default {
  parameters: {
    layout: "fullscreen",
    options: { storySort: { order: ["Overview", "Pages", "Components", "Flows"] } },
  },
} satisfies ConsolePreview;
