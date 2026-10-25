// console-assets.ts serves OCC's packages/occ/src/environment-references.ts at
// /console/environment-references.mjs. These declarations repeat the signatures the Console uses.
export declare function wholeEnvironmentReferenceName(text: string): string | undefined;
export declare function environmentReferenceNames(
  text: string,
  options?: { readonly fallbacks?: boolean },
): string[];
export declare function unsubstitutedReference(text: string): string | undefined;
export declare function secretInputShorthandName(text: string): string | undefined;
