import { story } from "./story.ts";

export default { title: "Components/Navigation" };

export const Menu = { ...story("menu"), name: "Account menu" };
export const MenuMobile = { ...story("menuMobile"), name: "Mobile account menu" };
export const NamespaceMenu = { ...story("namespaceMenu"), name: "Namespace switcher" };
export const NamespaceSelectorMobile = { ...story("namespaceSelectorMobile") };
export const Mobile = { ...story("mobile"), name: "Mobile drawer" };

export const BuildRevision = { ...story("buildRevision") };
export const DevelopmentBuild = { ...story("developmentBuild") };
export const ObservabilityLink = {
  ...story("observabilityLink"),
  name: "Admin Observability link",
};
export const ObservabilityDenied = {
  ...story("observabilityDenied"),
  name: "Observability access denied",
};
