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
// ──────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const from      = req.body.From;
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  console.log(`[WEBHOOK] From: ${from} | Media: ${mediaUrl} | Type: ${mediaType}`);

  if (!mediaUrl) {
    await sendWhatsApp(from,
      '👋 Welcome to AutoTurnitin!\n\nPlease upload your document (PDF or DOCX) and I will check it for plagiarism automatically.'
    );
    return res.sendStatus(200);
  }

  const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowed.some(t => mediaType?.includes(t.split('/')[1]))) {
    await sendWhatsApp(from,
      '⚠️ Unsupported file type.\n\nPlease send a *PDF* or *DOCX* file only.'
    );
    return res.sendStatus(200);
  }

  await sendWhatsApp(from,
    '✅ File received!\n\n⏳ Uploading to Turnitin and running similarity check...\n\nThis usually takes *3–5 minutes*. I\'ll send the report automatically when ready.'
  );

  // Respond quickly to Twilio to avoid timeout
  res.sendStatus(200);

  // Run the pipeline asynchronously
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
    console.log('[PIPELINE] Downloading file from Twilio...');
    const fileBuffer = await downloadTwilioFile(mediaUrl);
    const ext = mediaType.includes('pdf') ? 'pdf' : 'docx';
    const filePath = path.join(tmpDir, `submission.${ext}`);
    fs.writeFileSync(filePath, fileBuffer);
    console.log(`[PIPELINE] File saved: ${filePath}`);

    console.log('[PIPELINE] Starting Turnitin automation...');
    const reportPath = await runTurnitinCheck(filePath, tmpDir);
    console.log(`[PIPELINE] Report generated: ${reportPath}`);

    console.log('[PIPELINE] Sending report via WhatsApp...');
    await sendReportViaWhatsApp(to, reportPath);

  } catch (error) {
    console.error('[PIPELINE ERROR]', error);
    await sendWhatsApp(to, `❌ An error occurred: ${error.message}. Please try again later.`);
  } finally {
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
async function runTurnitinCheck(filePath, tmpDir) {
  // Launch browser in non-headless mode for debugging (remove when working)
  const browser = await puppeteer.launch({
    headless: false, // Change to 'new' when everything is working
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
    // ── NAVIGATE TO TURNITIN ──────────────────────
    console.log('[TURNITIN] Navigating to Turnitin...');
    await page.goto('https://www.turnitin.com', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    console.log(`[TURNITIN] Current URL: ${page.url()}`);

    // Take a screenshot for debugging
    await page.screenshot({ path: 'step1-landing.png' });
    console.log('[TURNITIN] Screenshot saved: step1-landing.png');

    // ── LOGIN TO TURNITIN ─────────────────────────
    // Find and click the login button - Selectors are examples; update as needed.
    const loginButtonSelectors = ['a:contains("Login")', 'button:contains("Sign In")', '.login-btn'];
    let loggedIn = false;
    for (const selector of loginButtonSelectors) {
      const button = await page.$(selector);
      if (button) {
        console.log(`[TURNITIN] Clicking login button with selector: ${selector}`);
        await button.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
        loggedIn = true;
        break;
      }
    }

    if (!loggedIn) {
      // If no button is found, we might already be on the login page or it's different.
      console.log('[TURNITIN] Could not find a specific login button. Proceeding to fill in credentials if on login page.');
    }

    // Wait for email and password fields
    await page.waitForSelector('input[name="email"], input[name="username"], #email, #username', { timeout: 15000 });
    await page.waitForSelector('input[name="password"], #password', { timeout: 15000 });

    // Fill in credentials
    await page.type('input[name="email"], input[name="username"], #email, #username', process.env.TURNITIN_EMAIL, { delay: 50 });
    await page.type('input[name="password"], #password', process.env.TURNITIN_PASSWORD, { delay: 50 });

    // Click the submit button
    await page.click('button[type="submit"], input[type="submit"], .submit-btn');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    console.log('[TURNITIN] Logged in successfully.');
    await page.screenshot({ path: 'step2-dashboard.png' });
    console.log('[TURNITIN] Screenshot saved: step2-dashboard.png');

    // ── FIND AND CLICK ON THE UPLOAD/SUBMISSION SECTION ──
    // This is where you'll need to adapt based on Turnitin's UI.
    // Look for links or buttons that say "Submit", "Upload", "Add Submission", etc.
    const uploadSelectors = [
      'a:contains("Submit")',
      'button:contains("Upload")',
      'a:contains("Add Submission")',
      '.submit-paper-btn',
      '[data-action="submit"]'
    ];

    let uploadStarted = false;
    for (const selector of uploadSelectors) {
      const element = await page.$(selector);
      if (element) {
        console.log(`[TURNITIN] Clicking upload element: ${selector}`);
        await element.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        uploadStarted = true;
        break;
      }
    }

    if (!uploadStarted) {
      throw new Error('Could not find an upload/submission button on the dashboard.');
    }

    // ── UPLOAD THE FILE ─────────────────────────
    console.log('[TURNITIN] Looking for file input...');
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15000 });
    if (!fileInput) {
      throw new Error('File input not found on upload page');
    }
    await fileInput.uploadFile(filePath);
    console.log('[TURNITIN] File attached.');

    // Wait for any confirmation or next step button
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'step3-uploaded.png' });
    console.log('[TURNITIN] Screenshot saved: step3-uploaded.png');

    // ── SUBMIT THE CHECK ────────────────────────
    console.log('[TURNITIN] Submitting for plagiarism check...');
    const submitCheckSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:contains("Submit")',
      '.submit-btn'
    ];

    let checkSubmitted = false;
    for (const selector of submitCheckSelectors) {
      const button = await page.$(selector);
      if (button) {
        console.log(`[TURNITIN] Clicking submit button: ${selector}`);
        await button.click();
        checkSubmitted = true;
        break;
      }
    }

    if (!checkSubmitted) {
      throw new Error('Could not find a button to submit the check.');
    }

    // Wait for processing to start
    await page.waitForTimeout(5000);
    console.log('[TURNITIN] File submitted. Waiting for report...');

    // ── POLL FOR THE REPORT ─────────────────────
    const reportUrl = await pollForReport(page);
    console.log(`[TURNITIN] Report ready at: ${reportUrl}`);

    // ── CAPTURE REPORT AS PDF ───────────────────
    await page.goto(reportUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(5000); // Let report render

    const reportPath = path.join(tmpDir, 'turnitin_report.pdf');
    await page.pdf({
      path: reportPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' }
    });

    console.log(`[TURNITIN] PDF saved: ${reportPath}`);
    return reportPath;

  } catch (error) {
    console.error('[TURNITIN ERROR]', error);
    // Take a screenshot on error for debugging
    await page.screenshot({ path: 'error-screenshot.png' });
    console.log('[TURNITIN] Error screenshot saved: error-screenshot.png');
    throw error;
  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────────
//  STEP 4b: Poll until report is ready
//  (Same as your original function, but with more logging)
// ──────────────────────────────────────────────
async function pollForReport(page, maxWaitMs = 600000) {
  const started = Date.now();
  const interval = 20000;

  while (Date.now() - started < maxWaitMs) {
    const currentUrl = page.url();
    console.log(`[TURNITIN] Polling for report... URL: ${currentUrl}`);

    const reportInfo = await page.evaluate(() => {
      // Common patterns for report links
      const linkSelectors = [
        'a[href*="report"]',
        'a[href*="result"]',
        'a[href*="similarity"]',
        'a[href*="view"]',
        '.report-link',
        '.view-report',
        '.similarity-score a',
        'td a[href*="report"]',
      ];

      for (const sel of linkSelectors) {
        const el = document.querySelector(sel);
        if (el && el.href) return { type: 'link', url: el.href };
      }

      // Look for similarity % text — means report is done
      const scoreSelectors = [
        '.similarity-score',
        '.similarity-percentage',
        '.plagiarism-score',
        '[class*="similarity"]',
        '[class*="score"]',
        '[class*="percentage"]',
      ];

      for (const sel of scoreSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.match(/\d+\s*%/)) {
          return { type: 'score', text: el.textContent.trim() };
        }
      }

      // Check if current page IS the report (has similarity % anywhere)
      const bodyText = document.body.innerText;
      const match = bodyText.match(/similarity[:\s]+(\d+)%/i) ||
                    bodyText.match(/plagiarism[:\s]+(\d+)%/i) ||
                    bodyText.match(/(\d+)%\s*similar/i);
      if (match) return { type: 'current', url: window.location.href };

      return null;
    });

    if (reportInfo) {
      console.log('[TURNITIN] Report detected:', reportInfo);
      if (reportInfo.type === 'link') return reportInfo.url;
      if (reportInfo.type === 'current') return reportInfo.url || currentUrl;
      if (reportInfo.type === 'score') return currentUrl;
    }

    console.log(`[TURNITIN] Not ready yet. Waiting ${interval/1000}s...`);
    await new Promise(r => setTimeout(r, interval));
  }

  throw new Error('Turnitin report timed out after 10 minutes.');
}

// ──────────────────────────────────────────────
//  STEP 5: Send PDF report back via WhatsApp
// ──────────────────────────────────────────────
const reportStore = {};

async function sendReportViaWhatsApp(to, pdfPath) {
  const reportId = path.basename(path.dirname(pdfPath));
  const publicUrl = `${process.env.PUBLIC_BASE_URL}/reports/${reportId}`;

  reportStore[reportId] = pdfPath;
  setTimeout(() => delete reportStore[reportId], 30 * 60 * 1000);

  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    mediaUrl: [publicUrl],
    body: '📄 *Your Turnitin Report is Ready!*\n\nThe PDF above contains your full similarity report including:\n• Overall similarity score\n• Matched sources breakdown\n• Highlighted text sections\n\n_Report expires in 30 minutes._'
  });
}

// ──────────────────────────────────────────────
//  Report file server (temporary public URLs)
// ──────────────────────────────────────────────
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