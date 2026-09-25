// Job Docket — voice pipeline.
//
// The phone records audio and sends it here. This function:
//   1. Sends the audio to Deepgram (speech-to-text), boosted with a list of
//      marine/trade terms so brand names and model numbers come through
//      right instead of getting mangled.
//   2. Passes the raw transcript to Claude, which tidies grammar and fixes
//      likely mis-hearings, without inventing or dropping any detail.
//
// `field` in the request says what's being dictated: "jobRef", "notes",
// "part" or "clientNote" tidy up a single field (see CLEANUP_PROMPTS below).
// "full" is the "Dictate the whole job" button — one recording covering the
// job, the work done, and any parts, which Claude splits into the three
// fields at once (see FULL_JOB_PROMPT below).
//
// Requires three environment variables, set in Netlify's dashboard under
// Site configuration -> Environment variables (never in the code, never in
// git):
//   DEEPGRAM_API_KEY    — from deepgram.com
//   ANTHROPIC_API_KEY   — from console.anthropic.com
//   APP_SECRET          — a PIN you make up yourself (e.g. a 6-digit
//                          number); staff enter the same PIN once in the
//                          app. This just stops a stranger who stumbles on
//                          the app's web address from running up your bill —
//                          it isn't meant to be strong security, so don't
//                          reuse a real password for it.

const KEYTERMS = [
  "Raymarine", "B&G", "Furuno", "Garmin", "Simrad", "Navico", "Fusion",
  "H5000", "H-Link", "Expedition", "autopilot", "chartplotter",
  "AIS", "VHF", "NMEA 2000", "NMEA", "transducer", "radome",
  "wind instrument", "fluxgate compass", "GPS antenna", "Tradify"
];

const CLEANUP_PROMPTS = {
  jobRef: "This is a job or vessel reference, dictated by a marine technician and heard by speech recognition, which may have mis-transcribed it. Return ONLY the corrected job reference or vessel name as a short line — no extra commentary, no quotes, no explanation. Fix obvious mis-hearings of boat names and marine equipment brands (Raymarine, B&G, Furuno, Garmin, Simrad, Navico, etc). If it already looks right, return it unchanged.",

  notes: "You are turning a marine technician's dictated field note into the job note that goes straight into Tradify and is later read by the customer on their invoice as the description of work performed. The dictation was heard by speech recognition and may have mis-transcribed some of it.\n\n" +
    "Rewrite it as a professional trade job note:\n" +
    "- Plain factual trade language, past tense, describing what was done.\n" +
    "- Do not write in the first person — no \"I checked\" or \"I replaced\". Lead straight with the work: \"Checked...\", \"Replaced...\", \"Tested and confirmed...\".\n" +
    "- Fix obvious mis-hearings of marine equipment brands and model numbers (Raymarine, B&G, H5000, Furuno, Garmin, Simrad, Navico, NMEA 2000, autopilot, chartplotter, AIS, VHF, transducer, radome, etc) and correct their capitalisation.\n" +
    "- Tidy grammar, punctuation and sentence structure. Short, clear sentences — the way a tidy line item reads, not casual speech (drop filler like \"basically\", \"so yeah\", \"just went and\").\n" +
    "- Keep every fact, measurement, part and observation from the original. Never invent, assume, embellish or drop a detail that was said, and never add a price, a total, a greeting or a sign-off.\n" +
    "- If the technician noted a problem, a recommendation, or that something still needs follow-up, keep that clearly, in the same factual tone.\n\n" +
    "Return ONLY the finished note text.",

  part: "This is the name of a boat part or piece of marine equipment, dictated by a technician and possibly mis-heard by speech recognition. Return ONLY the corrected part name, written the way it should read on a job note or invoice line (proper capitalisation of brand names), nothing else. Fix obvious mis-hearings of marine equipment brands (Raymarine, B&G, Furuno, Garmin, Simrad, Navico, etc).",

  clientNote: "This is a short note from a marine technician meant to be read directly by the customer, for example alongside their invoice. It was heard by speech recognition and may have mis-transcribed some of it. Clean it up: fix obvious mis-hearings of marine equipment brands and model names, correct grammar and punctuation, and keep a friendly, professional tone a customer can read directly. Keep every fact and recommendation from the original — never invent or drop details. Don't add a greeting or sign-off unless one was actually said. Return ONLY the cleaned text."
};

