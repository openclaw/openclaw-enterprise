import { story } from "./story.mjs";

export default { title: "Pages/Settings" };

export const Settings = { ...story("settings"), name: "Account" };

export const CliSessions = story("settingsCliSessions");
