const SEC_USER_AGENT = 'DillyIntel/1.0 team@dillyos.com'
const RATE_LIMIT_MS = 250

export async function secFetch(url: string): Promise<Response> {
  await new Promise(r => setTimeout(r, RATE_LIMIT_MS))
  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT },
  })
  return res
}
