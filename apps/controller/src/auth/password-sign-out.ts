import { APIError, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

export function createPasswordSignOut(revokeSession?: (token: string) => Promise<void>) {
  return {
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
          if (token && revokeSession !== undefined) {
            await revokeSession(token);
          } else if (token) {
            try {
              // Require the adapter to acknowledge deletion before clearing the cookie.
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
}
