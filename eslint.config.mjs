import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "legacy/**",
    ".build/**",
    "test-results/**",
    "playwright-report/**",
    "output/**",
    "scripts/docs-site/vendor/**",
    ".agents/**",
  ]),
  {
    files: ["{apps,packages,scripts,tests}/**/*.{js,mjs,cjs,ts}", "*.{js,mjs,cjs,ts}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    plugins: { "@stylistic": stylistic },
    rules: {
      curly: ["error", "all"],
      "one-var": ["error", "never"],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
      ],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // A matcher-less assert.rejects/throws passes on any error, a TypeError from a broken
    // fixture included, so a test can report a failure as a pass (finding 1845). Lint can't
    // tell a message variable from a matcher variable, so `assert.rejects(p, label)` still passes.
    files: ["tests/**/*.{js,mjs,cjs,ts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='assert'][callee.property.name=/^(rejects|throws)$/]:matches([arguments.length<2], [arguments.1.type='TemplateLiteral'], [arguments.1.value=type(string)], [arguments.1.type='Identifier'][arguments.1.name='undefined'], [arguments.1.type='UnaryExpression'][arguments.1.operator='void'], [arguments.1.type='BinaryExpression'][arguments.1.operator='+'])",
          message:
            'Name the expected error as the second argument: an error class, a { name, message, code } object (a RegExp value there tests that property), or a validation function; not nothing or only a message. A bare RegExp is tested against String(error), "Name: message".',
        },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: [
      "apps/controller/src/console/**/*.mjs",
      "scripts/docs-site/site.mjs",
      "scripts/console-storybook/story.mjs",
      "scripts/console-storybook/public/*.mjs",
      "scripts/docs-site/compute-matrix-browser.mjs",
    ],
    languageOptions: {
      globals: {
        ...Object.fromEntries(Object.keys(globals.node).map((name) => [name, "off"])),
        ...globals.browser,
      },
    },
  },
);
