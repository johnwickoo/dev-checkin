# Supabase Migrations

Database schema and hardening SQL now live in `supabase/migrations`.

## Apply migrations

If you use Supabase CLI:

```bash
supabase db push
```

If you prefer SQL Editor, run files in `supabase/migrations` in order.

## Edge Functions

This app uses `send-accountability-email` for vote and shame emails.

Set required function secrets:

```bash
supabase secrets set EMAILJS_SERVICE_ID=...
supabase secrets set EMAILJS_TEMPLATE_ID=...
supabase secrets set EMAILJS_SHAME_TEMPLATE=...
supabase secrets set EMAILJS_PUBLIC_KEY=...
supabase secrets set EMAILJS_PRIVATE_KEY=...   # optional, recommended
```

Deploy the function:

```bash
supabase functions deploy send-accountability-email
```
