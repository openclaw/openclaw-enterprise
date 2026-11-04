/** GitLab.com is the only supported provider origin; no Installation or caller override. */
export const GITLAB_PROVIDER_ORIGIN = "https://gitlab.com";

export function gitlabProviderOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid-endpoint");
  }
  if (
    value !== GITLAB_PROVIDER_ORIGIN ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("invalid-endpoint");
  }
  return url.origin;
}
