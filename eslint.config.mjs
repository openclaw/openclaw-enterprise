import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const assertCallee = [
  "[callee.object.name='assert']",
  "[callee.object.type='MemberExpression'][callee.object.property.name='assert']",
  "[callee.object.object.name='assert'][callee.object.property.name='strict']",
];
const assertMethod = [
  "[callee.property.name=/^(rejects|throws)$/]",
  "[callee.computed=true][callee.property.value=/^(rejects|throws)$/]",
];
// RegExps that match String(error) for every error: tested against "Name: message".
const catchAllPatterns = [
  ".",
  ".*",
  ".+",
  ".*?",
  ".+?",
  "[\\s\\S]",
  "[\\s\\S]*",
  "[\\s\\S]+",
  "^",
  "$",
];
const weakMatcher = [
  "[arguments.length<2]",
  "[arguments.1.type='TemplateLiteral']",
  "[arguments.1.value=type(string)]",
  "[arguments.1.type='Identifier'][arguments.1.name='undefined']",
  "[arguments.1.type='UnaryExpression'][arguments.1.operator='void']",
  "[arguments.1.type='BinaryExpression'][arguments.1.operator='+']",
  "[arguments.1.type='Literal'][arguments.1.raw='null']",
  "[arguments.1.type='Identifier'][arguments.1.name='Error']",
  "[arguments.1.type='ArrowFunctionExpression'][arguments.1.body.raw='true']",
  ...catchAllPatterns.map((pattern) => `[arguments.1.regex.pattern=${JSON.stringify(pattern)}]`),
];
const weakAssertSelector = `CallExpression:matches(${assertCallee.join(", ")}):matches(${assertMethod.join(", ")}):matches(${weakMatcher.join(", ")})`;
// weakAssertSelector matches the callee by name, so keep node:assert bound to `assert` in tests.
const assertModule = String.raw`/^(node:)?assert(\/strict)?$/`;
const assertRebindSelector = [
  `ImportDeclaration[source.value=${assertModule}] > :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier, ImportSpecifier):not([local.name='assert'])`,
  `VariableDeclarator[init.callee.name='require'][init.arguments.0.value=${assertModule}]:not([id.name='assert'])`,
  "VariableDeclarator[init.type='Identifier'][init.name='assert']",
  "VariableDeclarator[init.type='MemberExpression'][init.object.name='assert'][init.property.name=/^(strict|rejects|throws)$/]",
].join(", ");
const weakAssertMessage =
  'Name the expected error as the second argument: an error class narrower than Error, a { name, message, code } object (a RegExp value there tests that property), or a validation function that checks the error; not nothing, only a message, null, Error, () => true or a catch-all RegExp. A bare RegExp is tested against String(error), "Name: message".';

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
    // fixture included, so a test can report a failure as a pass (findings 1845, 1891, 1892).
    // The callee is `assert.X`, `t.assert.X`, `assert.strict.X` or `assert["X"]`; the second
    // argument is missing, only a message, `undefined`, `null`, a bare `Error`, `() => true` or a
    // catch-all RegExp (every one of these accepts an unrelated TypeError). Lint doesn't follow
    // bindings, so a second selector keeps node:assert bound to `assert` (no alias, no destructured
    // rejects/throws). Limits: lint can't tell a message variable from a matcher variable, so
    // `assert.rejects(p, label)` passes, and `assert` handed to a helper or taken from `t` under
    // another name (`const { assert: a } = t`) escapes the rule.
    files: ["tests/**/*.{js,mjs,cjs,ts}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: weakAssertSelector, message: weakAssertMessage },
        {
          selector: assertRebindSelector,
          message:
            "Bind node:assert as `assert` and call assert.rejects/assert.throws directly; an alias or destructured rejects/throws hides the call from the matcher rule.",
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
