# Job Docket — installable app with Claude-tidied voice notes

A complete, ready-to-host web app for field techs. Say the whole job in
one go — the job, what you did, any parts — and it sorts itself into the
right fields, written the way it needs to read once it's sitting in
Tradify and going out on the customer's invoice. Tap once and it emails
straight to your office. Installs on an iPhone or Android like a real
app — home screen icon, full-screen, works offline for typing and saving.

## How the voice pipeline works

The big mic button at the top ("Dictate the whole job") records one
continuous take — say the job reference, then the start and finish time,
then what you did, then any parts used, in whatever order feels natural.
Each of the smaller mic
buttons next to a single field does the same thing for just that field,
for going back and fixing or adding one thing afterward. Either way, the
audio goes to this app's own small backend, which:

1. Sends it to **Deepgram** (a speech-to-text service) with a list of
   marine trade terms — brand names, model numbers — so they come through
   correctly instead of getting mangled.
2. Passes that raw transcript to **Claude**. For the whole-job recording,
   Claude splits it into the job reference, the start/finish time, the
   work note, and a list of parts, and fills all of those fields at once.
   Either way, the work note
   comes back rewritten as a proper trade job note: past tense, no "I did
   this", brands and model numbers corrected and capitalised properly,
   casual filler tidied out — the way a line item should read when a
   customer sees it on their invoice. It never invents or drops a fact
   that wasn't said.

Claude itself can't listen to audio directly (it's a text model), which is
why step 1 exists — this is the same two-step shape Claude's own apps use
under the hood.

Tapping "Email note" sends the finished note straight to the address
you've set, via a third email service (Resend) — no mail app, no tap to
send on the other end.

All of this only runs when there's a signal, since it calls out to those
outside services. With no signal, typing, saving and the keyboard's own
dictation still work fine, and everything saves locally until you're back
in range.

### A hands-free "Hey Siri" shortcut (optional)

You can't give a website its own wake word — "Hey Claude" specifically
isn't something any app on an iPhone is allowed to listen for in the
background, including Claude's own app. Only Apple's "Hey Siri" gets
that. But you can get close: this app understands a web address ending in
`?autorecord=1`, which makes it jump straight into the whole-job recording
the moment it opens, no tap needed (iOS may still ask you to tap once the
very first time, depending on how Safari handles microphone permission on
your phone — after that it should just start).

To wire that up to your voice on an iPhone:
1. Open the **Shortcuts** app → **+** → **Add Action** → search **Open URLs**.
2. Set the URL to your app's address with `?autorecord=1` on the end, e.g.
   `https://your-app.netlify.app/?autorecord=1`.
3. Tap the shortcut's name at the top → rename it to whatever phrase you
   want to say, e.g. "New Job".
4. In the same screen, turn on **Add to Siri** and record that phrase.

From then on, "Hey Siri, New Job" (or whatever you named it) opens the app
and starts listening.

## 1. Get three API keys (and optionally set a PIN)

**Deepgram** (speech-to-text) — https://console.deepgram.com/signup
- Free accounts get $200 of credit, which at this app's volume is
  effectively years of use. No card needed to start.
- Once signed in: **API Keys** → **Create a New API Key** → copy it.

**Anthropic** (Claude, for the clean-up step) — https://console.anthropic.com
- Create an account, add a payment method (usage here is tiny — well
  under a cent per note with the fast Haiku model this app uses).
- **API Keys** → **Create Key** → copy it.

