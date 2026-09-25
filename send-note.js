// Job Docket — sends the finished note straight to an inbox via Resend,
// with no mail app or tap-to-send step needed on the phone.
//
// Requires (Netlify -> Site configuration -> Environment variables):
//   RESEND_API_KEY   — from resend.com
//   FROM_EMAIL       — optional. Who the email appears to come from, e.g.
//                       "Job Docket <notify@yourdomain.com>". Sending to
//                       anyone other than the address you signed up to
//                       Resend with needs a domain verified in Resend. Left
//                       unset, this falls back to Resend's shared test
//                       address, which can only deliver to your own
//                       sign-up address — fine to try this out, not for a
//                       shared office inbox.
//   APP_SECRET       — same PIN as the dictate function, if you set one.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resendKey = process.env.RESEND_API_KEY;
  const appSecret = process.env.APP_SECRET;

  if (!resendKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Email sending isn't set up yet — add RESEND_API_KEY in Netlify, then redeploy." })
    };
  }

  if (appSecret) {
    const provided = event.headers["x-app-secret"] || event.headers["X-App-Secret"];
    if (provided !== appSecret) {
      return { statusCode: 401, body: JSON.stringify({ error: "Wrong app PIN — check with your office." }) };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request." }) };
  }

  const to = ((payload && payload.to) || "").trim();
  const subject = (payload && payload.subject) || "Job note";
  const text = (payload && payload.text) || "";

  if (!to) return { statusCode: 400, body: JSON.stringify({ error: "No destination email address set." }) };
  if (!text.trim()) return { statusCode: 400, body: JSON.stringify({ error: "Nothing to send yet." }) };

  const from = process.env.FROM_EMAIL || "Job Docket <onboarding@resend.dev>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + resendKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: from, to: [to], subject: subject, text: text })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || "The email service rejected that.";
      return { statusCode: 502, body: JSON.stringify({ error: msg }) };
    }
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, id: data.id }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "Couldn't reach the email service." }) };
  }
};
