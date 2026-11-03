# speed-to-lead-demo

A small demo of speed-to-lead for local service shops: a new lead (web form or missed call) gets a text back immediately, a silent lead gets one follow-up, and STOP is honored. Zero dependencies.

Demo video: [recording/speed-to-lead-demo.mp4](recording/speed-to-lead-demo.mp4) (60 seconds).

## Run it

```
node server.js          # http://127.0.0.1:3000 (Node 18+)
node test.js            # backend checks
NODE_PATH=$(npm root -g) node record.js   # re-record the video (needs Playwright, Chromium, ffmpeg)
```

## Set your business name

Open http://127.0.0.1:3000/settings, enter the business name and phone number, and save. They are written to `config.json` (git-ignored) and the name is used in every text-back, follow-up, acknowledgement and opt-out confirmation. Until you save, texts use the placeholder "Demo HVAC Co.".

Environment variables: `PORT` (3000), `CONFIG_PATH` (`./config.json`), `BUSINESS_NAME` (placeholder used before any settings are saved), `FOLLOWUP_DELAY_MS` (300000).

## Limits

- **SMS is simulated.** By default no real text is sent. Response time shows as "< 1 s" because nothing leaves the machine; real carriers add delivery time.
- **Twilio is untested.** `sms.js` sends through Twilio when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` are set, but it has never been run against a real account. Real US texting also needs A2P 10DLC registration and opt-in/consent compliance.
- **No webhooks.** Inbound replies and missed-call triggers are simulated through `POST /api/sms/inbound` and `POST /api/missed-call`; nothing is wired to a phone provider.
- **In-memory only.** Leads and messages are lost when the server restarts.
- **The business phone number is only stored and displayed.** It does not change which number texts are sent from (Twilio uses `TWILIO_FROM`).
- **The settings page has no login.** The server only listens on 127.0.0.1; add authentication before exposing it.
- "Demo HVAC Co." is a placeholder, not a real business.
