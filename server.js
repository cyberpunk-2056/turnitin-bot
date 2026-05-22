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
    '✅ File received!\n\n⏳ Uploading to TurnitPro and running similarity check...\n\nThis usually takes *3–5 minutes*. I\'ll send the report automatically when ready.'
  );

  res.sendStatus(200);

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

    console.log('[PIPELINE] Starting TurnitPro automation...');
    const reportPath = await runTurnitPro(filePath, tmpDir);
    console.log(`[PIPELINE] Report generated: ${reportPath}`);

    console.log('[PIPELINE] Sending report via WhatsApp...');
    await sendReportViaWhatsApp(to, reportPath);

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
//  STEP 4: TurnitPro Automation via Puppeteer
// ──────────────────────────────────────────────
async function runTurnitPro(filePath, tmpDir) {
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

    // ── LOGIN ──────────────────────────────────
    console.log('[TURNITPRO] Navigating to login page...');
    await page.goto('https://turnitpro.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Type email  (id="email")
    await page.waitForSelector('#email', { timeout: 10000 });
    await page.click('#email');
    await page.type('#email', process.env.TURNITPRO_EMAIL, { delay: 60 });

    // Type password  (id="password")
    await page.waitForSelector('#password', { timeout: 10000 });
    await page.click('#password');
    await page.type('#password', process.env.TURNITPRO_PASSWORD, { delay: 60 });

    // Click Sign In  (button.submit-btn)
    await page.waitForSelector('button.submit-btn', { timeout: 10000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('button.submit-btn')
    ]);

    console.log('[TURNITPRO] Logged in. Current URL:', page.url());

    // ── NAVIGATE TO UPLOAD ──────────────────────
    // Try common dashboard/upload URLs used by TurnitPro
    const uploadUrls = [
      'https://turnitpro.com/dashboard',
      'https://turnitpro.com/upload',
      'https://turnitpro.com/check',
      'https://turnitpro.com/submit',
    ];

    let uploadPageFound = false;
    for (const url of uploadUrls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        // Check if a file input exists on this page
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          console.log(`[TURNITPRO] Upload page found at: ${url}`);
          uploadPageFound = true;
          break;
        }
      } catch (e) {
        console.log(`[TURNITPRO] Not found at ${url}, trying next...`);
      }
    }

    // If still not found, look for upload link on current page
    if (!uploadPageFound) {
      console.log('[TURNITPRO] Searching for upload link on dashboard...');
      await page.goto('https://turnitpro.com/dashboard', {
        waitUntil: 'networkidle2',
        timeout: 20000
      });

      // Click any button/link that looks like upload or new check
      const uploadSelectors = [
        'a[href*="upload"]',
        'a[href*="check"]',
        'a[href*="submit"]',
        'a[href*="new"]',
        'button[class*="upload"]',
        'button[class*="check"]',
        '.upload-btn',
        '.new-check',
        '.btn-upload',
      ];

      for (const sel of uploadSelectors) {
        const el = await page.$(sel);
        if (el) {
          console.log(`[TURNITPRO] Clicking upload trigger: ${sel}`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
            el.click()
          ]);
          break;
        }
      }
    }

    // ── UPLOAD FILE ─────────────────────────────
    console.log('[TURNITPRO] Looking for file input...');
    await page.waitForSelector('input[type="file"]', { timeout: 15000 });

    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('File input not found on upload page');

    // Make file input visible if hidden (common pattern)
    await page.evaluate(() => {
      const input = document.querySelector('input[type="file"]');
      if (input) {
        input.style.display = 'block';
        input.style.visibility = 'visible';
        input.style.opacity = '1';
      }
    });

    await fileInput.uploadFile(filePath);
    console.log('[TURNITPRO] File attached.');

    // Small wait for UI to react to file selection
    await new Promise(r => setTimeout(r, 2000));

    // ── SUBMIT THE CHECK ────────────────────────
    console.log('[TURNITPRO] Submitting for plagiarism check...');

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button.submit-btn',
      'button[class*="submit"]',
      'button[class*="check"]',
      'button[class*="upload"]',
      '.btn-submit',
      '.btn-check',
      '#submit',
      '#check-btn',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        const isVisible = await page.evaluate(el => {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        }, btn);

        if (isVisible) {
          console.log(`[TURNITPRO] Clicking submit: ${sel}`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
            btn.click()
          ]);
          submitted = true;
          break;
        }
      }
    }

    if (!submitted) throw new Error('Could not find submit button on upload page');
    console.log('[TURNITPRO] File submitted. Waiting for report...');

    // ── POLL FOR REPORT ─────────────────────────
    const reportUrl = await pollForReport(page);
    console.log(`[TURNITPRO] Report ready at: ${reportUrl}`);

    // ── CAPTURE REPORT AS PDF ───────────────────
    await page.goto(reportUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000)); // let report fully render

    const reportPath = path.join(tmpDir, 'turnitpro_report.pdf');
    await page.pdf({
      path: reportPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' }
    });

    console.log(`[TURNITPRO] PDF saved: ${reportPath}`);
    return reportPath;

  } finally {
    await browser.close();
  }
}

// ──────────────────────────────────────────────
//  STEP 4b: Poll until report is ready
//  Looks for a similarity % or report link on the page
// ──────────────────────────────────────────────
async function pollForReport(page, maxWaitMs = 600000) {
  const started = Date.now();
  const interval = 20000; // check every 20 seconds

  while (Date.now() - started < maxWaitMs) {

    const currentUrl = page.url();
    console.log(`[TURNITPRO] Polling for report... URL: ${currentUrl}`);

    // Look for report link or similarity score on current page
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
      console.log('[TURNITPRO] Report detected:', reportInfo);
      if (reportInfo.type === 'link') return reportInfo.url;
      if (reportInfo.type === 'current') return reportInfo.url || currentUrl;
      if (reportInfo.type === 'score') return currentUrl; // already on report page
    }

    // Also check history/results page if available
    try {
      const historyLinks = [
        'https://turnitpro.com/history',
        'https://turnitpro.com/results',
        'https://turnitpro.com/reports',
        'https://turnitpro.com/checks',
      ];

      for (const url of historyLinks) {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
        const found = await page.evaluate(() => {
          const a = document.querySelector('a[href*="report"], a[href*="result"], a[href*="view"], .view-report, .report-link');
          return a ? a.href : null;
        });
        if (found) {
          console.log(`[TURNITPRO] Report link found on ${url}: ${found}`);
          return found;
        }
      }
    } catch (e) {
      // history page doesn't exist, keep polling current page
    }

    console.log(`[TURNITPRO] Not ready yet. Waiting ${interval/1000}s...`);
    await new Promise(r => setTimeout(r, interval));
  }

  throw new Error('TurnitPro report timed out after 10 minutes.');
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
    body: '📄 *Your TurnitPro Report is Ready!*\n\nThe PDF above contains your full similarity report including:\n• Overall similarity score\n• Matched sources breakdown\n• Highlighted text sections\n\n_Report expires in 30 minutes._'
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
  res.setHeader('Content-Disposition', 'attachment; filename="turnitpro_report.pdf"');
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
  console.log(`🚀 AutoTurnitPro bot running on port ${PORT}`);
});
