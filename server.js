const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const multer = require('multer');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ──────────────────────────────────────────────
//  STEP 1: Twilio WhatsApp Webhook
//  Receives inbound messages from WhatsApp users
// ──────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const from     = req.body.From;      // e.g. "whatsapp:+91XXXXXXXXXX"
  const mediaUrl = req.body.MediaUrl0; // URL of the attached file
  const mediaType= req.body.MediaContentType0;
  const body     = (req.body.Body || '').trim();

  console.log(`[WEBHOOK] From: ${from} | Media: ${mediaUrl} | Type: ${mediaType}`);

  // If no file attached, prompt user
  if (!mediaUrl) {
    await sendWhatsApp(from,
      '👋 Welcome to AutoTurnitin!\n\nPlease upload your document (PDF or DOCX) and I will check it for plagiarism automatically.'
    );
    return res.sendStatus(200);
  }

  // Validate file type
  const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowed.some(t => mediaType?.includes(t.split('/')[1]))) {
    await sendWhatsApp(from,
      '⚠️ Unsupported file type.\n\nPlease send a *PDF* or *DOCX* file only.'
    );
    return res.sendStatus(200);
  }

  // Acknowledge receipt immediately
  await sendWhatsApp(from,
    '✅ File received!\n\n⏳ Uploading to Turnitin and running similarity check...\n\nThis usually takes *3–5 minutes*. I\'ll send the report automatically when ready.'
  );

  res.sendStatus(200); // respond to Twilio quickly

  // Run the full pipeline in background
  runPipeline(from, mediaUrl, mediaType).catch(err => {
    console.error('[PIPELINE ERROR]', err);
    sendWhatsApp(from, '❌ Something went wrong during the check. Please try again or contact support.');
  });
});

