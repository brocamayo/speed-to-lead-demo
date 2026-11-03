'use strict';

// Records a ~60 s screen capture of the demo, starting with the owner saving
// their business name on /settings. Needs Playwright:
//   NODE_PATH=$(npm root -g) node record.js

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(__dirname, 'recording');
const TARGET_SECONDS = 60;
const BUSINESS_NAME = 'Bayside Heating & Air';
const BUSINESS_PHONE = '(510) 555-0100';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/state`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Server did not start');
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Use a throwaway config so recording never touches your real config.json.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stl-record-'));
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      FOLLOWUP_DELAY_MS: '8000',
      CONFIG_PATH: path.join(tmpDir, 'config.json'),
    },
    stdio: 'inherit',
  });

  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } },
    });
    const page = await context.newPage();
    const t0 = Date.now();
    const at = async (sec) => {
      const wait = sec * 1000 - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    };
    const caption = (text) => page.evaluate((t) => window.setCaption && window.setCaption(t), text);

    // 0. Owner saves the business name once
    await page.goto(`${BASE}/settings`);
    await page.waitForFunction(() => document.querySelector('#businessName').value !== '');
    await page.evaluate(() => {
      const bar = document.createElement('div');
      bar.id = 'caption-bar';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#0f2233;color:#fff;padding:12px 20px;font:600 18px system-ui,sans-serif;text-align:center;z-index:10';
      document.body.appendChild(bar);
      window.setCaption = (t) => { bar.textContent = t || ''; bar.style.display = t ? 'block' : 'none'; };
    });
    await caption('0. The owner saves their business name once');
    await at(2);
    await page.locator('#businessName').fill('');
    await page.locator('#businessName').pressSequentially(BUSINESS_NAME, { delay: 45 });
    await page.locator('#phone').fill('');
    await page.locator('#phone').pressSequentially(BUSINESS_PHONE, { delay: 50 });
    await at(5);
    await page.click('button[type=submit]');
    await page.waitForSelector('.status.ok');
    await caption('Saved. Every text-back now uses this name');
    await at(9);

    // 1. Lead arrives by web form
    await page.goto(BASE);
    await page.waitForSelector('#f-name');
    await caption('1. A homeowner asks for help on the website');
    await page.locator('#f-name').pressSequentially('Dana Lee', { delay: 60 });
    await page.locator('#f-phone').pressSequentially('5105550142', { delay: 60 });
    await page.locator('#f-msg').pressSequentially('My AC stopped cooling. Can someone come tomorrow?', { delay: 30 });
    await at(14);

    await caption('She taps Send request');
    await at(15);
    await page.click('#btn-submit');
    await caption('2. The text-back goes out right away, signed with the saved name');
    await at(21);

    await caption('3. She replies. The system acknowledges and stops chasing her');
    await page.locator('#reply-input').pressSequentially('Yes, tomorrow morning works', { delay: 45 });
    await page.click('#btn-reply');
    await at(28);

    await caption('4. A different lead: a missed phone call');
    await page.locator('#f-name').fill('');
    await page.locator('#f-phone').fill('');
    await page.locator('#f-name').pressSequentially('Sam Ortiz', { delay: 50 });
    await page.locator('#f-phone').pressSequentially('5105550177', { delay: 50 });
    await at(31);
    await page.click('#btn-missed');
    await caption('The caller is texted back right after the missed call');
    await at(36);

    await caption('5. Sam stays silent, so one automatic follow-up goes out');
    await at(43);

    await caption('6. Sam replies STOP. Opt-out honored, no more texts');
    await page.click('#btn-stop');
    await at(49);

    await caption('7. The owner sees every lead and how fast it was answered');
    await page.hover('#rows');
    await at(55);

    await caption('Demo uses simulated texting. Real SMS needs a provider + 10DLC registration');
    await at(TARGET_SECONDS);

    const video = page.video();
    await context.close();
    const webm = path.join(OUT_DIR, 'speed-to-lead-demo.webm');
    fs.copyFileSync(await video.path(), webm);
    await browser.close();

    const mp4 = path.join(OUT_DIR, 'speed-to-lead-demo.mp4');
    const ff = spawnSync('ffmpeg', ['-y', '-i', webm, '-t', String(TARGET_SECONDS), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', mp4], { encoding: 'utf8' });
    if (ff.status !== 0) {
      console.error('ffmpeg failed:', ff.stderr.slice(-500));
    }
    console.log('Recorded:', fs.existsSync(mp4) ? mp4 : webm);
  } finally {
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
