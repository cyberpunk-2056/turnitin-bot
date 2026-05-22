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

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From;
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  console.log(`[WEBHOOK] From: ${from} | Media: ${mediaUrl} | Type: ${mediaType}`);

  if (!mediaUrl) {
    await sendWhatsApp(from, '👋 Welcome! Send a PDF/DOCX for plagiarism check.');
    return res.sendStatus(200);
  }

  const allowed = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowed.some(t => mediaType?.includes(t.split('/')[1]))) {
    await sendWhatsApp(from, '⚠️ Only PDF or DOCX files are supported.');
    return res.sendStatus(200);
  }

  await sendWhatsApp(from, '✅ File received! Starting check (3-5 min).');
  res.sendStatus(200);

  runPipeline(from, mediaUrl, mediaType).catch(err => {
    console.error('[PIPELINE ERROR]', err);
    sendWhatsApp(from, '❌ Error. Check logs.');
  });
});

async function runPipeline(to, mediaUrl, mediaType) {
  const tmpDir = `/tmp/${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const fileBuffer = await downloadTwilioFile(mediaUrl);
    const ext = mediaType.includes('pdf') ? 'pdf' : 'docx';
    const filePath = path.join(tmpDir, `submission.${ext}`);
    fs.writeFileSync(filePath, fileBuffer);

    const reportPath = await runTurnitProCheck(filePath, tmpDir);
    await sendReportViaWhatsApp(to, reportPath);
  } catch (error) {
    console.error(error);
    await sendWhatsApp(to, `❌ ${error.message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

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

async function runTurnitProCheck(filePath, tmpDir) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    // ---------- LOGIN ----------
    console.log('[LOGIN] Navigating to turnitpro.com...');
    await page.goto('https://turnitpro.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: '/tmp/1-login-page.png' });

    // Check if already logged in (dashboard)
    const currentUrl = page.url();
    if (currentUrl.includes('/dashboard')) {
      console.log('[LOGIN] Already logged in.');
    } else {
      // Wait for email field (try multiple selectors)
      const emailSelector = '#email, input[name="email"], input[type="email"]';
      await page.waitForSelector(emailSelector, { timeout: 10000 });
      await page.type(emailSelector, process.env.TURNITPRO_EMAIL, { delay: 50 });

      const passwordSelector = '#password, input[name="password"], input[type="password"]';
      await page.waitForSelector(passwordSelector, { timeout: 10000 });
      await page.type(passwordSelector, process.env.TURNITPRO_PASSWORD, { delay: 50 });

      // Try to click login button
      const loginXPaths = [
        '//button[contains(text(),"Sign In")]',
        '//button[contains(text(),"Login")]',
        '//button[@type="submit"]',
        '//input[@type="submit"]'
      ];
      let clicked = false;
      for (const xp of loginXPaths) {
        const [btn] = await page.$x(xp);
        if (btn) {
          console.log(`[LOGIN] Clicking with XPath: ${xp}`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
            btn.click()
          ]);
          clicked = true;
          break;
        }
      }
      if (!clicked) throw new Error('Login button not found');

      console.log('[LOGIN] Post-login URL:', page.url());
      await page.screenshot({ path: '/tmp/2-after-login.png' });
    }

    // ---------- UPLOAD SECTION ----------
    // Wait a bit for dashboard to load
    await page.waitForTimeout(3000);

    // Try to find upload area
    let uploadFound = false;
    const uploadButtons = [
      '//a[contains(text(),"Upload")]',
      '//a[contains(text(),"New Check")]',
      '//button[contains(text(),"Upload")]',
      '//a[contains(@href,"upload")]',
      '//a[contains(@href,"check")]'
    ];
    for (const xp of uploadButtons) {
      const [btn] = await page.$x(xp);
      if (btn) {
        console.log(`[UPLOAD] Clicking: ${xp}`);
        await btn.click();
        await page.waitForTimeout(2000);
        uploadFound = true;
        break;
      }
    }

    if (!uploadFound) {
      // Try direct navigation to common upload paths
      const paths = ['/upload', '/check', '/submit', '/dashboard'];
      for (const p of paths) {
        await page.goto(`https://turnitpro.com${p}`, { waitUntil: 'networkidle2', timeout: 10000 });
        const hasFileInput = await page.$('input[type="file"]');
        if (hasFileInput) {
          console.log(`[UPLOAD] Found file input at ${p}`);
          uploadFound = true;
          break;
        }
      }
    }

    if (!uploadFound) throw new Error('Could not reach upload page');

    // ---------- ATTACH FILE ----------
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
    if (!fileInput) throw new Error('No file input element');

    await fileInput.uploadFile(filePath);
    console.log('[UPLOAD] File attached');
    await page.waitForTimeout(3000);

    // ---------- SUBMIT ----------
    const submitXPaths = [
      '//button[@type="submit"]',
      '//button[contains(text(),"Submit")]',
      '//button[contains(text(),"Check")]',
      '//input[@type="submit"]'
    ];
    let submitted = false;
    for (const xp of submitXPaths) {
      const [btn] = await page.$x(xp);
      if (btn && await btn.isVisible()) {
        console.log(`[SUBMIT] Clicking: ${xp}`);
        await btn.click();
        submitted = true;
        break;
      }
    }
    if (!submitted) throw new Error('Submit button not found');

    console.log('[CHECK] Waiting for report...');
    const reportUrl = await pollForReport(page);
    await page.goto(reportUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(5000);

    const reportPath = path.join(tmpDir, 'report.pdf');
    await page.pdf({ path: reportPath, format: 'A4' });
    return reportPath;

  } catch (err) {
    await page.screenshot({ path: '/tmp/error.png' });
    throw err;
  } finally {
    await browser.close();
  }
}

async function pollForReport(page, maxWaitMs = 600000) {
  const start = Date.now();
  const interval = 15000;

  while (Date.now() - start < maxWaitMs) {
    const url = page.url();
    console.log(`[POLL] ${url}`);

    // Look for report link
    const [reportLink] = await page.$x('//a[contains(@href, "report") or contains(@href, "result")]');
    if (reportLink) {
      const href = await page.evaluate(el => el.href, reportLink);
      if (href) return href;
    }

    // Look for similarity score on current page
    const hasScore = await page.evaluate(() => {
      const text = document.body.innerText;
      return /similarity\s*:?\s*\d+%/i.test(text) || /plagiarism\s*:?\s*\d+%/i.test(text);
    });
    if (hasScore) return url;

    // Check history page
    await page.goto('https://turnitpro.com/history', { waitUntil: 'networkidle2', timeout: 10000 });
    const [historyLink] = await page.$x('//a[contains(@href, "report")]');
    if (historyLink) {
      const href = await page.evaluate(el => el.href, historyLink);
      if (href) return href;
    }

    console.log(`[POLL] Not ready, waiting ${interval/1000}s...`);
    await page.waitForTimeout(interval);
  }
  throw new Error('Report timeout');
}

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
    body: '📄 Your similarity report is attached.'
  });
}

app.get('/reports/:id', (req, res) => {
  const pdfPath = reportStore[req.params.id];
  if (!pdfPath || !fs.existsSync(pdfPath)) return res.status(404).send('Expired');
  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(pdfPath).pipe(res);
});

async function sendWhatsApp(to, text) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body: text
  });
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
