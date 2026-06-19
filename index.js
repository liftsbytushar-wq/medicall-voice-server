// MediCall AI — Twilio Voice Webhook Server
// This server receives calls from Twilio, converts speech to text,
// asks the AI agent for a response, and speaks it back to the caller.

const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "PASTE_YOUR_GROQ_KEY_HERE";

// ─── System prompt for the hospital AI agent ─────────────────────────────────
const SYSTEM_PROMPT = `You are MediCall AI, a professional hospital calling agent for City General Hospital, Mumbai.
You help callers with: appointment booking, general hospital inquiries (OPD timings, departments, visiting hours),
patient follow-ups, and lab result guidance.
Be warm, concise — 1-3 short sentences max, since this is a PHONE CALL and will be read aloud.
For emergencies (chest pain, breathing difficulty, severe bleeding, etc.), immediately advise the caller
to hang up and dial 112 for an ambulance, then offer to also note it down for the hospital.
Hospital info: OPD hours 8am-8pm, Emergency 24/7.
Doctors available: Dr. Priya Sharma (Cardiology, Mon/Wed/Fri), Dr. Rajan Mehta (Orthopedics, Tue/Thu/Sat),
Dr. Anil Kumar (Neurology), Dr. Fatima Shaikh (Dermatology).
Keep responses SHORT and natural for speech — avoid bullet points, lists, or long sentences.`;

// In-memory conversation store, keyed by Twilio CallSid
const conversations = {};

// ─── Helper: ask Groq for a reply ─────────────────────────────────────────────
async function askAI(callSid, userText) {
  if (!conversations[callSid]) {
    conversations[callSid] = [{ role: "system", content: SYSTEM_PROMPT }];
  }
  conversations[callSid].push({ role: "user", content: userText });

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: conversations[callSid],
      max_tokens: 200,
    }),
  });

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content || "I'm sorry, I didn't catch that. Could you repeat?";
  conversations[callSid].push({ role: "assistant", content: reply });
  return reply;
}

// ─── Escape special XML characters for TwiML <Say> ───────────────────────────
function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Incoming call — first webhook Twilio hits ───────────────────────────────
app.post("/voice", (req, res) => {
  const greeting = "Thank you for calling City General Hospital. This is MediCall AI. How can I help you today?";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
<Gather input="speech" action="/voice/respond" method="POST" speechTimeout="3" language="en-IN" speechModel="phone_call" enhanced="true">
    <Say voice="Polly.Aditi">${escapeXml(greeting)}</Say>
  </Gather>
  <Say voice="Polly.Aditi">We didn't hear anything. Goodbye.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ─── Handles each turn of the conversation ───────────────────────────────────
app.post("/voice/respond", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";

  let aiReply;
  try {
    aiReply = speechResult
      ? await askAI(callSid, speechResult)
      : "Sorry, could you say that again?";
  } catch (err) {
    console.error("AI error:", err);
    aiReply = "Sorry, I'm having trouble right now. Please try again later.";
  }

  // Check if AI wants to end the call (simple heuristic)
  const lower = aiReply.toLowerCase();
  const shouldEnd = lower.includes("goodbye") || lower.includes("have a great day") || lower.includes("take care");

  const twiml = shouldEnd
    ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">${escapeXml(aiReply)}</Say>
  <Hangup/>
</Response>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/voice/respond" method="POST" speechTimeout="3" language="en-IN" speechModel="phone_call" enhanced="true">
    <Say voice="Polly.Aditi">${escapeXml(aiReply)}</Say>
  </Gather>
  <Say voice="Polly.Aditi">Goodbye.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ─── Cleanup conversation when call ends (Twilio status callback, optional) ──
app.post("/voice/status", (req, res) => {
  const callSid = req.body.CallSid;
  delete conversations[callSid];
  res.sendStatus(200);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("MediCall AI voice server is running.");
});

app.listen(PORT, () => {
  console.log(`MediCall AI voice server running on port ${PORT}`);
});
