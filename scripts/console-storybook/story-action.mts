export type StoryAction = (
  | { text: string; selector?: never; click?: boolean }
  | { selector: string; text?: never; click?: boolean }
  | { click: string; text?: never; selector?: never }
) & {
  focus?: boolean;
  value?: string;
  matches?: string;
  key?: string;
};