// Used for the "Dictate the whole job" button: one recording that covers the
// job reference, the start/finish time, the work done, and any parts, all in
// one go. Claude splits it into the right fields instead of the person doing
// that by hand.
const FULL_JOB_PROMPT = "You are extracting structured job information from a marine technician's single dictated recording, heard by speech recognition, which may have mis-transcribed some of it. The technician spoke roughly in this order: the job or vessel reference, then the start and finish time they worked on it, then a description of the work performed, then optionally a list of parts used — but they may not have said all of these, or said them in a different order.\n\n" +
  "Extract exactly these five things:\n" +
  "- jobRef: the job or vessel reference, as a short line. Empty string if none was said.\n" +
  "- startTime: the time they started the job, converted to 24-hour \"HH:MM\" format (e.g. \"eight am\" -> \"08:00\", \"quarter past two\" -> \"14:15\", \"ten thirty\" -> \"10:30\"). Empty string if no start time was said.\n" +
  "- finishTime: the time they finished the job, in the same 24-hour \"HH:MM\" format. Empty string if no finish time was said.\n" +
  "- notes: the work description, rewritten as a professional trade job note that will go straight into Tradify and later be read by the customer on their invoice as the description of work performed — plain factual trade language, past tense, no first person (\"Replaced...\" not \"I replaced...\"), brand and model names corrected and properly capitalised (Raymarine, B&G, H5000, Furuno, Garmin, Simrad, Navico, NMEA 2000, autopilot, chartplotter, AIS, VHF, transducer, radome, etc), tidy grammar, casual filler dropped. Do not restate the start/finish time here — that goes in its own fields. Keep every fact, measurement, part and observation that was said — never invent, embellish or drop a detail, never add a price or a greeting. Empty string if no work description was said.\n" +
  "- parts: an array of parts used, each as {\"desc\": \"...\", \"qty\": \"...\"} with proper brand capitalisation in desc, and qty as a plain number string (default \"1\" if a quantity wasn't stated). Empty array if none were mentioned.\n\n" +
  "Return ONLY a single JSON object with exactly these five keys and no others — no markdown fences, no commentary before or after it. Example shape: {\"jobRef\":\"...\",\"startTime\":\"08:00\",\"finishTime\":\"10:15\",\"notes\":\"...\",\"parts\":[{\"desc\":\"...\",\"qty\":\"1\"}]}";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const deepgramKey = process.env.DEEPGRAM_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const appSecret = process.env.APP_SECRET;

  if (!deepgramKey || !anthropicKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "The server is missing its API keys. Set DEEPGRAM_API_KEY and ANTHROPIC_API_KEY in Netlify, then redeploy." })
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

  // Diagnostic-only path: POST {"test":"claude"} to check the Anthropic key
  // directly, without needing real audio — bypasses Deepgram entirely and
  // reports the raw Anthropic response so a bad key is easy to spot.
  if (payload && payload.test === "claude") {
    try {
      const testRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 50,
          system: "Reply with the single word OK.",
          messages: [{ role: "user", content: "test" }]
        })
      });
      const testText = await testRes.text();
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anthropicStatus: testRes.status, anthropicBody: testText.slice(0, 500) })
      };
    } catch (e) {
      return { statusCode: 200, body: JSON.stringify({ testError: String(e && e.message) }) };
    }
  }

  const { audioBase64, mimeType, field } = payload || {};
  if (!audioBase64 || !mimeType) {
    return { statusCode: 400, body: JSON.stringify({ error: "No audio received." }) };
  }

  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audioBase64, "base64");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Couldn't read the audio." }) };
  }

  // 1. Speech to text, biased toward marine/trade vocabulary.
  const keytermQuery = KEYTERMS.map((k) => "keyterm=" + encodeURIComponent(k)).join("&");
  const dgUrl = "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&" + keytermQuery;

  let transcript = "";
  try {
    const dgRes = await fetch(dgUrl, {
      method: "POST",
      headers: {
        "Authorization": "Token " + deepgramKey,
        "Content-Type": mimeType
      },
      body: audioBuffer
    });
    if (!dgRes.ok) {
      const errText = await dgRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: "Speech-to-text failed: " + errText.slice(0, 300) }) };
    }
    const dgJson = await dgRes.json();
    const alt = dgJson &&
      dgJson.results &&
      dgJson.results.channels &&
      dgJson.results.channels[0] &&
      dgJson.results.channels[0].alternatives &&
      dgJson.results.channels[0].alternatives[0];
    transcript = (alt && alt.transcript) || "";
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "Couldn't reach the speech-to-text service." }) };
  }

  if (!transcript.trim()) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(field === "full" ? { transcript: "", jobRef: "", startTime: "", finishTime: "", notes: "", parts: [] } : { transcript: "", cleaned: "" })
    };
  }

  async function askClaude(system, maxTokens) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system: system,
        messages: [{ role: "user", content: transcript }]
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("Anthropic API error " + res.status + ": " + errText.slice(0, 500));
      return null;
    }
    const json = await res.json();
    const textBlock = Array.isArray(json.content) && json.content.find((b) => b.type === "text");
    return (textBlock && textBlock.text && textBlock.text.trim()) || null;
  }

  // 2a. "Dictate the whole job": one recording, split into
  // job/startTime/finishTime/notes/parts.
  if (field === "full") {
    function validTime(s) {
      return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim()) ? s.trim() : "";
    }
    let jobRef = "", startTime = "", finishTime = "", notes = "", parts = [];
    try {
      const raw = await askClaude(FULL_JOB_PROMPT, 700);
      if (raw) {
        const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        const parsed = JSON.parse(jsonText);
        jobRef = typeof parsed.jobRef === "string" ? parsed.jobRef.trim() : "";
        startTime = validTime(parsed.startTime);
        finishTime = validTime(parsed.finishTime);
        notes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
        parts = Array.isArray(parsed.parts)
          ? parsed.parts
              .filter((p) => p && p.desc)
              .map((p) => ({ desc: String(p.desc).trim(), qty: String(p.qty || "1").trim() }))
          : [];
      }
    } catch (e) {
      console.error("Full-job JSON split failed: " + (e && e.message));
      // Splitting failed — fall through and hand back the raw transcript as
      // the notes field below, so nothing dictated gets lost.
    }
    if (!jobRef && !startTime && !finishTime && !notes && !parts.length) notes = transcript;
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: transcript, jobRef: jobRef, startTime: startTime, finishTime: finishTime, notes: notes, parts: parts })
    };
  }

  // 2b. A single field — tidy it up, fixing likely mis-heard jargon, keeping every fact.
  const instruction = CLEANUP_PROMPTS[field] || CLEANUP_PROMPTS.notes;
  let cleaned = transcript;
  try {
    const result = await askClaude(instruction, 400);
    if (result) cleaned = result;
    // If this call fails for any reason, the raw transcript still goes back
    // below rather than losing the dictation entirely.
  } catch (e) {
    console.error("Single-field Claude cleanup failed: " + (e && e.message));
    // network hiccup — fall through with the raw transcript
  }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transcript: transcript, cleaned: cleaned })
  };
};
