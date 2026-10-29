import { story } from "./story.ts";

export default { title: "Pages/Theming" };
export const SignIn = story("themeSignIn");
export const Desktop = story("themeNavigation", {
  instructions: "Inspect the custom logo within the shared 48 × 48 px navigation limit.",
});
export const Mobile = story("themeMobile");
export const NarrowMobile = story("themeMobile", {
  name: "Custom narrow mobile navigation",
  frameWidth: "320px",
  instructions: "Open and close navigation; the logo leaves both header controls reachable.",
});
export const LongName = story("themeLongName");
export const Empty = story("themeEmpty");
export const Denied = story("themeDenied");
export const Loading = story("themeLoading");
export const MissingCredentials = story("themeCredentials");
export const PublicError = story("themePublicError");
