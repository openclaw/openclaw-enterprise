import { story } from "./story.mjs";

export default { title: "Components/Navigation" };

export const Menu = { ...story("menu"), name: "Account menu" };
export const NamespaceMenu = { ...story("namespaceMenu"), name: "Namespace switcher" };
export const NamespaceSelectorMobile = { ...story("namespaceSelectorMobile") };
export const Mobile = { ...story("mobile"), name: "Mobile drawer" };

export const BuildRevision = { ...story("buildRevision") };
export const DevelopmentBuild = { ...story("developmentBuild") };
