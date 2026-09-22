import { story } from "./story.mjs";

export default { title: "Pages/Sign in" };

export const Login = { ...story("login"), name: "Signed out" };
export const LoginError = { ...story("loginError"), name: "Invalid credentials" };
export const Expired = { ...story("expired"), name: "Session expired" };
export const SessionUnavailable = { ...story("sessionUnavailable"), name: "Session unavailable" };
export const Loading = { ...story("loading"), name: "Checking session" };
export const LogoutFailure = { ...story("logoutFailure"), name: "Logout unconfirmed" };
