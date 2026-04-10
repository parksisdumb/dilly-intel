import { NextResponse } from "next/server"
import { inngest } from "@/inngest/client"

export async function POST(req: Request) {
  const { agent_name } = await req.json()

  try {
    await inngest.send({
      name: `app/${agent_name}.run`,
      data: { triggered_by: "ops_console" },
    })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
