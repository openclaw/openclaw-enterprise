export const oidcDisplayNamePattern = /^[^\p{C}\p{Zl}\p{Zp}]{1,40}$/u;

// Match a literal label using Unicode simple case folding, as Helm does.
export function oidcDisplayNameMatcher(displayName: string): RegExp {
  const literal = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literal}$`, "iu");
}
