// MediCall AI — Twilio + Deepgram Streaming Voice Agent with safety IVR menu (hardened)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.urlencoded({ extended: false }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio" });

const PORT = process.env.PORT || 3001;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "PASTE_YOUR_DEEPGRAM_KEY_HERE";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "PASTE_YOUR_GROQ_KEY_HERE";

// MUST exactly match a Verified Caller ID in Twilio, including +91 prefix, no spaces
const RECEPTION_NUMBER = "+918591981281";

const SYSTEM_PROMPT = `You are MediCall AI, a professional hospital calling agent for City General Hospital, Mumbai.
The caller has already told the menu they want appointment help, so focus on: booking appointments,
checking doctor availability, and general non-urgent hospital questions (OPD timings, departments).
Be warm, concise — 1-2 short sentences max, since this is a PHONE CALL and will be spoken aloud.
Hospital info: OPD hours 8am-8pm, Emergency 24/7.
Doctors: Dr. Priya Sharma (Cardiology, Mon/Wed/Fri), Dr. Rajan Mehta (Orthopedics, Tue/Thu/Sat),
Dr. Anil Kumar (Neurology), Dr. Fatima Shaikh (Dermatology).
Keep responses SHORT and natural for speech. If the caller speaks in Hindi or Hinglish,
respond in natural Hinglish like a real Indian hospital receptionist would.`;

app.post("/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" numDigits="1" action="/voice/menu" method="POST" timeout="6" language="en-IN">
    <Say voice="Polly.Aditi">Thank you for calling City General Hospital.
    For a medical emergency, press 1.
    To book or ask about an appointment, press 2.
    To speak directly with our reception, press 3.</Say>
  </Gather>
  <Say voice="Polly.Aditi">We didn't get your selection. Goodbye.</Say>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/voice/menu", (req, res) => {
  const digit = req.body.Digits;
  const speech = (req.body.SpeechResult || "").toLowerCase();
  console.log("Menu selection — digit:", digit, "| speech:", speech);

  const isEmergency = digit === "1" || speech.includes("emergency") || speech.includes("urgent");
  const isReception = digit === "3" || speech.includes("reception") || speech.includes("human");
  const isAppointment = digit === "2" || speech.includes("appointment");

  let twiml;

  if (isEmergency) {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">Connecting you to our team right now. Please stay on the line.</Say>
  <Dial timeout="20" action="/voice/dial-status">
    <Number>${RECEPTION_NUMBER}</Number>
  </Dial>
</Response>`;
  } else if (isReception) {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">Connecting you to our reception.</Say>
  <Dial timeout="20" action="/voice/dial-status">
    <Number>${RECEPTION_NUMBER}</Number>
  </Dial>
</Response>`;
  } else if (isAppointment) {
    const host = req.headers.host;
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio" />
  </Connect>
</Response>`;
  } else {
    // Nothing recognized — replay the menu instead of silently failing
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">Sorry, I didn't get that.</Say>
  <Redirect>/voice</Redirect>
</Response>`;
  }

  res.type("text/xml").send(twiml);
});

