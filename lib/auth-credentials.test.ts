import { describe, expect, it } from "vitest";
import {
  fieldErrors,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  signInSchema,
  signUpSchema,
} from "./auth-credentials";

/**
 * Client-side credential validation. Courtesy only — Better Auth re-validates everything — so
 * these tests are about the MESSAGES the user reads and about not rejecting valid input.
 */

const VALID_PW = "a".repeat(MIN_PASSWORD_LENGTH);

describe("sign-up", () => {
  it("accepts a valid email and matching passwords", () => {
    const r = signUpSchema.safeParse({
      email: "student@university.edu",
      password: VALID_PW,
      confirmPassword: VALID_PW,
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ["missing @", "student.university.edu"],
    ["no domain", "student@"],
    ["empty", ""],
    ["spaces only", "   "],
  ])("rejects an invalid email (%s)", (_label, email) => {
    const r = signUpSchema.safeParse({ email, password: VALID_PW, confirmPassword: VALID_PW });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).email).toMatch(/email/i);
  });

  it("trims surrounding whitespace rather than rejecting a pasted address", () => {
    const r = signUpSchema.safeParse({
      email: "  student@university.edu  ",
      password: VALID_PW,
      confirmPassword: VALID_PW,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("student@university.edu");
  });

  it("rejects a password below the policy, quoting the real minimum", () => {
    const r = signUpSchema.safeParse({
      email: "a@b.co",
      password: "a".repeat(MIN_PASSWORD_LENGTH - 1),
      confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(fieldErrors(r.error).password).toBe(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
  });

  it("rejects a password beyond what Better Auth will accept", () => {
    const long = "a".repeat(MAX_PASSWORD_LENGTH + 1);
    const r = signUpSchema.safeParse({ email: "a@b.co", password: long, confirmPassword: long });
    expect(r.success).toBe(false);
  });

  it("reports mismatched passwords against the confirm field", () => {
    const r = signUpSchema.safeParse({
      email: "a@b.co",
      password: VALID_PW,
      confirmPassword: `${VALID_PW}x`,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const errs = fieldErrors(r.error);
      expect(errs.confirmPassword).toMatch(/don't match/i);
      expect(errs.password).toBeUndefined();
    }
  });
});

describe("sign-in", () => {
  it("accepts any non-empty password", () => {
    // An account made before a policy change still has its old password.
    const r = signInSchema.safeParse({ email: "a@b.co", password: "short" });
    expect(r.success).toBe(true);
  });

  it("does not apply the length policy, which would hint at what is stored", () => {
    const r = signInSchema.safeParse({ email: "a@b.co", password: "x" });
    expect(r.success).toBe(true);
  });

  it("still requires a password to be typed", () => {
    const r = signInSchema.safeParse({ email: "a@b.co", password: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).password).toMatch(/enter your password/i);
  });
});

describe("fieldErrors", () => {
  it("keeps the first message per field so one input shows one message", () => {
    const r = signUpSchema.safeParse({ email: "nope", password: "x", confirmPassword: "y" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const errs = fieldErrors(r.error);
      expect(Object.values(errs).every((v) => typeof v === "string")).toBe(true);
      expect(errs.email).toBeDefined();
      expect(errs.password).toBeDefined();
    }
  });
});
