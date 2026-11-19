import assert from "node:assert/strict";

export const at = (line: number, column: number) =>
  `Invalid JSON at line ${line}, column ${column}. Enter a valid JSON object.`;

export const codePoint = (character: string) => {
  const point = character.codePointAt(0);
  assert.ok(point !== undefined);
  return `U+${point.toString(16).toUpperCase()}`;
};
