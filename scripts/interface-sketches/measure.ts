import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

type Face = "Regular" | "Bold" | "Italic";
const fonts = new Map<Face, opentype.Font>();

/** Measure advances in the same bundled face that the renderer selects. */
function width(text: string, size: number, face: Face): number {
  let font = fonts.get(face);
  if (!font) {
    font = opentype.loadSync(
      fileURLToPath(new URL(`./fonts/LiberationSans-${face}.ttf`, import.meta.url)),
    );
    fonts.set(face, font);
  }
  return font.getAdvanceWidth(text, size);
}

export function widestLine(lines: readonly string[], size: number, face: Face): number {
  return lines.reduce((max, line) => Math.max(max, width(line, size, face)), 0);
}

export function wrap(text: string, size: number, face: Face, limit: number): string[] {
  return text.split("\n").flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, face) <= limit) {
        line = next;
        continue;
      }
      if (line) {
        lines.push(line);
      }
      line = word;
      if (width(word, size, face) <= limit) {
        continue;
      }
      line = "";
      for (const char of word) {
        if (line && width(line + char, size, face) > limit) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    return [...lines, line];
  });
}
