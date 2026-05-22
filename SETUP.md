# AutoTurnitin WhatsApp Bot — Full Setup Guide

## How it works

```
User sends PDF/DOCX on WhatsApp
         ↓
Twilio receives & calls your webhook
         ↓
Railway backend downloads the file
         ↓
Puppeteer logs in & submits to Turnitin
         ↓
Polls until similarity report is ready
         ↓
PDF screenshot of report generated
         ↓
Twilio sends PDF report back to user
```

---

## Prerequisites

- Twilio account (free trial works for sandbox)
- Turnitin instructor account (with a class + assignment pre-created)
- Railway account (free tier available)
- Git installed locally

---

## Step 1: Set up Turnitin

1. Log in to **turnitin.com** as an instructor
2. Create a class (e.g. "AutoCheck Class")
3. Inside the class, create an assignment:
   - Title: "AutoCheck Assignment"
   - Allow late submissions: ✅ Yes
   - Store submissions: Standard (for future comparison) or No repository
4. Note the **class_id** and **assign_id** from the URL bar when viewing the assignment
   - URL looks like: `turnitin.com/...?class_id=XXXXXX&assign_id=YYYYYY`
5. Also note your **account_id** (visible in your profile/URL)

---

## Step 2: Set up Twilio WhatsApp

### Option A: Sandbox (free, for testing)
1. Go to Twilio Console → Messaging → Try it out → Send a WhatsApp message
2. Follow instructions to join the sandbox with your phone
3. Note your sandbox number: `whatsapp:+14155238886`

### Option B: Production WhatsApp Business
1. Apply for WhatsApp Business API approval in Twilio Console
2. Get a dedicated number after approval (takes 1–7 days)

### Configure Webhook (do this after Step 3):
- Go to Twilio Console → Messaging → Settings → WhatsApp sandbox settings
- Set "When a message comes in" to: `https://YOUR-APP.up.railway.app/webhook/whatsapp`
- Method: HTTP POST

---

## Step 3: Deploy to Railway

### 3a. Prepare your code

```bash
git clone https://github.com/YOUR_USERNAME/autoturnitin-bot
cd autoturnitin-bot/backend
```

Or create a new repo with these files.

### 3b. Deploy

1. Go to **railway.app** and create a new project
2. Connect your GitHub repo  
   OR use Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```

### 3c. Set environment variables in Railway dashboard

Go to your Railway service → Variables tab, add:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | From Twilio Console |
| `TWILIO_AUTH_TOKEN` | From Twilio Console |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+14155238886` |
| `TURNITIN_EMAIL` | Your Turnitin login email |
| `TURNITIN_PASSWORD` | Your Turnitin password |
| `TURNITIN_ACCOUNT_ID` | From Turnitin URL |
| `TURNITIN_CLASS_ID` | From Turnitin URL |
| `TURNITIN_ASSIGN_ID` | From Turnitin URL |
| `PUBLIC_BASE_URL` | `https://YOUR-APP.up.railway.app` |

Railway automatically sets `PORT`.

### 3d. Get your public URL

After deploy, Railway shows your URL in the dashboard.  
It looks like: `https://autoturnitin-bot-production.up.railway.app`

Update `PUBLIC_BASE_URL` in Railway env vars with this URL.

---

## Step 4: Connect Twilio Webhook

1. Back in Twilio Console → WhatsApp Sandbox Settings
2. Set webhook URL to: `https://YOUR-APP.up.railway.app/webhook/whatsapp`
3. Save

---

## Step 5: Test it

1. Send your Twilio sandbox number a WhatsApp message (any text)
2. It should reply asking you to send a document
3. Send a PDF or DOCX file
4. Wait 3–5 minutes
5. Receive the Turnitin PDF report back

---

## Turnitin Selector Guide

If Turnitin's UI changes, you may need to update CSS selectors in `server.js`.

To find the correct selectors:
1. Open Chrome DevTools on Turnitin
2. Right-click element → Inspect
3. Find a unique `id` or `class` attribute
4. Update the relevant `page.waitForSelector(...)` call in `server.js`

Key selectors to verify:
- Login form: `#email`, `#password`, `#login-button`
- Assignment link: `a[href*="assign_id="]`
- Submit button: look for "Submit Paper" button
- File input: `input[type="file"]`
- Report link: link containing similarity percentage

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't reply | Check webhook URL in Twilio; verify Railway is running (`/health` endpoint) |
| Login fails | Verify TURNITIN_EMAIL and PASSWORD env vars; Turnitin may require 2FA (disable it) |
| Report never arrives | Increase timeout in `pollForReport`; check Railway logs |
| Puppeteer crashes | Railway's Dockerfile installs Chromium — ensure Dockerfile is being used |
| File too large | Twilio media files are max 16MB; Turnitin accepts up to 100MB |

---

## Logs

View real-time logs in Railway dashboard → Deployments → View Logs

Or with CLI:
```bash
railway logs
```

---

## Cost Estimate

| Service | Cost |
|---|---|
| Twilio WhatsApp messages | ~$0.005 per message sent/received |
| Railway (Hobby plan) | $5/month |
| Turnitin | Included in your existing subscription |
| **Total** | ~$5–10/month for typical usage |

---

## Security Notes

- Never commit `.env` to Git — use Railway's environment variable UI
- The Turnitin account used should be a dedicated automation account
- Temporary report PDFs are auto-deleted after 30 minutes
- Consider adding phone number allowlisting for private use
