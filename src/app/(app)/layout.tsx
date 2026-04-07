import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"

const NAV_ITEMS = [
  { name: "Dashboard", href: "/dashboard" },
  { name: "Properties", href: "/dashboard" },
  { name: "Portfolio Owners", href: "/dashboard" },
  { name: "Contacts", href: "/dashboard" },
  { name: "Settings", href: "/dashboard" },
]

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  return (
    <div className="flex h-full">
      <aside className="w-56 flex-shrink-0 bg-[#111111] flex flex-col">
        <div className="px-5 py-5">
          <h2 className="text-lg font-bold text-white tracking-tight">
            Dilly Intel
          </h2>
        </div>
        <nav className="flex-1 px-3 space-y-0.5 mt-2">
          {NAV_ITEMS.map((item, i) => (
            <Link
              key={item.name}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                i === 0
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white"
              }`}
            >
              {item.name}
            </Link>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-zinc-800">
          <p className="text-xs text-zinc-500 truncate">{user.email}</p>
        </div>
      </aside>

      <main className="flex-1 bg-gray-50 overflow-auto">{children}</main>
    </div>
  )
}
