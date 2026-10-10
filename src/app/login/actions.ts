"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";

export async function login(_: string | null, formData: FormData) {
  try {
    await signIn("credentials", formData, { redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) return "Invalid email or password.";
    throw error;
  }
  return null;
}
