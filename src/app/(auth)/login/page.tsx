import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthHeader, AuthSwitch } from "@/components/auth/auth-header";
import { LoginForm } from "@/components/auth/login-form";
import { getCurrentUser } from "@/server/auth/session";
import { safeRedirectPath } from "@/server/services/auth";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = safeRedirectPath((await searchParams).next);
  const user = await getCurrentUser();
  if (user) redirect(user.status === "ACTIVE" ? (next ?? "/today") : "/pending");

  return (
    <>
      <AuthHeader
        title="Sign in"
        description={
          next?.startsWith("/attendance/scan/")
            ? "Sign in to check in. You'll come right back."
            : "Welcome back! Sign in to see today's checklist."
        }
      />
      <LoginForm next={next} />
      <AuthSwitch prompt="New to the team?" href={next ? `/register?next=${encodeURIComponent(next)}` : "/register"}>
        Create an account
      </AuthSwitch>
    </>
  );
}
