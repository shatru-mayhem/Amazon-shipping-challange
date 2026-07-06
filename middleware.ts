import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Feature 1 (webdev.md): session refresh + role-based routing.
// Defensive: never throw — a middleware crash 500s the whole site
// (MIDDLEWARE_INVOCATION_FAILED). Missing env => pass through and log.
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    console.error(
      "[middleware] Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your deployment environment.",
    );
    return NextResponse.next({ request });
  }

  try {
    return await handleAuth(request, url, anonKey);
  } catch (e) {
    console.error("[middleware] auth check failed:", e);
    return NextResponse.next({ request });
  }
}

async function handleAuth(request: NextRequest, url: string, anonKey: string) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected =
    path.startsWith("/client") || path.startsWith("/employee");
  if (!isProtected) return response;

  if (!user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/";
    redirectUrl.searchParams.set("reason", "auth-required");
    return NextResponse.redirect(redirectUrl);
  }

  // Role routing from the users table (RLS: users can read own row).
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "Client";
  const isEmployee = role === "Employee" || role === "Admin";

  if (path.startsWith("/employee") && !isEmployee) {
    return NextResponse.redirect(new URL("/client", request.url));
  }
  if (path.startsWith("/client") && isEmployee) {
    return NextResponse.redirect(new URL("/employee", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/client/:path*", "/employee/:path*", "/client", "/employee"],
};