// Catches the case where <Dial> fails (e.g. unverified number on trial account)
app.post("/voice/dial-status", (req, res) => {
  const status = req.body.DialCallStatus;
  console.log("Dial status:", status);

  if (status === "completed") {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  } else {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi">We could not connect your call right now. Please call back, or dial 112 if this is an emergency.</Say>
  <Hangup/>
</Response>`;
    res.type("text/xml").send(twiml);
  }
});

app.get("/", (req, res) => {
  res.send("MediCall AI Deepgram voice server is running.");
});

async function askAI(conversation) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: conversation, max_tokens: 150 }),
    });
    const data = await res.json();
    if (!data.choices) {
      console.error("Groq error response:", JSON.stringify(data));
      return "I am having a technical issue. Let me get someone to help you.";
    }
    return data.choices[0].message.content;
  } catch (err) {
    console.error("Groq fetch failed:", err.message);
    return "I am having a technical issue. Let me get someone to help you.";
  }
}

async function textToSpeech(text) {
  try {
    const res = await fetch(
      "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none",
      {
        method: "POST",
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }
    );
    if (!res.ok) {
      console.error("Deepgram TTS failed with status:", res.status, await res.text());
      return Buffer.alloc(0);
    }
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer);
  } catch (err) {
    console.error("Deepgram TTS fetch failed:", err.message);
    return Buffer.alloc(0);
  }
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio stream connected");

  let streamSid = null;
  let conversation = [{ role: "system", content: SYSTEM_PROMPT }];
  let deepgramWs = null;
  let isSpeaking = false;
  let failedAttempts = 0;
  let closed = false;

  function connectDeepgram() {
    deepgramWs = new WebSocket(
      "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&language=en-IN&smart_format=true&endpointing=400&keywords=chest:2&keywords=pain:2&keywords=appointment:2&keywords=doctor:2",
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );

    deepgramWs.on("open", () => console.log("Deepgram connected"));

    deepgramWs.on("message", async (msg) => {
      try {
        const data = JSON.parse(msg);
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        const isFinal = data.is_final;

        if (transcript && isFinal && transcript.trim().length > 0 && !isSpeaking && !closed) {
          console.log("Patient said:", transcript);
          conversation.push({ role: "user", content: transcript });

          isSpeaking = true;
          const reply = await askAI(conversation);
          conversation.push({ role: "assistant", content: reply });
          console.log("AI reply:", reply);

          if (reply.includes("technical issue")) {
            failedAttempts++;
          } else {
            failedAttempts = 0;
          }

          if (failedAttempts >= 2 && !closed) {
            closed = true;
            const handoff = "Let me connect you to our reception team right away.";
            const audioBuffer = await textToSpeech(handoff);
            if (audioBuffer.length > 0) sendAudioToTwilio(audioBuffer);
            setTimeout(() => {
              try { twilioWs.close(); } catch (e) {}
            }, 2500);
            return;
          }

          const audioBuffer = await textToSpeech(reply);
          if (audioBuffer.length > 0) sendAudioToTwilio(audioBuffer);
          isSpeaking = false;
        }
      } catch (err) {
        console.error("Error handling Deepgram message:", err.message);
        isSpeaking = false;
      }
    });

    deepgramWs.on("error", (err) => console.error("Deepgram WS error:", err.message));
    deepgramWs.on("close", (code, reason) => console.log("Deepgram WS closed:", code, reason.toString()));
  }

  function sendAudioToTwilio(buffer) {
    try {
      const chunkSize = 320;
      for (let i = 0; i < buffer.length; i += chunkSize) {
        const chunk = buffer.slice(i, i + chunkSize);
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunk.toString("base64") } }));
        }
      }
    } catch (err) {
      console.error("Error sending audio to Twilio:", err.message);
    }
  }

  async function speakGreeting() {
    const greeting = "Great, I can help with appointments. What would you like to do?";
    conversation.push({ role: "assistant", content: greeting });
    const audioBuffer = await textToSpeech(greeting);
    if (audioBuffer.length > 0) sendAudioToTwilio(audioBuffer);
  }

  twilioWs.on("message", async (message) => {
    try {
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
            deepgramWs.send(Buffer.from(data.media.payload, "base64"));
          }
          break;
        case "stop":
          console.log("Stream stopped");
          if (deepgramWs) deepgramWs.close();
          break;
      }
    } catch (err) {
      console.error("Error handling Twilio message:", err.message);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio stream closed");
    closed = true;
    if (deepgramWs) deepgramWs.close();
  });

  twilioWs.on("error", (err) => console.error("Twilio WS error:", err.message));
});

server.listen(PORT, () => {
  console.log(`MediCall AI voice server with safety IVR running on port ${PORT}`);
});
