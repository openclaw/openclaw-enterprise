import { readFileSync, type PathLike, type PathOrFileDescriptor } from "node:fs";
import { readFile, type FileHandle } from "node:fs/promises";

type ReadJsonLinesOptions = {
  missingOk?: boolean;
  skipBlank?: boolean;
};

export function parseStrictJsonLines(text: string, skipBlank: boolean): unknown[] {
  const lines = text.trim().split("\n");
  return (skipBlank ? lines.filter(Boolean) : lines).map((line): unknown => JSON.parse(line));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

// Parse each line after trimming the whole file. skipBlank skips empty lines only.
// missingOk treats a missing file as an empty recording.
export async function readJsonLines(
  path: PathLike | FileHandle,
  { missingOk = false, skipBlank = false }: ReadJsonLinesOptions = {},
): Promise<unknown[]> {
  try {
    return parseStrictJsonLines(await readFile(path, "utf8"), skipBlank);
  } catch (error) {
    if (missingOk && isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

export function readJsonLinesSync(
  path: PathOrFileDescriptor,
  { missingOk = false, skipBlank = false }: ReadJsonLinesOptions = {},
): unknown[] {
  try {
    return parseStrictJsonLines(readFileSync(path, "utf8"), skipBlank);
  } catch (error) {
    if (missingOk && isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}
