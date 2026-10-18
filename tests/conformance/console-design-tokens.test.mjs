import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(
  new URL("../../apps/controller/src/console/console.css", import.meta.url),
  "utf8",
);
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(block) {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

const rootStart = withoutComments.indexOf(":root {");
const root = declarations(
  withoutComments.slice(rootStart, withoutComments.indexOf("}", rootStart)),
);

// Design-language token families; values reproduce the console's look before the tokens existed.
const tokens = {
  "--color-bg": "#faf9f7",
  "--color-surface": "#ffffff",
  "--color-surface-2": "#f4f1ec",
  "--color-surface-hover": "#efebe4",
  "--color-border": "#e8e4dc",
  "--color-border-strong": "#938b7f",
  "--color-text": "#403c35",
  "--color-text-strong": "#211e1a",
  "--color-text-muted": "#6e6960",
  "--color-accent": "#bd4531",
  "--color-accent-hover": "#a83c29",
  "--color-accent-subtle": "rgba(189, 69, 49, 0.08)",
  "--color-on-accent": "#ffffff",
  "--color-link": "var(--color-text-strong)",
  "--color-success": "#166534",
  "--color-success-subtle": "rgba(22, 101, 52, 0.08)",
  "--color-warning": "#92400e",
  "--color-warning-subtle": "rgba(146, 64, 14, 0.08)",
  "--color-danger": "#b91c1c",
  "--color-danger-subtle": "rgba(185, 28, 28, 0.08)",
  "--color-info": "#1e3a5f",
  "--color-info-subtle": "rgba(30, 58, 95, 0.07)",
  "--color-overlay": "rgba(15, 23, 42, 0.4)",
  "--font-sans": '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "--font-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  "--text-xs": "11px",
  "--text-sm": "12px",
  "--text-md": "13px",
  "--text-base": "14px",
  "--text-lg": "16px",
  "--text-xl": "18px",
  "--text-2xl": "24px",
  "--text-display": "clamp(27px, 3vw, 36px)",
  "--weight-regular": "400",
  "--weight-medium": "500",
  "--weight-semibold": "600",
  "--tracking-tight": "-0.02em",
  "--tracking-caps": "0.08em",
  "--space-1": "4px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-5": "20px",
  "--space-6": "24px",
  "--space-8": "32px",
  "--space-10": "40px",
  "--space-12": "48px",
  "--radius-sm": "6px",
  "--radius-md": "10px",
  "--radius-lg": "14px",
  "--radius-pill": "999px",
  "--shadow-1": "0 8px 24px rgba(60, 42, 24, 0.09)",
  "--shadow-2": "0 16px 48px rgba(60, 42, 24, 0.18)",
  "--duration-fast": "120ms",
  "--duration-base": "200ms",
  "--ease": "cubic-bezier(0.2, 0, 0, 1)",
  "--focus-ring": "3px solid var(--color-accent)",
  "--focus-offset": "2px",
  "--focus-offset-inset": "-3px",
  "--control-h": "40px",
  "--control-h-sm": "32px",
  "--touch-min": "44px",
  "--content-max": "1300px",
  "--form-max": "960px",
  "--prose-max": "640px",
  "--sidebar-w": "258px",
};

// Older names stay as aliases until every rule uses the tokens.
const aliases = {
  "--bg": "--color-bg",
  "--surface": "--color-surface",
  "--surface-muted": "--color-surface-2",
  "--hover": "--color-surface-hover",
  "--text": "--color-text",
  "--text-strong": "--color-text-strong",
  "--muted": "--color-text-muted",
  "--line": "--color-border",
  "--input-border": "--color-border-strong",
  "--accent": "--color-accent",
  "--accent-subtle": "--color-accent-subtle",
  "--primary": "--color-accent",
  "--primary-hover": "--color-accent-hover",
  "--on-primary": "--color-on-accent",
  "--success": "--color-success",
  "--success-subtle": "--color-success-subtle",
  "--danger": "--color-danger",
  "--danger-subtle": "--color-danger-subtle",
  "--warning": "--color-warning",
  "--warning-subtle": "--color-warning-subtle",
  "--overlay": "--color-overlay",
  "--shadow": "--shadow-1",
  "--radius": "--radius-md",
};

test("console :root defines every design token with the current look's value", () => {
  for (const [name, value] of Object.entries(tokens)) {
    assert.equal(root.get(name), value, name);
  }
  for (const size of ["xs", "sm", "md", "base", "lg", "xl", "2xl", "display"]) {
    assert.match(
      root.get(`--text-${size}--line-height`) ?? "",
      /^\d(\.\d+)?$/,
      `--text-${size}--line-height`,
    );
  }
});

test("older console custom properties alias the tokens instead of repeating values", () => {
  for (const [name, token] of Object.entries(aliases)) {
    assert.equal(root.get(name), `var(${token})`, name);
    assert.ok(root.has(token), token);
  }
});

test("every custom property console.css reads is defined", () => {
  const defined = new Set(declarations(withoutComments).keys());
  // Set at runtime on the log pane (agents/logs-view.mjs).
  defined.add("--log-time-width").add("--log-time-ems");
  const read = new Set([...withoutComments.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name));
  assert.deepEqual(
    [...read].filter((name) => !defined.has(name)),
    [],
  );
});

test("reduced motion shortens both motion durations", () => {
  const rule = withoutComments.match(
    /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/,
  );
  assert.ok(rule, "reduced-motion :root rule");
  const motion = declarations(rule[1]);
  assert.equal(motion.get("--duration-fast"), "1ms");
  assert.equal(motion.get("--duration-base"), "1ms");
});
