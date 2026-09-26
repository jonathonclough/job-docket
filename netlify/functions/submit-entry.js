// Job Docket — the tech's "Submit" button calls this. It:
// 1. Stores the finished job entry so the office has a record (Netlify
// Blobs — built into every Netlify site, nothing extra to sign up for).
// 2. Sends a confirmation email to the address entered in the app.
// Storage succeeding is what "submitted" means to the app; the email is a
// best-effort extra on top of that, so a slow/broken email service doesn't
// stop a job being logged.
//
// GET /api/submit-entry -> list recent submissions (needs the app PIN in
// x-app-secret if APP_SECRET is set). Used by
// submissions.html for the office to review, and by the Tradify sync.
// POST /api/submit-entry -> store a new submission + email a confirmation.
// PATCH /api/submit-entry?id=<id> -> update a submission's Tradify status
// (used by the Tradify sync once it's tried to enter the job — see
// tradify.status: "pending" | "entered" | "needs_attention" | "failed").
//
// Requires (Netlify -> Site configuration -> Environment variables):
// RESEND_API_KEY — from resend.com (same as send-note.js)
// FROM_EMAIL — optional, see send-note.js
// APP_SECRET — same PIN as the other functions, if you set one
// NETLIFY_BLOBS_TOKEN — optional. Only needed if Netlify's automatic
// storage setup isn't working (shows as "MissingBlobsEnvironmentError").
// Create one at Netlify -> user settings -> Applications -> Personal
// access tokens, then add it here as an environment variable. If this
// isn't set, storage falls back to Netlify's normal automatic setup.

const { getStore } = require("@netlify/blobs");

function checkSecret(event, appSecret) {
if (!appSecret) return true;
const provided = event.headers["x-app-secret"] || event.headers["X-App-Secret"];
return provided === appSecret;
}

exports.handler = async (event) => {
const appSecret = process.env.APP_SECRET;
if (!checkSecret(event, appSecret)) {
return { statusCode: 401, body: JSON.stringify({ error: "Wrong app PIN — check with your office." }) };
}

const BLOBS_SITE_ID = "5487a496-1020-4e3e-b581-cd5738e251d8";
const blobsToken = process.env.NETLIFY_BLOBS_TOKEN;
const store = blobsToken
  ? getStore({ name: "job-docket-submissions", siteID: BLOBS_SITE_ID, token: blobsToken })
  : getStore("job-docket-submissions");

if (event.httpMethod === "GET") {
try {
const { blobs } = await store.list();
const keys = blobs.map((b) => b.key).sort().reverse().slice(0, 200);
const items = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
return {
statusCode: 200,
headers: { "content-type": "application/json" },
body: JSON.stringify({ submissions: items.filter(Boolean) })
};
} catch (e) {
return { statusCode: 500, body: JSON.stringify({ error: "Couldn't read submissions." }) };
}
}

if (event.httpMethod === "PATCH") {
const id = event.queryStringParameters && event.queryStringParameters.id;
if (!id) {
return { statusCode: 400, body: JSON.stringify({ error: "Missing id." }) };
}
let patch;
try {
patch = JSON.parse(event.body);
} catch (e) {
return { statusCode: 400, body: JSON.stringify({ error: "Bad request." }) };
}
let existing;
try {
existing = await store.get(id, { type: "json" });
} catch (e) {
return { statusCode: 500, body: JSON.stringify({ error: "Couldn't read that submission." }) };
}
if (!existing) {
return { statusCode: 404, body: JSON.stringify({ error: "No submission with that id." }) };
}
existing.tradify = Object.assign({}, existing.tradify, (patch && patch.tradify) || {});
try {
await store.setJSON(id, existing);
} catch (e) {
return { statusCode: 500, body: JSON.stringify({ error: "Couldn't save that update." }) };
}
return {
statusCode: 200,
headers: { "content-type": "application/json" },
body: JSON.stringify({ ok: true, id: id, tradify: existing.tradify })
};
}

if (event.httpMethod !== "POST") {
return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
}

let payload;
try {
payload = JSON.parse(event.body);
} catch (e) {
return { statusCode: 400, body: JSON.stringify({ error: "Bad request." }) };
}

const job = ((payload && payload.job) || "").trim();
const notes = ((payload && payload.notes) || "").trim();
if (!job && !notes) {
return { statusCode: 400, body: JSON.stringify({ error: "Add a job and some notes first." }) };
}

const now = new Date();
const id = now.toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8);

