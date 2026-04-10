import { NextResponse } from "next/server"

export async function POST(req: Request) {
  const { password } = await req.json()

  if (password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: "wrong" }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set("dilly-ops-token", password, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  })
  return res
}
