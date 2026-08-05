/**
 * The one and only seam: outbound HTTP to the AI providers.
 *
 * The pool runs the Worker in this isolate, so replacing `globalThis.fetch`
 * intercepts the adapters' real fetch calls. Provider hosts are answered from
 * recorded fixtures; any other host is a mistake and throws rather than
 * reaching the network.
 */
import { afterEach, vi } from 'vitest'

export const PROVIDER_HOSTS = ['api.perplexity.ai', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.cloro.dev']

export interface FakeReply {
  status?: number
  body: unknown
}

/** Decides what a provider returns for one call. Returning a raw object means 200. */
export type ProviderHandler = (request: { url: string; host: string; body: unknown }) => FakeReply | unknown

interface CallLog {
  host: string
  url: string
  body: unknown
}

export interface FakeProviders {
  calls: CallLog[]
  /** Calls made to one host, in order. */
  callsTo(host: string): CallLog[]
}

const originalFetch = globalThis.fetch

export function fakeProviders(handler: ProviderHandler): FakeProviders {
  const calls: CallLog[] = []

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init)
    const host = new URL(request.url).hostname

    if (!PROVIDER_HOSTS.includes(host)) {
      // Anything the Worker itself serves still goes through untouched.
      return originalFetch(request)
    }

    const raw = await request.text()
    const body = raw === '' ? undefined : safeJson(raw)
    calls.push({ host, url: request.url, body })

    const reply = handler({ url: request.url, host, body })
    const { status, payload } = isFakeReply(reply) ? { status: reply.status ?? 200, payload: reply.body } : { status: 200, payload: reply }

    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })

  return {
    calls,
    callsTo: (host: string) => calls.filter((call) => call.host === host),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const isFakeReply = (value: unknown): value is FakeReply =>
  typeof value === 'object' && value !== null && 'body' in value && Object.keys(value).every((key) => key === 'body' || key === 'status')

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** The user Prompt text a provider request carries, for routing fixtures by Prompt. */
export function promptTextOf(body: unknown): string {
  const payload = body as {
    messages?: { role?: string; content?: string }[]
    input?: string
    prompt?: string
    contents?: { parts?: { text?: string }[] }[]
  }
  if (payload?.messages?.length) return payload.messages.at(-1)?.content ?? ''
  if (typeof payload?.input === 'string') return payload.input
  if (typeof payload?.prompt === 'string') return payload.prompt
  return payload?.contents?.[0]?.parts?.[0]?.text ?? ''
}
