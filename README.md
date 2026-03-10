# Accountabuddy

**The accountability app that won't let you off the hook.**

Accountabuddy turns your goals into commitments by bringing real people into the loop. Miss a day? Your partners vote on whether your excuse holds up. Verdict: guilty? You're doing a punishment task — and you can't mark it done for at least an hour. No cheating. No shortcuts. No mercy.

> *"I'll start tomorrow"* — You, never again.

---

## How It Works

1. **Set your goals** — Define what you're working toward with deadlines and daily check-in requirements
2. **Add accountability partners** — Invite people who'll actually hold you to it (via email)
3. **Check in daily** — Prove you showed up. Your streak is on the line
4. **Miss a day?** — Write an excuse (80+ chars minimum). Your partners get a voting link
5. **The verdict** — Partners vote accept or reject. Majority rules
6. **Punishment** — If rejected, partners suggest and vote on a punishment. You must complete it before moving on
7. **Encouragement** — Partners can send you cheers when you're on a roll

```
 ┌─────────┐    miss    ┌──────────┐   reject   ┌────────────┐
 │ Daily   │ ────────▶  │ Partners │ ─────────▶ │ Punishment │
 │ Check-in│            │ Vote     │            │ Task       │
 └─────────┘            └──────────┘            └────────────┘
      │                      │                       │
   streak++              accept ──▶ forgiven    complete + ack
```

## Features

- **Streak tracking** with fire animations and personal stats
- **Goal management** with deadlines, extensions, and deactivation guards
- **Partner voting system** — democratic accountability via emailed vote links
- **Punishment tasks** — immutable, time-gated, no shortcuts
- **Rest days** — up to 2 per week, server-side enforced
- **Dark & light themes** with smooth transitions
- **Stats dashboard** and **feedback system**
- **Mobile-friendly**

## Tech Stack

React 19 · Vite 7 · Supabase (Postgres, Auth, Edge Functions, RLS) · EmailJS · Vercel

Zero dependencies beyond React and Supabase client. No CSS framework. No state library. Just vibes and discipline.

---

Built with spite, structure, and Supabase.
