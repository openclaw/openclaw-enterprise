import { isAbsolute, relative, resolve } from "node:path";

export function assertInsideDirectory(parent: string, child: string, description: string) {
  const relativePath = relative(parent, resolve(child));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${description} must stay inside ${parent}.`);
  }
}
