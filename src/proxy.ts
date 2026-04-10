import { NextResponse, type NextRequest } from "next/server"

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname

  // Allow static, api, and the root login page through
  if (
    path === "/" ||
    path.startsWith("/api") ||
    path.startsWith("/_next")
  ) {
    return NextResponse.next()
  }

  // Everything else requires the admin cookie
  const token = request.cookies.get("dilly-ops-token")?.value
  if (token !== process.env.ADMIN_PASSWORD) {
    return NextResponse.redirect(new URL("/", request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
