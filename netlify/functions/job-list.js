// Job Docket — a cached copy of Tradify's Active Jobs list, so the app can
// offer a searchable dropdown of real jobs (customer, job number, reference)
// instead of relying only on free-typed/dictated text. Tradify has no API,
// so this cache is kept fresh by a scheduled browser session that reads the
// Active Jobs list in Tradify and POSTs the result here (same mechanism as
// the Tradify sync itself).
//
// GET /api/job-list -> { updatedAt, jobs: [{jobNumber, customer, reference,
// status}, ...] }. Used by the app to build the dropdown, and cached
// locally on the phone so it works even with no signal.
// POST /api/job-list -> replace the cached list (needs the app PIN in
// x-app-secret if APP_SECRET is set, same as the other functions). Body:
// { jobs: [...] }.
//
// Requires the same environment variables as submit-entry.js
// (APP_SECRET, NETLIFY_BLOBS_TOKEN) — nothing extra to set up if that's
// already configured.

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
    ? getStore({ name: "job-docket-joblist", siteID: BLOBS_SITE_ID, token: blobsToken })
    : getStore("job-docket-joblist");

  if (event.httpMethod === "GET") {
    try {
      const cached = await store.get("current", { type: "json" });
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cached || { updatedAt: null, jobs: [] })
      };
    } catch (e) {
      return { statusCode: 500, body: JSON.stringify({ error: "Couldn't read the job list." }) };
    }
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

  const jobs = Array.isArray(payload && payload.jobs) ? payload.jobs : null;
  if (!jobs) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing jobs array." }) };
  }

  // Keep only the fields the app actually needs, and only well-formed rows —
  // this is scraped off a live web page, so be defensive about shape.
  const clean = jobs
    .filter((j) => j && j.jobNumber)
    .map((j) => ({
      jobNumber: String(j.jobNumber).trim(),
      customer: String(j.customer || "").trim(),
      reference: String(j.reference || "").trim(),
      status: String(j.status || "").trim()
    }));

  const record = { updatedAt: new Date().toISOString(), jobs: clean };

  try {
    await store.setJSON("current", record);
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Couldn't save the job list." }) };
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, count: clean.length, updatedAt: record.updatedAt })
  };
};
