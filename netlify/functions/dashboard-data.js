// Job Docket — data for the workshop TV dashboards (billable hours, job tasks, calendar).
//
// The office PC (job-docket-sync) reads Tradify and POSTs the figures here
// every 15 minutes. The TV pages in /tv/ GET them. The Raspberry Pi driving the
// TVs never touches Tradify — it only opens /tv/hours.html and /tv/tasks.html.
//
// GET  /api/dashboard-data?key=<read key>         -> { receivedAt, status, hours, tasks, calendar }
// POST /api/dashboard-data   header x-dashboard-key: <write key>
//      body { hours?, tasks?, calendar?, status? }   (each part replaces what's stored;
//      status alone is how the PC reports "Tradify logged out" etc.)
//
// The keys themselves aren't in this file (the repo is public) — only their
// SHA-256 hashes. The read key is in the Pi's TV addresses; the write key is in
// job-docket-sync's config.json on the office PC. To change a key, generate a
// new one, put its hash here, and update the PC/Pi to match.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");
const { parseIcs } = require("../lib/ics.js");

// CME_CALENDAR_ICS (Netlify environment variable): the CME Google Calendar's
// "Secret address in iCal format". When set, this function reads the calendar
// itself (at most every 10 minutes) for the TV calendar page — no PC needed.
const CALENDAR_REFRESH_MS = 10 * 60 * 1000;
async function refreshCalendar(store, cur) {
  const url = process.env.CME_CALENDAR_ICS;
  if (!url) return cur;
  if (cur.calendarAt && Date.now() - Date.parse(cur.calendarAt) < CALENDAR_REFRESH_MS) return cur;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error("calendar address answered HTTP " + r.status);
    const now = Date.now();
    const cal = parseIcs(await r.text(), new Date(now - 8 * 86400000), new Date(now + 22 * 86400000));
    cur.calendar = cleanCalendar({ name: cal.name || "CME", events: cal.events });
    cur.calendarAt = new Date().toISOString();
    delete cur.calendarError;
    await store.setJSON("current", cur);
  } catch (e) {
    cur.calendarError = String(e.message || e).slice(0, 200);   // keep showing the last good calendar
  }
  return cur;
}

const READ_KEY_SHA256 = "e13c8235e17f626fcd4137bf4c6a6e07d89c2184f059f973b797c49de5e71c9f";
const WRITE_KEY_SHA256 = "101263a37cacb9b20f952ba642951abb1491221541bbade4810c8c90218005e1";
const MAX_BODY = 900 * 1024;

function hashOf(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}
function sameHash(a, b) {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function reply(statusCode, obj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(obj)
  };
}

function openStore() {
  const BLOBS_SITE_ID = "5487a496-1020-4e3e-b581-cd5738e251d8";
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  return token
    ? getStore({ name: "job-docket-dashboard", siteID: BLOBS_SITE_ID, token })
    : getStore("job-docket-dashboard");
}

// Keep only the shapes the TV pages use — this arrives from a scraper, so be defensive.
function cleanHours(h) {
  if (!h || !Array.isArray(h.weekStarts) || !Array.isArray(h.staff)) return null;
  const n = h.weekStarts.length;
  const nums = (a) => (Array.isArray(a) ? a : []).slice(0, n).map((v) => Number(v) || 0);
  return {
    weekStarts: h.weekStarts.map(String).slice(0, 52),
    targetHours: Number(h.targetHours) || 32,
    staff: h.staff.slice(0, 50).map((s) => ({ name: String(s.name || "").slice(0, 80), billable: nums(s.billable), total: nums(s.total) }))
  };
}
function cleanTasks(t) {
  if (!t || !Array.isArray(t.tasks)) return null;
  const str = (v, n) => String(v || "").slice(0, n);
  return {
    activeJobs: Number(t.activeJobs) || 0,
    tasks: t.tasks.slice(0, 500).map((x) => ({
      task: str(x.task, 200),
      jobNumber: str(x.jobNumber, 20),
      customer: str(x.customer, 120),
      reference: str(x.reference, 160),
      jobStatus: str(x.jobStatus, 60),
      staff: (Array.isArray(x.staff) ? x.staff : []).slice(0, 12).map((s) => str(s, 80)),
      due: x.due ? str(x.due, 10) : null,
      appointments: (Array.isArray(x.appointments) ? x.appointments : []).slice(0, 20).map((a) => ({
        start: str(a.start, 16), end: a.end ? str(a.end, 16) : null, staff: a.staff ? str(a.staff, 80) : null
      }))
    }))
  };
}

