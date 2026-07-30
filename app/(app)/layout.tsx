import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/top-bar";
import { auth } from "@/lib/auth";

/**
 * Protected route group. The session check runs on the server, so unauthenticated users are
 * redirected before any protected content is sent to the browser.
 *
 * `.edgify-workspace` scopes the light workspace theme (app/globals.css) and hosts the shared
 * TopBar chrome, so every authenticated page inherits the ported design.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }
  return (
    <div className="edgify-workspace">
      <TopBar />
      {children}
    </div>
  );
}
