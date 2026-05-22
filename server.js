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

// ──────────────────────────────────────────────
//  Twilio WhatsApp Webhook
// ──────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  const from = req.body.From;
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  console.log(`[WEBHOOK] From: ${from} | Media: ${mediaUrl} | Type: ${mediaType}`);

  if (!mediaUrl) {
    await sendWhatsApp(from, '👋 Welcome! Send a PDF or DOCX file for plagiarism check.');
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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.setDefaultTimeout(60000);

  try {
    // ---------- LOGIN ----------
    console.log('[LOGIN] Navigating to turnitpro.com/login...');
    await page.goto('https://turnitpro.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: '/tmp/1-login-page.png' });

    if (page.url().includes('/dashboard')) {
      console.log('[LOGIN] Already on dashboard.');
    } else {
      await page.waitForSelector('input[name="email"]', { timeout: 10000 });
      await page.type('input[name="email"]', process.env.TURNITPRO_EMAIL, { delay: 50 });
      await page.type('input[name="password"]', process.env.TURNITPRO_PASSWORD, { delay: 50 });
      const [signInBtn] = await page.$x('//button[normalize-space()="Sign In"]');
      if (!signInBtn) throw new Error('Sign In button not found');
      await signInBtn.click();
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
        page.waitForSelector('.dashboard, .upload-area', { timeout: 15000 }).catch(() => {})
      ]);
      await page.waitForTimeout(3000);
      if (page.url().includes('/login')) {
        await page.screenshot({ path: '/tmp/login-failed.png' });
        throw new Error('Login failed – still on login page. Check credentials.');
      }
      console.log('[LOGIN] Success. Dashboard URL:', page.url());
      await page.screenshot({ path: '/tmp/2-dashboard.png' });
    }

    // ---------- FILL NAME FIELDS (optional) ----------
    console.log('[DASHBOARD] Filling name fields if present...');
    const firstNameField = await page.$('input[placeholder*="First"], input[name="first_name"]');
    if (firstNameField) await firstNameField.type('AutoUser', { delay: 30 });
    const lastNameField = await page.$('input[placeholder*="Last"], input[name="last_name"]');
    if (lastNameField) await lastNameField.type('Bot', { delay: 30 });

    // ---------- UPLOAD FILE ----------
    console.log('[UPLOAD] Looking for file input...');
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
    if (!fileInput) throw new Error('File input not found');
    await fileInput.uploadFile(filePath);
    console.log('[UPLOAD] File attached');
    await page.waitForTimeout(3000);

    // ---------- CLICK ANALYZE ----------
    const [analyzeBtn] = await page.$x('//button[normalize-space()="Analyze"]');
    if (!analyzeBtn) throw new Error('Analyze button not found');
    console.log('[ANALYZE] Clicking Analyze...');
    await analyzeBtn.click();

    // ---------- WAIT FOR REPORT IN RECENT REPORTS TABLE ----------
    console.log('[REPORT] Waiting for analysis to complete and appear in Recent Reports...');
    await waitForReportCompletion(page);

    // ---------- CLICK THE VIEW (EYE) ICON FOR THE MOST RECENT REPORT ----------
    console.log('[REPORT] Clicking view icon on the completed report...');
    await clickViewIconForMostRecentReport(page);

    // ---------- NOW ON REPORT DETAILS PAGE: CLICK "View Plagiarism Report" BUTTON ----------
    console.log('[REPORT] Clicking "View Plagiarism Report" button...');
    const [viewPlagiarismBtn] = await page.$x('//a[contains(text(),"View Plagiarism Report")]');
    if (!viewPlagiarismBtn) throw new Error('View Plagiarism Report button not found');
    await viewPlagiarismBtn.click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/final-report-page.png' });

    // ---------- GENERATE PDF OF THE FINAL REPORT ----------
    const reportPath = path.join(tmpDir, 'turnitpro_report.pdf');
    await page.pdf({
      path: reportPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' }
    });
    console.log('[PDF] Report saved');
    return reportPath;

  } catch (err) {
    await page.screenshot({ path: '/tmp/error.png' });
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Waits for the most recent report in the Recent Reports table to have status "Completed".
 * Polls every 10 seconds, refreshes the Reports tab.
 */
async function waitForReportCompletion(page, maxWaitMs = 600000) {
  const start = Date.now();
  const interval = 10000;

  // Go to Reports tab first
  await goToReportsTab(page);

  while (Date.now() - start < maxWaitMs) {
    console.log(`[REPORT] Checking Reports table for "Completed" status...`);
    const rows = await page.$$('table tbody tr');
    if (rows.length > 0) {
      const firstRow = rows[0];
      const statusCell = await firstRow.$('td:nth-child(4)'); // Assume 4th column is STATUS
      if (statusCell) {
        const statusText = await page.evaluate(el => el.innerText.trim(), statusCell);
        if (statusText === 'Completed') {
          console.log('[REPORT] Most recent report is Completed.');
          return;
        }
      }
    }
    console.log(`[REPORT] Not completed yet. Waiting ${interval/1000}s...`);
    await page.waitForTimeout(interval);
    // Refresh the Reports tab to see updated status
    await goToReportsTab(page);
  }
  throw new Error('Report did not reach Completed status within timeout');
}

/**
 * Clicks the view icon (eye) in the last column of the most recent report row.
 */
async function clickViewIconForMostRecentReport(page) {
  // Ensure we are on the Reports page
  await goToReportsTab(page);
  const rows = await page.$$('table tbody tr');
  if (rows.length === 0) throw new Error('No reports found in table');
  const firstRow = rows[0];
  // Look for an <a> or <button> inside the last <td>
  const viewElement = await firstRow.$('td:last-child a, td:last-child button');
  if (viewElement) {
    await viewElement.click();
    await page.waitForTimeout(5000);
    return;
  }
  // Alternatively, look for an image with alt containing "view" or an SVG
  const eyeIcon = await firstRow.$('td:last-child img, td:last-child svg');
  if (eyeIcon) {
    await eyeIcon.click();
    await page.waitForTimeout(5000);
    return;
  }
  throw new Error('View icon (eye) not found in the most recent report row');
}

/**
 * Helper: Navigate to the Reports tab by clicking the link that contains "Reports".
 */
async function goToReportsTab(page) {
  const [reportsTab] = await page.$x('//a[contains(text(),"Reports")]');
  if (!reportsTab) {
    // If not found, maybe we are already on the Reports page
    if (!page.url().includes('/reports')) {
      throw new Error('Reports tab not found');
    }
    return;
  }
  await reportsTab.click();
  await page.waitForTimeout(3000);
}

// ---------- REPORT STORAGE AND DELIVERY ----------
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
    body: '📄 Your TurnitPro similarity report is attached.'
  });
}

app.get('/reports/:id', (req, res) => {
  const pdfPath = reportStore[req.params.id];
  if (!pdfPath || !fs.existsSync(pdfPath)) return res.status(404).send('Report expired');
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
app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