// Calendar events, times as Perth local "YYYY-MM-DDTHH:MM" (allDay events as "YYYY-MM-DD").
function cleanCalendar(c) {
  if (!c || !Array.isArray(c.events)) return null;
  const str = (v, n) => String(v || "").slice(0, n);
  return {
    name: str(c.name, 80),
    events: c.events.slice(0, 400).map((e) => ({
      title: str(e.title, 200), start: str(e.start, 16), end: str(e.end, 16),
      allDay: !!e.allDay, location: str(e.location, 160), description: str(e.description, 300)
    }))
  };
}

exports.handler = async (event) => {
  const store = openStore();

  if (event.httpMethod === "GET") {
    const key = (event.queryStringParameters && event.queryStringParameters.key) || event.headers["x-dashboard-key"] || "";
    if (!sameHash(hashOf(key), READ_KEY_SHA256) && !sameHash(hashOf(key), WRITE_KEY_SHA256)) {
      return reply(401, { error: "Missing or wrong dashboard key." });
    }
    try {
      let d = await store.get("current", { type: "json" });
      d = await refreshCalendar(store, d || { receivedAt: null, status: null, hours: null, tasks: null, calendar: null });
      return reply(200, d);
    } catch (e) {
      return reply(500, { error: "Couldn't read the dashboard data." });
    }
  }

  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  const wkey = event.headers["x-dashboard-key"] || event.headers["X-Dashboard-Key"] || "";
  if (!sameHash(hashOf(wkey), WRITE_KEY_SHA256)) return reply(401, { error: "Missing or wrong dashboard write key." });
  if ((event.body || "").length > MAX_BODY) return reply(413, { error: "Too much data." });

  let body;
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body); }
  catch (e) { return reply(400, { error: "Bad request." }); }

  let cur = null;
  try { cur = await store.get("current", { type: "json" }); } catch (e) { /* first write */ }
  cur = cur || { receivedAt: null, status: null, hours: null, tasks: null };
  const now = new Date().toISOString();

  const hours = body.hours !== undefined ? cleanHours(body.hours) : undefined;
  const tasks = body.tasks !== undefined ? cleanTasks(body.tasks) : undefined;
  const calendar = body.calendar !== undefined ? cleanCalendar(body.calendar) : undefined;
  if (hours === null || tasks === null || calendar === null) return reply(400, { error: "hours/tasks/calendar came in an unexpected shape — nothing stored." });

  if (hours) { cur.hours = hours; cur.hoursAt = now; }
  if (tasks) { cur.tasks = tasks; cur.tasksAt = now; }
  if (calendar) { cur.calendar = calendar; cur.calendarAt = now; }
  if (hours || tasks || calendar) cur.receivedAt = now;
  const st = body.status && typeof body.status === "object" ? body.status : { ok: true };
  cur.status = { ok: st.ok !== false, loginNeeded: !!st.loginNeeded, message: String(st.message || "").slice(0, 300), at: now };

  try { await store.setJSON("current", cur); }
  catch (e) { return reply(500, { error: "Couldn't save the dashboard data." }); }

  return reply(200, {
    ok: true, receivedAt: cur.receivedAt,
    staff: cur.hours ? cur.hours.staff.length : 0,
    tasks: cur.tasks ? cur.tasks.tasks.length : 0,
    events: cur.calendar ? cur.calendar.events.length : 0
  });
};
