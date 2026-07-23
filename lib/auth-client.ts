"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client. baseURL defaults to the current origin, which is correct for both local
 * and deployed environments. Exposes the Google sign-in and sign-out flows used by the UI.
 */
export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;
