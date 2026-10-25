/* Shared helpers for the CME workshop TV pages (/tv/hours.html, /tv/tasks.html).
   Figures come from /api/dashboard-data, which the office PC (job-docket-sync)
   fills from Tradify every 15 minutes. The page address carries the read key:
   /tv/hours.html?key=XXXX */
window.CME = (function () {
  const pad = (n) => String(n).padStart(2, "0");
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DAY = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const KEY = new URLSearchParams(location.search).get("key") || "";

  function parseYmd(s) { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
  function dayMonth(d) { return d.getDate() + " " + MON[d.getMonth()]; }
  function weekday(d) { return DAY[d.getDay()]; }
  function time12(d) {
    let h = d.getHours(), m = d.getMinutes(); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
    return h + (m ? ":" + pad(m) : "") + ap;
  }
  function parseYmdhm(s) { const d = parseYmd(s); const [h, m] = s.slice(11, 16).split(":").map(Number); d.setHours(h, m); return d; }
  function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function hrs(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function shortName(full) { const p = full.trim().split(/\s+/); return p.length > 1 ? p[0] + " " + p[p.length - 1][0] + "." : p[0]; }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function when(d) { return weekday(d) + " " + time12(d); }

  // Fetch everything; returns { data, all, problem } where data = the requested part
  // ("hours" or "tasks") with .updatedAt set, and problem = "key" | "offline" | null.
  let lastGood = null;
  async function load(part) {
    if (!KEY) return { data: null, all: null, problem: "key" };
    let problem = null;
    try {
      const r = await fetch("/api/dashboard-data?key=" + encodeURIComponent(KEY) + "&t=" + Date.now(), { cache: "no-store" });
      if (r.status === 401) return { data: null, all: null, problem: "key" };
      if (!r.ok) throw new Error("HTTP " + r.status);
      lastGood = await r.json();
    } catch (e) {
      problem = "offline";   // keep showing the last figures we had
    }
    const all = lastGood;
    const data = all && all[part] ? Object.assign({}, all[part], { updatedAt: all[part + "At"] || all.receivedAt }) : null;
    return { data, all, problem };
  }

  // Red banner when something needs a person: no key, no internet, Tradify logged out, or stale figures.
  function showStatus(bannerEl, updatedEl, res) {
    const at = res.data && res.data.updatedAt ? new Date(res.data.updatedAt) : null;
    if (updatedEl) updatedEl.textContent = at ? "Updated " + when(at) : "Waiting for the first update from the office PC…";
    const st = res.all && res.all.status;
    const now = new Date(), h = now.getHours() + now.getMinutes() / 60, workday = now.getDay() !== 0;
    let msg = "";
    if (res.problem === "key") msg = "This TV address is missing its dashboard key — check the addresses in the Pi's tv.conf";
    else if (res.problem === "offline") msg = "Can't reach the dashboard website — check the Pi's internet" + (at ? " · figures from " + when(at) : "");
    else if (st && st.loginNeeded) msg = "Tradify needs logging in again on the office PC (npm run login)" + (at ? " · figures from " + when(at) : "");
    else if (at && workday && h >= 6.5 && h < 18.5 && now - at > 75 * 60 * 1000)
      msg = "Not updated since " + when(at) + " — check the office PC is on" + (st && st.message ? " · " + st.message : "");
    bannerEl.textContent = msg;
    bannerEl.classList.toggle("show", !!msg);
  }

  // Redraw every minute; reload the page every 6 hours to pick up page changes and keep the Pi fresh.
  function loop(fn) {
    fn(); setInterval(fn, 60 * 1000);
    setTimeout(() => location.reload(), 6 * 60 * 60 * 1000);
  }

  return { parseYmd, parseYmdhm, dayMonth, weekday, time12, today, hrs, shortName, el, load, showStatus, loop };
})();
