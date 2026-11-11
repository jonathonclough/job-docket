// Reads a Google Calendar "secret address in iCal format" (.ics) into the simple
// event list the TV calendar page uses. Times come out as Perth local time
// ("YYYY-MM-DDTHH:MM"; all-day events as "YYYY-MM-DD" with an exclusive end date).
//
// Handles what Google exports: UTC (…Z) and TZID times, all-day dates, repeating
// events (daily / weekly / monthly / yearly, with INTERVAL, COUNT, UNTIL, BYDAY),
// deleted repeats (EXDATE), single changed repeats (RECURRENCE-ID) and cancelled events.
// Perth has no daylight saving, so Perth time is always UTC+8.

const PERTH_OFFSET_MIN = 8 * 60;
const DAY = 86400000;
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// "Perth wall clock" instants are kept as ms since epoch of the wall-clock time read as UTC,
// so date maths never trips over the host's time zone.
function wall(y, mo, d, h = 0, mi = 0) { return Date.UTC(y, mo - 1, d, h, mi); }
const pad = (n) => String(n).padStart(2, "0");
function fmt(ms, dateOnly) {
  const d = new Date(ms);
  const day = d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  return dateOnly ? day : day + "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
}

function unfold(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}
function unescape(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
function parseLine(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const [name, ...p] = head.split(";");
  const params = {};
  p.forEach((kv) => { const j = kv.indexOf("="); if (j > 0) params[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1).replace(/^"|"$/g, ""); });
  return { name: name.toUpperCase(), params, value };
}

// -> { ms (Perth wall clock), allDay }
function parseTime(value, params) {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || params.VALUE === "DATE") {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return { ms: wall(+m[1], +m[2], +m[3]), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  let ms = wall(+m[1], +m[2], +m[3], +m[4], +m[5]);
  if (m[7] === "Z") ms += PERTH_OFFSET_MIN * 60000;          // UTC -> Perth
  // TZID times: Google uses the calendar's zone; anything other than Perth is read as Perth time.
  return { ms, allDay: false };
}

function parseRRule(v) {
  const r = {};
  v.split(";").forEach((kv) => { const [k, val] = kv.split("="); if (k) r[k.toUpperCase()] = val; });
  return {
    freq: r.FREQ, interval: Math.max(1, parseInt(r.INTERVAL || "1", 10)),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? parseTime(r.UNTIL, {}).ms : null,
    byday: r.BYDAY ? r.BYDAY.split(",").map((s) => BYDAY[s.replace(/^[+-]?\d+/, "")]).filter((x) => x !== undefined) : null
  };
}

// All start times of a repeating event up to `to` (Perth wall-clock ms).
function occurrences(start, rule, to) {
  const out = [];
  const limit = 3000;
  const okUntil = (t) => rule.until === null || t <= rule.until;
  const push = (t) => { out.push(t); return rule.count !== null && out.length >= rule.count; };
  const d0 = new Date(start);
  if (rule.freq === "WEEKLY") {
    const days = rule.byday && rule.byday.length ? rule.byday : [d0.getUTCDay()];
    const weekStart = start - d0.getUTCDay() * DAY;        // Sunday of the first week
    for (let w = 0; w < limit; w += rule.interval) {
      const base = weekStart + w * 7 * DAY;
      if (base > to) break;
      for (const wd of [...days].sort((a, b) => a - b)) {
        const t = base + wd * DAY;
        if (t < start) continue;
        if (t > to || !okUntil(t)) return out;
        if (push(t)) return out;
      }
    }
    return out;
  }
  for (let i = 0; i < limit; i += 1) {
    let t;
    if (rule.freq === "DAILY") t = start + i * rule.interval * DAY;
    else if (rule.freq === "MONTHLY") t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i * rule.interval, d0.getUTCDate(), d0.getUTCHours(), d0.getUTCMinutes());
    else if (rule.freq === "YEARLY") t = Date.UTC(d0.getUTCFullYear() + i * rule.interval, d0.getUTCMonth(), d0.getUTCDate(), d0.getUTCHours(), d0.getUTCMinutes());
    else { out.push(start); return out; }
    if (t > to || !okUntil(t)) return out;
    if ((rule.freq === "MONTHLY" || rule.freq === "YEARLY") && new Date(t).getUTCDate() !== d0.getUTCDate()) continue; // e.g. 31st in a short month
    if (push(t)) return out;
  }
  return out;
}

// text: the .ics file. from/to: Date objects bounding the window wanted.
function parseIcs(text, from, to) {
  const lines = unfold(text);
  const fromW = from.getTime() + PERTH_OFFSET_MIN * 60000, toW = to.getTime() + PERTH_OFFSET_MIN * 60000;
  let name = "";
  const raw = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: new Set() }; continue; }
    if (line === "END:VEVENT") { if (cur) raw.push(cur); cur = null; continue; }
    const p = parseLine(line);
    if (!p) continue;
    if (!cur) { if (p.name === "X-WR-CALNAME") name = unescape(p.value); continue; }
    switch (p.name) {
      case "UID": cur.uid = p.value; break;
      case "SUMMARY": cur.title = unescape(p.value); break;
      case "LOCATION": cur.location = unescape(p.value); break;
      case "DESCRIPTION": cur.description = unescape(p.value); break;
      case "STATUS": cur.status = p.value.toUpperCase(); break;
      case "DTSTART": cur.start = parseTime(p.value, p.params); break;
      case "DTEND": cur.end = parseTime(p.value, p.params); break;
      case "RRULE": cur.rrule = parseRRule(p.value); break;
      case "EXDATE": p.value.split(",").forEach((v) => { const t = parseTime(v, p.params); if (t) cur.exdates.add(t.ms); }); break;
      case "RECURRENCE-ID": cur.recurrenceId = parseTime(p.value, p.params); break;
      default: break;
    }
  }

  // Single changed or cancelled repeats replace that occurrence of their series.
  const overrides = new Map();
  raw.filter((e) => e.recurrenceId && e.uid).forEach((e) => overrides.set(e.uid + "|" + e.recurrenceId.ms, e));

  const events = [];
  const add = (e, s, en) => {
    if (e.status === "CANCELLED") return;
    if (en <= fromW || s >= toW) return;
    events.push({
      title: e.title || "(no title)", start: fmt(s, e.start.allDay), end: fmt(en, e.start.allDay),
      allDay: !!e.start.allDay, location: e.location || "", description: (e.description || "").slice(0, 300)
    });
  };
  for (const e of raw) {
    if (!e.start || e.recurrenceId) continue;
    const dur = e.end ? e.end.ms - e.start.ms : (e.start.allDay ? DAY : 0);
    if (!e.rrule) { add(e, e.start.ms, e.start.ms + dur); continue; }
    for (const s of occurrences(e.start.ms, e.rrule, toW)) {
      if (e.exdates.has(s)) continue;
      const o = overrides.get(e.uid + "|" + s);
      if (o) { if (o.start) add(o, o.start.ms, o.end ? o.end.ms : o.start.ms + dur); continue; }
      add(e, s, s + dur);
    }
  }
  // Changed repeats whose series started before the window still show.
  raw.filter((e) => e.recurrenceId && e.start).forEach((o) => {
    const series = raw.find((e) => e.uid === o.uid && !e.recurrenceId);
    if (!series || !series.rrule) add(o, o.start.ms, o.end ? o.end.ms : o.start.ms);
  });
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { name, events };
}

module.exports = { parseIcs };
