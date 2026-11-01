'use strict';

// Records a ~60 s screen capture of the demo. Needs Playwright:
//   NODE_PATH=$(npm root -g) node record.js

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(__dirname, 'recording');
const TARGET_SECONDS = 60;

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

  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), FOLLOWUP_DELAY_MS: '10000' },
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
    const caption = (text) => page.evaluate((t) => window.setCaption(t), text);

    await page.goto(BASE);
    await page.waitForSelector('#f-name');

    await caption('Speed-to-lead: a new lead gets a text back in seconds');
    await at(4);

    await caption('1. A homeowner asks for help on the website');
    await page.locator('#f-name').pressSequentially('Dana Lee', { delay: 70 });
    await page.locator('#f-phone').pressSequentially('5105550142', { delay: 70 });
    await page.locator('#f-msg').pressSequentially('My AC stopped cooling. Can someone come tomorrow?', { delay: 40 });
    await at(11);

    await caption('She taps Send request');
    await at(12.5);
    await page.click('#btn-submit');
    await caption('2. The text-back goes out right away (goal: under 60 seconds)');
    await at(19);

    await caption('3. She replies. The system acknowledges and stops chasing her');
    await page.locator('#reply-input').pressSequentially('Yes, tomorrow morning works', { delay: 50 });
    await page.click('#btn-reply');
    await at(27);

    await caption('4. A different lead: a missed phone call');
    await page.locator('#f-name').fill('');
    await page.locator('#f-phone').fill('');
    await page.locator('#f-name').pressSequentially('Sam Ortiz', { delay: 60 });
    await page.locator('#f-phone').pressSequentially('5105550177', { delay: 60 });
    await at(30.5);
    await page.click('#btn-missed');
    await caption('The caller is texted back right after the missed call');
    await at(36);

    await caption('5. Sam stays silent, so one automatic follow-up goes out');
    await at(45);

    await caption('6. Sam replies STOP. Opt-out honored, no more texts');
    await page.click('#btn-stop');
    await at(52);

    await caption('7. The owner sees every lead and how fast it was answered');
    await page.hover('#rows');
    await at(57);

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
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
