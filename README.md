# MediCall AI — Voice Webhook Server

This is a tiny server that connects Twilio phone calls to your Groq-powered AI hospital agent.

## How it works

1. Patient calls your Twilio number
2. Twilio sends the call to `/voice` on this server
3. Server greets the patient and listens (Twilio converts speech to text automatically)
4. Patient's words get sent to `/voice/respond`
5. Server asks Groq (Llama 3.3) for a reply
6. Server sends back TwiML that makes Twilio speak the reply
7. Loops until the patient hangs up or the AI says goodbye

## Deploy to Railway (free tier)

1. Go to **railway.app** and sign up (free, GitHub login works)
2. Click **New Project → Deploy from GitHub repo** (or **Empty Project** then upload these files)
3. Add an environment variable:
   - `GROQ_API_KEY` = your Groq key (starts with `gsk_...`)
4. Railway will detect `package.json` and run `npm start` automatically
5. Once deployed, Railway gives you a public URL like:
   `https://medicall-voice-production.up.railway.app`

## Connect to Twilio

1. Go to **Twilio Console → Phone Numbers → Manage → Active Numbers**
2. Click your phone number
3. Under **Voice Configuration**, set:
   - **A call comes in** → Webhook → `https://YOUR-RAILWAY-URL.up.railway.app/voice` → HTTP POST
4. Save

## Test it

Call your Twilio number from your verified phone — MediCall AI should answer!

## Notes

- Conversations are stored in memory per call (CallSid). They reset when the server restarts.
- The voice used is `Polly.Aditi` — an Indian-English female voice built into Twilio (no extra cost).
- For emergencies, the AI is instructed to tell callers to dial 112.
