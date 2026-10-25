// console-assets.ts serves OCC's packages/occ/src/environment-references.ts at
// /console/environment-references.mjs. These declarations repeat the signature the Console uses.
export declare function environmentReferenceNames(
  text: string,
  options?: { fallbacks?: boolean },
): string[];
export declare function secretInputShorthandName(text: string): string | undefined;
export declare function wholeEnvironmentReferenceName(text: string): string | undefined;
