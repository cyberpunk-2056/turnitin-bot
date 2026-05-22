const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' });

// ──────────────────────────────────────────────
//  HARDCODED TWILIO CREDENTIALS (INSECURE)
//  Replace with environment variables in production.
// ──────────────────────────────────────────────
const accountSid = 'AC14934954ffb9bd68e75a120903104ca5';
const authToken = '5b869a986c6eee2ef4af8829a27e1926';
const twilioWhatsappFrom = 'whatsapp:+14155238886';

const twilioClient = twilio(accountSid, authToken);

// ──────────────────────────────────────────────
//  STEP 1: Twilio WhatsApp Webhook
// ──────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From;
  const mediaUrl = req.body.MediaUrl0;
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
    const reportPath = await runTurnitProCheck(filePath, tmpDir);
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
      username: accountSid,
      password: authToken
    }
  });
  return Buffer.from(response.data);
}

// ──────────────────────────────────────────────
//  STEP 4: TurnitPro Automation (fixed selectors)
// ──────────────────────────────────────────────
async function runTurnitProCheck(filePath, tmpDir) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log('[TURNITPRO] Navigating to login page...');
    await page.goto('https://turnitpro.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await page.screenshot({ path: '/tmp/login-page.png' });
    console.log('[TURNITPRO] Login page loaded');

    await page.waitForSelector('#email, input[name="email"]', { timeout: 10000 });
    await page.type('#email, input[name="email"]', process.env.TURNITPRO_EMAIL, { delay: 60 });

    await page.waitForSelector('#password, input[name="password"]', { timeout: 10000 });
    await page.type('#password, input[name="password"]', process.env.TURNITPRO_PASSWORD, { delay: 60 });

    const loginButtonXPath = '//button[contains(text(),"Sign In") or contains(text(),"Login") or contains(@class,"submit-btn")]';
    const [loginButton] = await page.$x(loginButtonXPath);
    if (!loginButton) throw new Error('Login button not found');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      loginButton.click()
    ]);

    console.log('[TURNITPRO] Logged in. Current URL:', page.url());
    await page.screenshot({ path: '/tmp/dashboard.png' });

    let uploadPageFound = false;
    const possibleUploadUrls = [
      'https://turnitpro.com/dashboard',
      'https://turnitpro.com/upload',
      'https://turnitpro.com/check',
      'https://turnitpro.com/submit'
    ];

    for (const url of possibleUploadUrls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          console.log(`[TURNITPRO] Upload page found at: ${url}`);
          uploadPageFound = true;
          break;
        }
      } catch (e) {
        console.log(`[TURNITPRO] ${url} not accessible, trying next...`);
      }
    }

    if (!uploadPageFound) {
      console.log('[TURNITPRO] Searching for upload link on dashboard...');
      const uploadLinkXPaths = [
        '//a[contains(text(),"Upload")]',
        '//a[contains(text(),"New Check")]',
        '//a[contains(text(),"Submit")]',
        '//button[contains(text(),"Upload")]',
        '//*[contains(@class,"upload-btn")]'
      ];
      let clicked = false;
      for (const xp of uploadLinkXPaths) {
        const [link] = await page.$x(xp);
        if (link) {
          await link.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
          clicked = true;
          break;
        }
      }
      if (!clicked) throw new Error('No upload page or upload button found on TurnitPro');
    }

    console.log('[TURNITPRO] Looking for file input...');
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15000 });
    if (!fileInput) throw new Error('File input not found on upload page');

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
    await page.waitForTimeout(2000);

    console.log('[TURNITPRO] Submitting for plagiarism check...');
    const submitXPaths = [
      '//button[@type="submit"]',
      '//input[@type="submit"]',
      '//button[contains(text(),"Submit")]',
      '//button[contains(text(),"Check")]',
      '//*[contains(@class,"submit-btn")]'
    ];
    let submitted = false;
    for (const xp of submitXPaths) {
      const [btn] = await page.$x(xp);
      if (btn) {
        const isVisible = await page.evaluate(el => {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        }, btn);
        if (isVisible) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
            btn.click()
          ]);
          submitted = true;
          break;
        }
      }
    }
    if (!submitted) throw new Error('Submit button not found on upload page');
    console.log('[TURNITPRO] File submitted. Waiting for report...');

    const reportUrl = await pollForReport(page);
    console.log(`[TURNITPRO] Report ready at: ${reportUrl}`);

    await page.goto(reportUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(5000);
    const reportPath = path.join(tmpDir, 'turnitpro_report.pdf');
    await page.pdf({
      path: reportPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' }
    });
    console.log(`[TURNITPRO] PDF saved: ${reportPath}`);
    return reportPath;

  } catch (error) {
    console.error('[TURNITPRO ERROR]', error);
    await page.screenshot({ path: '/tmp/error-screenshot.png' });
    throw error;
  } finally {
    await browser.close();
  }
}

async function pollForReport(page, maxWaitMs = 600000) {
  const started = Date.now();
  const interval = 20000;

  while (Date.now() - started < maxWaitMs) {
    const currentUrl = page.url();
    console.log(`[TURNITPRO] Polling for report... URL: ${currentUrl}`);

    const reportLinkXPath = '//a[contains(@href, "report") or contains(@href, "result") or contains(@href, "similarity")]';
    const [reportLink] = await page.$x(reportLinkXPath);
    if (reportLink) {
      const href = await page.evaluate(el => el.href, reportLink);
      if (href) return href;
    }

    const scoreText = await page.evaluate(() => {
      const elements = document.querySelectorAll('.similarity-score, .similarity-percentage, .plagiarism-score, [class*="similarity"], [class*="score"]');
      for (const el of elements) {
        if (el.textContent && /\d+\s*%/.test(el.textContent)) return el.textContent.trim();
      }
      const body = document.body.innerText;
      const match = body.match(/similarity[:\s]+(\d+)%/i) || body.match(/plagiarism[:\s]+(\d+)%/i);
      return match ? match[0] : null;
    });
    if (scoreText) {
      console.log(`[TURNITPRO] Similarity score detected: ${scoreText}`);
      return currentUrl;
    }

    console.log(`[TURNITPRO] Not ready yet. Waiting ${interval/1000}s...`);
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('TurnitPro report timed out after 10 minutes.');
}

const reportStore = {};

async function sendReportViaWhatsApp(to, pdfPath) {
  const reportId = path.basename(path.dirname(pdfPath));
  const publicUrl = `${process.env.PUBLIC_BASE_URL || 'https://turnitin-bot-production.up.railway.app'}/reports/${reportId}`;

  reportStore[reportId] = pdfPath;
  setTimeout(() => delete reportStore[reportId], 30 * 60 * 1000);

  await twilioClient.messages.create({
    from: twilioWhatsappFrom,
    to,
    mediaUrl: [publicUrl],
    body: '📄 *Your TurnitPro Report is Ready!*\n\nThe PDF above contains your full similarity report including:\n• Overall similarity score\n• Matched sources breakdown\n• Highlighted text sections\n\n_Report expires in 30 minutes._'
  });
}

app.get('/reports/:id', (req, res) => {
  const pdfPath = reportStore[req.params.id];
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    return res.status(404).send('Report not found or expired');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="turnitpro_report.pdf"');
  fs.createReadStream(pdfPath).pipe(res);
});

async function sendWhatsApp(to, text) {
  return twilioClient.messages.create({
    from: twilioWhatsappFrom,
    to,
    body: text
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AutoTurnitPro bot running on port ${PORT}`);
});