// ──────────────────────────────────────────────
//  STEP 2: Full Pipeline
// ──────────────────────────────────────────────
async function runPipeline(to, mediaUrl, mediaType) {
  const tmpDir = `/tmp/${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 2a. Download file from Twilio
    console.log('[PIPELINE] Downloading file from Twilio...');
    const fileBuffer = await downloadTwilioFile(mediaUrl);
    const ext = mediaType.includes('pdf') ? 'pdf' : 'docx';
    const filePath = path.join(tmpDir, `submission.${ext}`);
    fs.writeFileSync(filePath, fileBuffer);
    console.log(`[PIPELINE] File saved to ${filePath}`);

    // 2b. Run Turnitin automation
    console.log('[PIPELINE] Starting Turnitin automation...');
    const reportPath = await runTurnitin(filePath, tmpDir);
    console.log(`[PIPELINE] Report generated: ${reportPath}`);

    // 2c. Upload report to Twilio and send back
    console.log('[PIPELINE] Sending report via WhatsApp...');
    await sendReportViaWhatsApp(to, reportPath);

  } finally {
    // Cleanup temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────
//  STEP 3: Download file from Twilio CDN
// ──────────────────────────────────────────────
async function downloadTwilioFile(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN
    }
  });
  return Buffer.from(response.data);
}

// ──────────────────────────────────────────────
//  STEP 4: Turnitin Automation via Puppeteer
// ──────────────────────────────────────────────
async function runTurnitin(filePath, tmpDir) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    // ── Login ──
    console.log('[TURNITIN] Navigating to login...');
    await page.goto('https://www.turnitin.com/login_page.asp', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await page.type('#email', process.env.TURNITIN_EMAIL, { delay: 50 });
    await page.type('#password', process.env.TURNITIN_PASSWORD, { delay: 50 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('#login-button')
    ]);
    console.log('[TURNITIN] Logged in.');

    // ── Navigate to class ──
    await page.goto(
      `https://www.turnitin.com/t_home.asp?login=1&svr=6&lang=en_us&account_id=${process.env.TURNITIN_ACCOUNT_ID}&session-id=`,
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    // Click on the target class
    await page.waitForSelector(`a[href*="class_id=${process.env.TURNITIN_CLASS_ID}"]`, { timeout: 15000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click(`a[href*="class_id=${process.env.TURNITIN_CLASS_ID}"]`)
    ]);

    // Click on the assignment
    await page.waitForSelector(`a[href*="assign_id=${process.env.TURNITIN_ASSIGN_ID}"]`, { timeout: 15000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.click(`a[href*="assign_id=${process.env.TURNITIN_ASSIGN_ID}"]`)
    ]);

    // ── Submit paper ──
    console.log('[TURNITIN] Submitting paper...');

    // Click "Submit" button to open submission dialog
    await page.waitForSelector('button[aria-label*="Submit"], #submit-btn, .submit-paper-btn', { timeout: 15000 });
    await page.click('button[aria-label*="Submit"], #submit-btn, .submit-paper-btn');

    // Fill submission form
    await page.waitForSelector('#submission-title, input[name="title"]', { timeout: 10000 });
    await page.type('#submission-title, input[name="title"]', `AutoCheck_${Date.now()}`);

    // Upload the file
    const fileInput = await page.$('input[type="file"]');
    await fileInput.uploadFile(filePath);

    // Submit and wait
    await page.waitForSelector('#upload-submit-btn, button[type="submit"]', { timeout: 10000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }),
      page.click('#upload-submit-btn, button[type="submit"]')
    ]);

    console.log('[TURNITIN] Submission complete. Waiting for report...');

    // ── Wait for similarity report (poll every 30s, up to 10 minutes) ──
    const reportUrl = await pollForReport(page, process.env.TURNITIN_ASSIGN_ID);
    console.log(`[TURNITIN] Report ready: ${reportUrl}`);

    // ── Open report and capture PDF ──
    await page.goto(reportUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(3000); // let report render

    const reportPath = path.join(tmpDir, 'turnitin_report.pdf');
    await page.pdf({
      path: reportPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
    });

    return reportPath;

  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────────
//  STEP 4b: Poll until similarity report appears
// ──────────────────────────────────────────────
async function pollForReport(page, assignId, maxWaitMs = 600000) {
  const started = Date.now();
  const pollInterval = 30000; // 30 seconds

  while (Date.now() - started < maxWaitMs) {
    // Navigate to submission list
    await page.goto(
      `https://www.turnitin.com/t_submit.asp?lang=en_us&assign_id=${assignId}`,
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    // Look for similarity score link (indicates report is ready)
    const reportLink = await page.$eval(
      'a[href*="gradebook_id"], a[href*="sim_report"]',
      el => el.href
    ).catch(() => null);

    if (reportLink) return reportLink;

    console.log('[TURNITIN] Report not ready yet. Waiting 30s...');
    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error('Turnitin report timed out after 10 minutes.');
}

// ──────────────────────────────────────────────
//  STEP 5: Send PDF report back via WhatsApp
// ──────────────────────────────────────────────
async function sendReportViaWhatsApp(to, pdfPath) {
  // Upload PDF to a publicly accessible URL first.
  // We use a local HTTP server endpoint on Railway for this.
  const reportId = path.basename(path.dirname(pdfPath));
  const publicUrl = `${process.env.PUBLIC_BASE_URL}/reports/${reportId}`;

  // Store file temporarily in memory for serving
  reportStore[reportId] = pdfPath;
  setTimeout(() => delete reportStore[reportId], 30 * 60 * 1000); // expire after 30min

  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,   // "whatsapp:+14155238886"
    to,
    mediaUrl: [publicUrl],
    body: '📄 *Your Turnitin Report is Ready!*\n\nThe PDF above contains your full similarity report including:\n• Overall similarity score\n• Matched sources breakdown\n• Highlighted text sections\n\n_Report expires in 30 minutes._'
  });
}

// ──────────────────────────────────────────────
//  Report file server (temporary public URLs)
// ──────────────────────────────────────────────
const reportStore = {};

app.get('/reports/:id', (req, res) => {
  const pdfPath = reportStore[req.params.id];
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    return res.status(404).send('Report not found or expired');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="turnitin_report.pdf"');
  fs.createReadStream(pdfPath).pipe(res);
});

// ──────────────────────────────────────────────
//  Helper: send WhatsApp text message
// ──────────────────────────────────────────────
async function sendWhatsApp(to, text) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body: text
  });
}

// ──────────────────────────────────────────────
//  Health check
// ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AutoTurnitin bot running on port ${PORT}`);
});
