import type { Preview } from "@storybook/html-vite";

const sectionOrder: string[] = ["Overview", "Pages", "Components", "Flows"];

export default {
  parameters: {
    layout: "fullscreen",
    options: { storySort: { order: sectionOrder } },
  },
} satisfies Preview;
