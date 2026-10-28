export function githubProviderOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("invalid-endpoint");
  }
  return url.origin;
}
