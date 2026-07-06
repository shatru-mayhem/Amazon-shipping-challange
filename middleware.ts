import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Feature 1 (webdev.md): session refresh + role-based routing.
// Clients may only reach /client; Employees/Admins only /employee.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = path.startsWith("/client") || path.startsWith("/employee");

  if (!isProtected) return response;

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("reason", "auth-required");
    return NextResponse.redirect(url);
  }

  // Role routing from the users table (RLS: users can read own row).
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "Client";
  const wantsEmployee = path.startsWith("/employee");
  const isEmployee = role === "Employee" || role === "Admin";

  if (wantsEmployee && !isEmployee) {
    return NextResponse.redirect(new URL("/client", request.url));
  }
  if (!wantsEmployee && isEmployee && path.startsWith("/client")) {
    // Employees may view client portal read-only? Spec says route by role.
    return NextResponse.redirect(new URL("/employee", request.url));
  }
  return response;
}

export const config = {
  matcher: ["/client/:path*", "/employee/:path*", "/client", "/employee"],
};
