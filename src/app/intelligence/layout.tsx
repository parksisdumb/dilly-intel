import type { Metadata } from "next"
import { Inter, DM_Mono } from "next/font/google"
import "./intelligence.css"

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-intel-inter",
})

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  display: "swap",
  variable: "--font-intel-dm-mono",
})

export const metadata: Metadata = {
  title: "Property Intelligence — Dilly Intel",
  description: "Commercial property intelligence for contractors",
}

export default function IntelligenceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className={`${inter.variable} ${dmMono.variable} intel-root min-h-screen`}>
      {children}
    </div>
  )
}