**Resend** (sends the "Email note" button's email) — https://resend.com
- Sign up free (100 emails/day, 3,000/month — plenty for this).
- **API Keys** → **Create API Key** → copy it.
- One catch: on a brand-new Resend account, you can only send to the
  exact email address you signed up with, until you verify a domain you
  own (**Domains** → **Add Domain**, then add the DNS records it gives
  you — usually a 10-minute job if you already manage a domain). If the
  note just needs to land in your own inbox, the address you signed up
  with works immediately with nothing further to do. If it needs to go
  to a shared office address on a domain you own, verify that domain
  first. If you don't have a domain to verify, sign up to Resend with the
  office address itself and skip verification.

**App PIN** (optional but recommended) — just make up a short PIN
yourself (e.g. a 6-digit number). This stops a stranger who stumbles on
the app's web address from running up your Deepgram/Anthropic/Resend
bill. Staff enter it once in the app's "App PIN" field and it's
remembered on their phone. Skip this by leaving `APP_SECRET` unset in
step 2 — the mic and email button still work for anyone with the link.

Keep these values somewhere safe for a minute — you'll paste them into
Netlify next, and nowhere else.

## 2. Put the app online (Netlify, free)

Because this version has a small backend (not just static pages), the
simplest reliable path is connecting a GitHub repo rather than a plain
drag-and-drop:

1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new repository (**+** → **New repository**), any name (e.g.
   `job-docket`).
3. On the repo page: **Add file** → **Upload files** → drag in everything
   from this `pwa` folder (keep the folder structure — `netlify/functions/`
   and `icons/` should stay as subfolders) → **Commit changes**.
4. Go to https://app.netlify.com and sign up / log in.
5. **Add new site** → **Import an existing project** → **GitHub** → pick
   the repository you just created. Leave the build settings as they are
   (this app has no build step) → **Deploy**.
6. Once it's deployed: **Site configuration** → **Environment variables**
   → **Add a variable**, and add:
   - `DEEPGRAM_API_KEY` = the Deepgram key from step 1
   - `ANTHROPIC_API_KEY` = the Anthropic key from step 1
   - `RESEND_API_KEY` = the Resend key from step 1
   - `FROM_EMAIL` = optional — e.g. `Job Docket <notify@yourdomain.com>`,
     only if you verified a domain in Resend. Leave it unset to send from
     Resend's shared test address instead (self-send only, see above).
   - `APP_SECRET` = your PIN (optional — skip to leave the mic and email
     button open to anyone with the link)
7. **Deploys** tab → **Trigger deploy** → **Deploy site**, so the new
   environment variables take effect.
8. Netlify gives you a live web address (something like
   `random-name-123.netlify.app`, or pick a nicer free subdomain in
   **Site configuration** → **Domain management**). That's the link to
   share with staff.

If you've already got hosting for your own website and it's not on
Netlify, tell me and I can adapt this for it — it just needs somewhere
that runs small serverless functions (Netlify, Vercel and Cloudflare all
do this for free at this scale).

## 3. Install it on an iPhone

1. Open the live link in **Safari** (has to be Safari, not Chrome, for
   this to work on iOS).
2. Tap the **Share** button (square with an arrow) in the toolbar.
3. Tap **Add to Home Screen**, then **Add**.
4. A "Job Docket" icon appears on the home screen — tapping it opens the
   app full-screen, no browser bar.
5. First time using the mic, Safari will ask for microphone permission —
   allow it. If your office set a PIN, enter it once in the "App PIN"
   field.

Android (Chrome) works the same way via the ⋮ menu → **Add to Home
screen**.

## 4. Publishing updates later

Push changes to the same GitHub repository (or use **Add file** → **Upload
files** again to replace files) and Netlify redeploys automatically. If
`index.html`, `manifest.json` or the icons changed, also bump the version
number at the top of `service-worker.js` (`job-docket-v4` → `-v5`, etc.)
so phones that already installed it pick up the new version.

## Changing the tone or wording of the notes

The exact instructions Claude follows live in
`netlify/functions/dictate.js`. `CLEANUP_PROMPTS.notes` shapes the work
note that ends up in Tradify and on the invoice; `CLEANUP_PROMPTS.clientNote`
shapes the separate note-to-client field; `FULL_JOB_PROMPT` is the one
used by the "Dictate the whole job" button, and shapes all three at once.
If any of them are too formal, too terse, missing something they should
always mention, or just not quite your voice, tell me what to change and
I'll adjust that prompt directly — no need to touch anything else.

## What's in this folder

- `index.html` — the app itself
- `manifest.json` — tells the phone how to install it (name, icon, colours)
- `service-worker.js` — makes it work offline
- `netlify.toml` — tells Netlify where the backend functions live
- `netlify/functions/dictate.js` — Deepgram → Claude pipeline (transcribe,
  then rewrite as a proper job note)
- `netlify/functions/send-note.js` — sends the finished note by email via
  Resend
- `icons/` — the app icon at the sizes iOS and Android each want

Nothing in here talks to Tradify directly — Tradify has no public API to
write into, so this still ends with a Copy/Share/Email step. If Tradify
ever grants API access, `dictate.js` is where a "write straight into the
job" step would eventually plug in.
