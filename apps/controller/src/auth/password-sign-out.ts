import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

export const passwordSignOut = {
  id: "controller-password-sign-out",
  endpoints: {
    signOut: createAuthEndpoint(
      "/sign-out",
      { method: "POST", requireHeaders: true },
      async (ctx) => {
        const token = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        if (token) {
          try {
            // The primary adapter must acknowledge deletion before the cookie is cleared.
            // Better Auth's internal session deletion can suppress storage failures.
            await ctx.context.adapter.delete({
              model: "session",
              where: [{ field: "token", value: token }],
            });
          } catch {
            throw APIError.fromStatus("SERVICE_UNAVAILABLE", {
              message: "Authentication storage is unavailable.",
            });
          }
        }
        deleteSessionCookie(ctx);
        return ctx.json({ success: true });
      },
    ),
  },
} satisfies BetterAuthPlugin;
