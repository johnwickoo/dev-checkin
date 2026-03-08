import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type EmailMode = 'vote' | 'shame'
type EmailPayload = {
  to_email: string
  [key: string]: string | number | boolean | null | undefined
}

type RequestBody = {
  mode: EmailMode
  messages: EmailPayload[]
}

const EMAILJS_API_URL = 'https://api.emailjs.com/api/v1.0/email/send'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing required secret: ${name}`)
  return value
}

async function sendViaEmailJs(
  serviceId: string,
  templateId: string,
  publicKey: string,
  privateKey: string | undefined,
  params: EmailPayload,
): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = {
    service_id: serviceId,
    template_id: templateId,
    user_id: publicKey,
    template_params: params,
  }

  if (privateKey) body.accessToken = privateKey

  const res = await fetch(EMAILJS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.ok) return { ok: true }
  const text = await res.text()
  if (res.status === 403 && /non-browser environments is currently disabled/i.test(text)) {
    return {
      ok: false,
      error: 'EmailJS server-side API is blocked. In EmailJS Dashboard -> Account -> Security, enable API access from non-browser environments.',
    }
  }
  return { ok: false, error: `EmailJS ${res.status}: ${text || 'unknown error'}` }
}

serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ success: false, error: 'Missing bearer token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = getRequiredEnv('SUPABASE_URL')
    const supabaseAnonKey = getRequiredEnv('SUPABASE_ANON_KEY')
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: authData, error: authError } = await authClient.auth.getUser()
    if (authError || !authData.user) {
      return new Response(JSON.stringify({
        success: false,
        error: authError?.message || 'Invalid JWT',
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { mode, messages } = (await req.json()) as RequestBody
    if (mode !== 'vote' && mode !== 'shame') {
      return new Response(JSON.stringify({ success: false, error: 'Invalid mode' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'messages must be a non-empty array' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const serviceId = getRequiredEnv('EMAILJS_SERVICE_ID')
    const voteTemplate = getRequiredEnv('EMAILJS_TEMPLATE_ID')
    const shameTemplate = getRequiredEnv('EMAILJS_SHAME_TEMPLATE')
    const publicKey = getRequiredEnv('EMAILJS_PUBLIC_KEY')
    const privateKey = Deno.env.get('EMAILJS_PRIVATE_KEY')

    const templateId = mode === 'vote' ? voteTemplate : shameTemplate

    let sent = 0
    const failures: Array<{ to_email: string; error: string }> = []

    for (const msg of messages) {
      const to_email = String(msg?.to_email || '').trim()
      if (!to_email) {
        failures.push({ to_email: '', error: 'Missing to_email' })
        continue
      }
      const result = await sendViaEmailJs(serviceId, templateId, publicKey, privateKey, msg)
      if (result.ok) {
        sent += 1
      } else {
        failures.push({ to_email, error: result.error || 'Unknown send error' })
        if (result.error?.startsWith('EmailJS server-side API is blocked.')) {
          break
        }
      }
    }

    return new Response(JSON.stringify({
      success: failures.length === 0,
      sent,
      failed: failures.length,
      failures,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unexpected error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
