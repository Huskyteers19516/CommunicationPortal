# Huskyteers Portal — FTC 19516

The team communication app for **FTC 19516 The Huskyteers**. Leaders assign tasks, members get a daily checklist, a leader has to approve a checked item before it officially counts, members ask leaders questions, and everyone gets email updates they can switch off.

## What each person can do

| Who | Can do |
|---|---|
| **Member** (Software / Build / Business) | See **Today's checklist** (overdue, due today, coming up) · check items off → *waiting for review* → *approved* (or *needs changes* with the leader's note) · the **Task dashboard** (every subteam's tasks, sorted by category, and who's on each one) · **sign up** for tasks that are open for sign-up · **ask questions** to their subteam leaders, the captain, or a specific person · **share resources** (links or files up to 4 MB, e.g. code) — they appear once someone with admin access approves them · email preferences |
| **Everyone** | The **Parts queue**: add a part that needs to be 3D printed, laser cut, CNC'd, cut, or machined; tap **I'll make it** to claim one and **Mark done** when it's finished (Build leaders set the priority order). |
| **Business subteam + staff** | **Sponsorships**: every sponsor ask with its stage (Haven't started → Do soon → Needs work → Submitted → Accepted/Declined → Finished), what we're asking for, money received, who's handling it, and submitted/accepted/closing dates · import rows pasted from the old spreadsheet · a shared "Info for applications" note (never put passwords there). |
| **Subteam leader** (Software, Build ×3, Business) | Everything a member can do, plus for **their subteam**: task **categories** (e.g. Build → Intake, Drivetrain, CAD — add one with **+**) · create/edit tasks and either **assign people** or **let people sign up** (optionally with a number of spots) · **review queue** (approve / send back with a note / bulk approve) · **team progress** · answer questions · plus **admin access** (below) |
| **Captain, Mentor, Teacher** | Same as leaders, for **every subteam**, plus whole-team tasks, plus **admin access** |
| **Admin access** (every leader, the captain, mentors, and teachers) | **Approve or reject** sign-ups (seat limits: 1 captain, 1 software, 3 build, 1 business leader) · **approve members' resources** · manage people (change position, disable, email a password reset, sign out devices). Guardrails: leaders manage members and approve sign-ups up to leader level; the captain, mentors, and teachers also manage leaders. Nobody but an owner can change an owner's account, someone else's email, or see the email log. |
| **Owner** (you, the site owner) | Everything, for everyone: all accounts (including making someone else an owner), the **email log** + test email/Discord message. |

Members' accounts work right after sign-up. Leader, captain, mentor, and teacher accounts wait on a "waiting for approval" page until someone with admin access approves them.

**Emails** (each person can turn them off in *Settings*):
- To leaders: a member asks them a question · a member checks off a task they assigned
- To members: someone answers their question · their item is approved or sent back · *(off by default)* they're assigned a new task
- To people with admin access: someone signs up and needs approval · a member shares a resource (owners + that member's subteam leaders)
- Always sent: password reset links, "your password was changed", "you're approved"

## Put it online (about 20 minutes, free tiers)

The app needs a server and a database, so **GitHub Pages can't run it** (it only shows this README). Use Vercel (hosting) with its built-in Neon Postgres database. Your code is already on GitHub.

1. **Vercel project.** Sign in at [vercel.com](https://vercel.com) with GitHub → *Add New → Project* → import `CommunicationPortal`. Vercel automatically runs the `vercel-build` script (database migrations, then the build). The first deploy may fail because there is no database yet. That's expected.
2. **Database.** In the project → **Storage** → *Create Database* → **Neon** (Serverless Postgres) → region **Washington, D.C. (us-east-1)**, the same region as Vercel's servers → connect it to the project for all environments. This sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for you, so there's nothing to copy.
3. **Settings.** In the project → *Settings → Environment Variables*, add:

   | Variable | Value |
   |---|---|
   | `ADMIN_EMAILS` | **your** email. The first person to sign up with it (while there is no admin yet) becomes the admin |
   | `TEAM_JOIN_CODE` | a code you'll tell the team (e.g. `go-huskies`) so strangers can't sign up. Set this |
   | `TEAM_TIMEZONE` | `America/Los_Angeles` |
   | `APP_URL` | optional: your site URL, e.g. `https://communication-portal.vercel.app`. Email links use Vercel's production URL if you leave it out |

4. **Email (Gmail).** Turn on 2-Step Verification for the Gmail account, then create an **App Password** (Google Account → Security → App passwords). Add `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<the gmail address>`, `SMTP_PASS=<the 16-character app password>`, `EMAIL_FROM="Huskyteers Portal <the gmail address>"`. Without these the app still works, but emails are only recorded in *Admin → Email log*.
   *(Alternative: [Resend](https://resend.com). Set `RESEND_API_KEY` and an `EMAIL_FROM` on a domain you verified there. Its free tier allows 100 emails/day, which a busy 35-person team can exceed; Gmail allows ~500/day.)*
5. **Discord (optional).** To have new questions and replies posted to your leaders' Discord channel: make the channel **leaders-only** (questions are posted in full), then *Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL*, and add it in Vercel as `DISCORD_WEBHOOK_URL`. Answers still happen in the portal. Check it with *Admin → Email log → Send a test message to Discord*.
6. **Deploy.** *Deployments → ⋯ → Redeploy* so the database and settings take effect.
7. **Become the admin right away:** open the site → *Create an account* with the email from `ADMIN_EMAILS`. You land in the app with the **Admin** section in the menu. Do this before sharing the link.
8. In **Admin → Email log**, press **Send me a test email**. Then share the link and the team code. Members can start using it immediately; approve leaders, mentors and teachers in **Admin → Approvals**.

> **Admins and owners:** every leader, the captain, mentors, and teachers automatically have admin access. To add another **owner**, open *Admin → People*, pick the person, tick **Owner**. (`ADMIN_EMAILS` only creates the *first* owner.)
> **Locked out of admin?** From a computer with this repo and your production database URL as `DATABASE_URL` in `.env`, run
> `npm run admin -- --email you@example.com --name "Your Name"`. To just reset someone's password without changing their role: `npm run admin -- --email them@example.com --reset-only`.
> **Someone can't get emails / typo'd their email?** *Admin → People → (person)*: fix the email there. **Forgot password?** Same page → *Send password reset*. The page also shows the one-time link (works once, for 1 hour), so you can send it to them yourself even if email isn't set up.

**Logo:** the husky mark lives in `public/brand/husky-mark.svg` (a redrawn version of the team logo). Replace that file with the original artwork to update it everywhere. Colors are defined once at the top of `src/app/globals.css`.

## Run it on your computer

Requires Node.js 22+. No Docker or database install needed. A real PostgreSQL server runs from `node_modules`.

```bash
npm install
cp .env.example .env          # defaults work for local development
npm run db:start              # terminal 1: local Postgres on port 54329 (keep it running)
npx prisma migrate deploy     # terminal 2: create the tables
npm run db:seed               # demo team: 27 people, tasks, questions (password: huskyteers123)
npm run dev                   # http://localhost:3000
```

Demo sign-ins (password `huskyteers123`): `admin@example.com` (captain + admin), `marcus.johnson@example.com` (build leader), `priya.raman@example.com` (software leader), `maya.patel@example.com` (software member). Without an email server configured, emails are printed in the terminal and recorded in *Admin → Email log*. Reset the demo data with `npm run db:seed -- --reset`.

## Tests

```bash
npm run typecheck && npm run lint
npm test                                   # 355 service/permission/notification tests on real Postgres
npm run build && npm run test:e2e          # 30 browser tests in Chrome (desktop + phone), own database
npm run build && npm run tour              # full-page screenshots of every screen → e2e-artifacts/tour
npm run build && npm start                 # then, in another terminal:
npm run loadtest -- --users 40 --connections 60 --duration 20
```

Load test on a laptop (production build, 40 accounts signed in at once, 60 concurrent connections): **~470 page loads/second with zero errors, p99 ~220 ms**. Leader dashboards: ~260/s, p99 ~300 ms. With a full season of data (~4,750 tasks) every page's database work stays under 15 ms. Real use by 30–40 people is a few requests per second.

## How it's built

Next.js 16 (App Router, Server Components, Server Actions) · React 19 · Tailwind CSS 4 · Prisma 7 + PostgreSQL · zod · Nodemailer / Resend · Vitest · Playwright.

- Architecture, roles and permissions, the checklist state machine, and coding conventions: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).
- Security: scrypt password hashing, server-side sessions (httpOnly cookie, revocable, 30 days), permission checks in every service (never just hidden buttons), Postgres-backed rate limiting on sign-in/sign-up/reset, one-time reset links (1 hour), all user text escaped in pages and emails.
- Reliability: emails send after the response, so a slow mail server never slows the app. Every email attempt is logged. Conditional database writes prevent two leaders from double-reviewing the same item.
