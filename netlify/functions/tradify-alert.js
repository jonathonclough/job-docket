// Job Docket — Tradify sync alert. Called by the Tradify sync (a scheduled
// Claude session that drives Tradify through a browser — there's no Tradify
// API) whenever something needs a person to look at it: a job it couldn't
// find, a staff name it didn't recognise, missing start/finish times, or a
// part that isn't in Tradify's price list. Sends ONE summary email per sync
// run rather than one per item, so a bad run doesn't spam the inbox.
//
// POST /api/tradify-alert   body: { items: [{ id, job, tech, reason }] }
//
// Requires (same as the other functions):
// RESEND_API_KEY — from resend.com
// FROM_EMAIL — optional, see submit-entry.js

const ALERT_TO = "tradify.agent@cloughmarine.com.au";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request." }) };
  }

  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!items.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "No items to report." }) };
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Email isn't configured (RESEND_API_KEY missing)." }) };
  }
  const from = process.env.FROM_EMAIL || "Job Docket <onboarding@resend.dev>";

  const count = items.length;
  const lines = [
    "The Tradify sync needs a hand with " + count + " job" + (count === 1 ? "" : "s") + ":",
    ""
  ];
  items.forEach(function (it, i) {
    lines.push((i + 1) + ". " + ((it && it.job) || "(no job text)"));
    if (it && it.tech) lines.push("   Tech: " + it.tech);
    lines.push("   Issue: " + ((it && it.reason) || "Unknown"));
    lines.push("   Reference: " + ((it && it.id) || "?"));
    lines.push("");
  });
  lines.push("These are still sitting as \"pending\"/\"needs_attention\" in Job Docket — check submissions.html and enter them into Tradify by hand once sorted.");
  const text = lines.join("\n");

  let emailed = false;
  let emailError = null;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: from,
        to: [ALERT_TO],
        subject: "Tradify sync — " + count + " job" + (count === 1 ? "" : "s") + " need" + (count === 1 ? "s" : "") + " attention",
        text: text
      })
    });
    const data = await res.json().catch(function () { return {}; });
    emailed = res.ok;
    if (!res.ok) emailError = (data && (data.message || data.error)) || "The email service rejected that.";
  } catch (e) {
    emailError = "Couldn't reach the email service.";
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, emailed: emailed, emailError: emailError })
  };
};