const entry = {
id: id,
submittedAt: now.toISOString(),
job: job || "(job not entered)",
// Set only when the tech picked a job from the dropdown (backed by
// netlify/functions/job-list.js's cache of Tradify's Active Jobs). When
// present, this is an exact Tradify job number (e.g. "JB02287") the sync
// can search for directly with no ambiguity. Left blank for free-typed or
// dictated-only job text, which the sync still has to match by name.
jobNumber: ((payload && payload.jobNumber) || "").trim(),
tech: ((payload && payload.tech) || "").trim(),
notes: notes || "(no notes)",
parts: Array.isArray(payload && payload.parts) ? payload.parts : [],
clientNote: ((payload && payload.clientNote) || "").trim(),
startTime: (payload && payload.startTime) || "",
finishTime: (payload && payload.finishTime) || "",
emailTo: ((payload && payload.emailTo) || "").trim(),
// Tradify integration status. The sync (a scheduled Claude session that
// drives a Tradify-logged-in Chrome browser — there's no Tradify API)
// picks up "pending" entries, tries to find the matching job, enters the
// time/notes/parts, and updates this via PATCH:
// "pending" — not processed yet
// "entered" — successfully entered into Tradify (see jobRef)
// "needs_attention" — job couldn't be matched, or a part wasn't
// recognised in Tradify's price list; an alert email was sent
// "failed" — something else went wrong; will be retried
tradify: { status: "pending", jobRef: null, enteredAt: null, note: null, partsFlagged: [] }
};

try {
await store.setJSON(id, entry);
} catch (e) {
return { statusCode: 500, body: JSON.stringify({ error: "Couldn't save that — try again." }) };
}

let emailed = false;
let emailError = null;
const resendKey = process.env.RESEND_API_KEY;
const to = entry.emailTo;

if (resendKey && to) {
const from = process.env.FROM_EMAIL || "Job Docket <onboarding@resend.dev>";
const lines = [
"Job: " + entry.job,
entry.tech ? "Tech: " + entry.tech : null,
(entry.startTime || entry.finishTime) ? "Time: " + (entry.startTime || "?") + " - " + (entry.finishTime || "?") : null,
"",
"Notes:",
entry.notes
];
if (entry.parts.length) {
lines.push("", "Parts:");
entry.parts.forEach(function (p) {
lines.push("- " + (p && p.qty ? p.qty : "1") + " x " + (p && p.desc ? p.desc : ""));
});
}
if (entry.clientNote) {
lines.push("", "Client note:", entry.clientNote);
}
lines.push("", "Submitted " + now.toLocaleString("en-AU"), "Reference: " + id);
const text = "This job has been submitted and logged.\n\n" + lines.filter(function (l) { return l !== null; }).join("\n");

try {
const res = await fetch("https://api.resend.com/emails", {
method: "POST",
headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
body: JSON.stringify({ from: from, to: [to], subject: "Job submitted — " + entry.job, text: text })
});
const data = await res.json().catch(function () { return {}; });
emailed = res.ok;
if (!res.ok) emailError = (data && (data.message || data.error)) || "The email service rejected that.";
} catch (e) {
emailError = "Couldn't reach the email service.";
}
}

return {
statusCode: 200,
headers: { "content-type": "application/json" },
body: JSON.stringify({ ok: true, id: id, emailed: emailed, emailError: emailError })
};
};
