// MediCall AI — Twilio + Deepgram Streaming Voice Agent
// Real-time speech-to-text (Deepgram) -> AI brain (Groq) -> text-to-speech (Deepgram Aura) -> back to caller

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio" });

const PORT = process.env.PORT || 3001;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "PASTE_YOUR_DEEPGRAM_KEY_HERE";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "PASTE_YOUR_GROQ_KEY_HERE";

const SYSTEM_PROMPT = `You are MediCall AI, a professional hospital calling agent for City General Hospital, Mumbai.
You help callers with: appointment booking, general hospital inquiries (OPD timings, departments, visiting hours),
patient follow-ups, and lab result guidance.
Be warm, concise — 1-2 short sentences max, since this is a PHONE CALL and will be spoken aloud.
For emergencies (chest pain, breathing difficulty, severe bleeding), immediately advise the caller
to hang up and dial 112 for an ambulance.
Hospital info: OPD hours 8am-8pm, Emergency 24/7.
Doctors: Dr. Priya Sharma (Cardiology, Mon/Wed/Fri), Dr. Rajan Mehta (Orthopedics, Tue/Thu/Sat),
Dr. Anil Kumar (Neurology), Dr. Fatima Shaikh (Dermatology).
Keep responses SHORT and natural for speech.`;

app.post("/voice", (req, res) => {
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio" />
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.get("/", (req, res) => {
  res.send("MediCall AI Deepgram voice server is running.");
});

async function askAI(conversation) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: conversation,
      max_tokens: 150,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Sorry, could you repeat that?";
}

async function textToSpeech(text) {
  const res = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio stream connected");

  let streamSid = null;
  let conversation = [{ role: "system", content: SYSTEM_PROMPT }];
  let deepgramWs = null;
  let isSpeaking = false;

  function connectDeepgram() {
    deepgramWs = new WebSocket(
      "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&language=en-IN&smart_format=true&endpointing=400",
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );

    deepgramWs.on("open", () => console.log("Deepgram connected"));

    deepgramWs.on("message", async (msg) => {
      const data = JSON.parse(msg);
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      const isFinal = data.is_final;

      if (transcript && isFinal && transcript.trim().length > 0 && !isSpeaking) {
        console.log("Patient said:", transcript);
        conversation.push({ role: "user", content: transcript });

        isSpeaking = true;
        const reply = await askAI(conversation);
        conversation.push({ role: "assistant", content: reply });
        console.log("AI reply:", reply);

        const audioBuffer = await textToSpeech(reply);
        sendAudioToTwilio(audioBuffer);
        isSpeaking = false;
      }
    });

    deepgramWs.on("error", (err) => console.error("Deepgram error:", err));
  }

  function sendAudioToTwilio(buffer) {
    const chunkSize = 320;
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.slice(i, i + chunkSize);
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: chunk.toString("base64") },
        })
      );
    }
  }

  async function speakGreeting() {
    const greeting = "Thank you for calling City General Hospital. This is MediCall AI. How can I help you today?";
    conversation.push({ role: "assistant", content: greeting });
    const audioBuffer = await textToSpeech(greeting);
    sendAudioToTwilio(audioBuffer);
  }

  twilioWs.on("message", async (message) => {
    const data = JSON.parse(message);

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        console.log("Stream started:", streamSid);
        connectDeepgram();
        setTimeout(speakGreeting, 500);
        break;

      case "media":
        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
          const audio = Buffer.from(data.media.payload, "base64");
          deepgramWs.send(audio);
        }
        break;

      case "stop":
        console.log("Stream stopped");
        if (deepgramWs) deepgramWs.close();
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio stream closed");
    if (deepgramWs) deepgramWs.close();
  });
});

server.listen(PORT, () => {
  console.log(`MediCall AI Deepgram voice server running on port ${PORT}`);
});
