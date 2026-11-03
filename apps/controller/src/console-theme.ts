export interface ConsoleThemeAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

/** Public presentation data, captured once by API startup. */
export interface ConsoleTheme {
  readonly displayName: string;
  readonly logoUrl: string;
  readonly faviconUrl?: string;
  readonly appleTouchIconUrl?: string;
  readonly assets: ReadonlyMap<string, ConsoleThemeAsset>;
}

export const consoleThemeColorRoles = {
  bg: "bg",
  surface: "surface",
  surface2: "surface-2",
  surfaceHover: "surface-hover",
  border: "border",
  borderStrong: "border-strong",
  text: "text",
  textStrong: "text-strong",
  textMuted: "text-muted",
  accent: "accent",
  accentHover: "accent-hover",
  accentSubtle: "accent-subtle",
  onAccent: "on-accent",
  link: "link",
  success: "success",
  successSubtle: "success-subtle",
  warning: "warning",
  warningSubtle: "warning-subtle",
  danger: "danger",
  dangerSubtle: "danger-subtle",
  info: "info",
  infoSubtle: "info-subtle",
  overlay: "overlay",
  focus: "focus",
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

/** Used by HTTP serving and Storybook preparation; operator content never becomes markup. */
export function renderConsoleThemeShell(shell: string, theme: ConsoleTheme): string {
  const name = escapeHtml(theme.displayName);
  let html = shell.replaceAll("OpenClaw Enterprise", () => name);
  if (theme.faviconUrl !== undefined) {
    html = html.replace(/\s*<link rel="icon"[^>]*\/>/g, "");
  }
  if (theme.appleTouchIconUrl !== undefined) {
    html = html.replace(/\s*<link rel="apple-touch-icon"[^>]*\/>/g, "");
  }
  const metadata = [
    `<meta name="occ-console-display-name" content="${name}" />`,
    `<meta name="occ-console-logo" content="${escapeHtml(theme.logoUrl)}" />`,
    '<link rel="stylesheet" href="/console/theme/colors.css" />',
    ...(theme.faviconUrl === undefined
      ? []
      : [`<link rel="icon" href="${escapeHtml(theme.faviconUrl)}" />`]),
    ...(theme.appleTouchIconUrl === undefined
      ? []
      : [`<link rel="apple-touch-icon" href="${escapeHtml(theme.appleTouchIconUrl)}" />`]),
  ];
  return html.replace("</head>", () => `${metadata.join("\n")}\n</head>`);
}
