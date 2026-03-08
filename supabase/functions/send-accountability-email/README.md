# send-accountability-email

Supabase Edge Function that sends accountability emails via EmailJS API.

## Required Supabase secrets

- `EMAILJS_SERVICE_ID`
- `EMAILJS_TEMPLATE_ID` (vote template)
- `EMAILJS_SHAME_TEMPLATE` (shame template)
- `EMAILJS_PUBLIC_KEY`
- `EMAILJS_PRIVATE_KEY` (optional but recommended)

## Deploy

```bash
supabase functions deploy send-accountability-email
```
