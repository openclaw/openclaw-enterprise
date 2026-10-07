import { story } from "./story.mjs";

export default { title: "Pages/CLI sign-in" };

export const EnterCode = story("cliLogin");
export const WrongCode = story("cliLoginWrongCode");
export const Review = story("cliLoginReview");
export const DifferentAddress = story("cliLoginOtherAddress");
export const Approved = story("cliLoginApproved");
export const Denied = story("cliLoginDenied");
