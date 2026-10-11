# BurnStop

Detect → Prioritise → Propose → Approve → Act → Verify → Escalate, for stubble burning in Punjab and Haryana.

**Real:** NASA FIRMS VIIRS fire detections (live + archived seasons).
**Simulated, and labelled so in the UI:** machines, hiring centres, farmers (no usable public dataset). The Telegram chat is your own phone standing in for farmer, operator and officer.
**Not a trained model:** risk is a transparent weighted score. `scripts/backtest.mjs` measures it on a held-out season.

## AWS services (all free-plan eligible)
Lambda, API Gateway (HTTP API), DynamoDB (5/5 provisioned, inside always-free), EventBridge (schedules), Polly (Hindi voice), SNS (email escalation), CloudFormation/SAM (deploy), CloudShell (where you deploy from).
Not used: Amazon Translate (paid-plan only, so Hindi/Punjabi are hand-written templates), Bedrock (optional, off).

## Try it locally first (no AWS, 1 minute)
```
node scripts/make-synthetic.mjs /tmp/bs        # FAKE test data, only to see the UI
FIRES_DIR=/tmp/bs node scripts/test.mjs         # end-to-end self-test
FIRES_DIR=/tmp/bs node scripts/local.mjs        # http://localhost:8080  PIN 1234
```

## Deploy (do this in AWS CloudShell, so nothing needs installing)

1. **FIRMS key**: https://firms.modaps.eosdis.nasa.gov/api/ → "Get MAP_KEY" (free, by email).
2. **Telegram bot**: in Telegram open @BotFather → `/newbot` → copy the token. Open your new bot and press Start. Then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `"chat":{"id": NUMBER}`.
3. **AWS**: region **Asia Pacific (Mumbai) ap-south-1**, open **CloudShell** (icon in the top bar). Upload `burnstop.zip` (Actions → Upload file), then:
```
unzip burnstop.zip && cd burnstop
node -v                      # needs 18 or newer
sam --version || pip3 install --user aws-sam-cli
node scripts/fetch-history.mjs YOUR_FIRMS_KEY     # real 2024 + 2025 seasons, takes a few minutes
node scripts/backtest.mjs 2025                    # writes src/data/backtest.json (real evidence for your video)
```
Note: delete `/tmp/bs`-style synthetic files if you copied any into `src/data`. Only `fires-2024.json`, `fires-2025.json`, `backtest.json` from the real fetch belong there.

4. **Build and deploy**
```
sam build
sam deploy --stack-name burnstop --region ap-south-1 --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset \
  --parameter-overrides FirmsKey="YOUR_FIRMS_KEY" OfficerPin="choose-a-pin" OfficerEmail="you@example.com" \
  TelegramToken="YOUR_BOT_TOKEN" TelegramChatId="YOUR_CHAT_ID" WebhookSecret="some_secret-123"
```
5. Copy `AppUrl` from the output. Check your email and **click AWS's SNS confirmation link** (otherwise escalation emails never arrive).
6. **Connect the Done button**:
```
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=<WebhookUrl>&secret_token=some_secret-123"
```
7. Open `AppUrl`, press **Ingest FIRMS now**, then **Refresh proposals**.

## Demo flow for the video (3 minutes)
1. Show AWS console briefly: Lambda, DynamoDB table, EventBridge rules, Polly.
2. Dashboard LIVE: map of flagged cells, "why" bullets, machines.
3. Replay a real day (e.g. 2025-11-02): Start → Approve top plan → Telegram messages and Hindi voice arrive → tap Done on the phone.
4. Next day ▶ → verification runs; show a FAILED escalation (email + Telegram).
5. Show the backtest evidence card and say plainly what is simulated.

## Honest limits (put these in the writeup)
- Cells are ~5 km grid squares labelled with the nearest reference town, not villages or fields.
- A satellite detection is not proof a farmer burned a field; no detection is not proof they did not.
- India-Pakistan border and state boundary filtering is approximate (`src/geo.js`).
- Punjabi text should be reviewed by a native speaker; Polly has no Punjabi voice, so audio is Hindi.
- Machine travel time uses stated assumptions (`src/match.js`). Sowing cut-off assumed 15 Nov (`src/risk.js`).

## Cost
Everything runs inside free-plan eligible services and credits. Set a budget alert (Billing → Budgets) and delete the stack afterwards with `sam delete --stack-name burnstop --region ap-south-1`.
