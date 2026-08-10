import { z } from "zod";

/**
 * Credential rules, in one place.
 *
 * `MIN_PASSWORD_LENGTH` is the single source of truth: `lib/auth.ts` feeds it to Better Auth's
 * `minPasswordLength`, the sign-up form validates against it, and the UI prints it. Hard-coding
 * "8" in three places is how a policy change ships as a form that accepts a password the server
 * then rejects — `lib/auth.config.test.ts` pins the two together.
 *
 * These schemas are CLIENT-SIDE COURTESY ONLY. Better Auth re-validates everything server-side;
 * nothing here is a security control, and none of it may be relied on as one.
 */

/** Better Auth's own default, adopted deliberately rather than invented (see lib/auth.ts). */
export const MIN_PASSWORD_LENGTH = 8;
/** Better Auth rejects beyond this, so the form should say so rather than let the server do it. */
export const MAX_PASSWORD_LENGTH = 128;

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .pipe(z.email("Enter a valid email address."));

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`);

export const signInSchema = z.object({
  email: emailSchema,
  // Sign-in must NOT apply the length policy: an existing password that predates a policy change
  // is still that user's password, and "use at least 8 characters" on a sign-in form reads as a
  // hint about what is stored. Only emptiness is worth catching before the round trip.
  password: z.string().min(1, "Enter your password."),
});

export const signUpSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Those passwords don't match.",
    path: ["confirmPassword"],
  });

export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;

/** Field name → first message, for rendering beside the input that caused it. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in out)) out[key] = issue.message;
  }
  return out;
}
