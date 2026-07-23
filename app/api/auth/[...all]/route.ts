import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

/** Better Auth catch-all handler: sign-in, callback, session, sign-out all route through here. */
export const { GET, POST } = toNextJsHandler(auth.handler);
