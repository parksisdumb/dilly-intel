import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Dilly Intel Ops",
  description: "Agent control & property database operations",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  )
}
