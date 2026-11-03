'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stl-test-'));
const configPath = path.join(tmpDir, 'config.json');
process.env.CONFIG_PATH = configPath;
process.env.FOLLOWUP_DELAY_MS = '300';
delete process.env.BUSINESS_NAME;

const assert = require('node:assert/strict');
const { server, loadConfig } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const state = async () => (await fetch(base + '/api/state')).json();

  // 1. New web-form lead is texted back well inside 60 seconds
  const t0 = Date.now();
  const a = await post('/api/lead', { name: 'Dana Lee', phone: '(510) 555-0142', message: 'AC not cooling' });
  assert.equal(a.status, 201);
  let s = await state();
  const out = s.messages.filter((m) => m.leadId === a.json.lead.id && m.kind === 'textback');
  assert.equal(out.length, 1, 'one text-back sent');
  assert.match(out[0].body, /Hi Dana, this is Demo HVAC Co\./);
  assert.match(out[0].body, /Reply STOP to opt out/);
  assert.ok(Date.now() - t0 < 60000, 'text-back under 60s');
  assert.ok(s.leads[0].responseMs < 60000, 'responseMs recorded under 60s');
  console.log(`ok  form lead texted back in ${s.leads[0].responseMs} ms`);

  // 2. Silent lead gets exactly one follow-up
  await sleep(700);
  s = await state();
  assert.equal(s.messages.filter((m) => m.leadId === a.json.lead.id && m.kind === 'followup').length, 1);
  await sleep(700);
  s = await state();
  assert.equal(s.messages.filter((m) => m.leadId === a.json.lead.id && m.kind === 'followup').length, 1);
  console.log('ok  silent lead got exactly one follow-up');

  // 3. Missed call text-back; reply cancels follow-up and gets one ack
  const b = await post('/api/missed-call', { phone: '510-555-0177', name: 'Sam' });
  assert.equal(b.status, 201);
  await post('/api/sms/inbound', { phone: '510-555-0177', body: 'Need a tune-up' });
  await post('/api/sms/inbound', { phone: '510-555-0177', body: 'tomorrow works' });
  await sleep(700);
  s = await state();
  const mc = s.messages.filter((m) => m.leadId === b.json.lead.id);
  assert.match(mc[0].body, /Sorry we missed your call!/);
  assert.equal(mc.filter((m) => m.kind === 'ack').length, 1, 'single ack');
  assert.equal(mc.filter((m) => m.kind === 'followup').length, 0, 'reply cancels follow-up');
  console.log('ok  missed-call text-back; reply cancels follow-up; single ack');

  // 4. STOP opts out and nothing else is sent
  const c = await post('/api/lead', { name: 'Pat', phone: '5105550199' });
  await post('/api/sms/inbound', { phone: '5105550199', body: 'STOP' });
  await sleep(700);
  s = await state();
  const lc = s.messages.filter((m) => m.leadId === c.json.lead.id && m.dir === 'out');
  assert.deepEqual(lc.map((m) => m.kind), ['textback', 'optout-confirm']);
  assert.equal(s.leads.find((l) => l.id === c.json.lead.id).optedOut, true);
  const again = await post('/api/lead', { name: 'Pat', phone: '5105550199' });
  assert.equal(again.status, 201);
  s = await state();
  assert.equal(s.messages.filter((m) => m.leadId === c.json.lead.id && m.dir === 'out').length, 2, 'no texts after opt-out');
  console.log('ok  STOP opts out; no further texts');

  // 5. Bad input
  assert.equal((await post('/api/lead', { phone: '123' })).status, 400);
  assert.equal((await post('/api/missed-call', {})).status, 400);
  assert.equal((await post('/api/sms/inbound', { phone: '5105550101' })).status, 400);
  const bad = await fetch(base + '/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  console.log('ok  invalid input rejected');

  // 6. Settings form: defaults, save, persist, and the saved name is used in texts
  const page = await fetch(base + '/settings');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Business name/);
  const defaults = await (await fetch(base + '/api/config')).json();
  assert.equal(defaults.config.businessName, 'Demo HVAC Co.');
  assert.equal(fs.existsSync(configPath), false, 'nothing written until saved');

  const save = await post('/api/config', { businessName: '  Bayside Heating & Air  ', phone: '(510) 555-0100' });
  assert.equal(save.status, 200);
  assert.deepEqual(save.json.config, { businessName: 'Bayside Heating & Air', phone: '+15105550100' });
  assert.match(save.json.preview, /this is Bayside Heating & Air\./);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), save.json.config);
  assert.deepEqual(loadConfig(configPath), save.json.config, 'config survives a restart');
  console.log('ok  settings saved to config.json and reloadable');

  const d = await post('/api/missed-call', { phone: '510-555-0188', name: 'Robin' });
  s = await state();
  assert.equal(s.business, 'Bayside Heating & Air');
  assert.equal(s.businessPhone, '+15105550100');
  const first = s.messages.find((m) => m.leadId === d.json.lead.id && m.kind === 'textback');
  assert.equal(
    first.body,
    'Hi Robin, this is Bayside Heating & Air. Sorry we missed your call! What can we help you with? Reply STOP to opt out.',
  );
  assert.ok(!first.body.includes('Demo HVAC'), 'placeholder no longer used');
  await sleep(700);
  s = await state();
  assert.match(s.messages.find((m) => m.leadId === d.json.lead.id && m.kind === 'followup').body, /it's Bayside Heating & Air\./);
  await post('/api/sms/inbound', { phone: '510-555-0188', body: 'STOP' });
  s = await state();
  assert.match(
    s.messages.find((m) => m.leadId === d.json.lead.id && m.kind === 'optout-confirm').body,
    /unsubscribed from Bayside Heating & Air texts/,
  );
  console.log('ok  missed-call text, follow-up and opt-out use the saved business name');

  // 7. Settings validation
  assert.equal((await post('/api/config', { businessName: '', phone: '5105550100' })).status, 400);
  assert.equal((await post('/api/config', { businessName: '   ', phone: '5105550100' })).status, 400);
  assert.equal((await post('/api/config', { businessName: 'Acme', phone: '12' })).status, 400);
  assert.equal((await post('/api/config', {})).status, 400);
  const kept = await (await fetch(base + '/api/config')).json();
  assert.equal(kept.config.businessName, 'Bayside Heating & Air', 'rejected save changes nothing');
  const long = await post('/api/config', { businessName: `${'A'.repeat(100)}\n`, phone: '5105550100' });
  assert.equal(long.json.config.businessName.length, 60);
  const badFile = path.join(tmpDir, 'bad.json');
  fs.writeFileSync(badFile, '{nope');
  assert.equal(loadConfig(badFile).businessName, 'Demo HVAC Co.', 'corrupt file falls back to defaults');
  fs.writeFileSync(badFile, JSON.stringify({ businessName: '', phone: 'x' }));
  assert.equal(loadConfig(badFile).businessName, 'Demo HVAC Co.', 'invalid file falls back to defaults');
  console.log('ok  settings validation and fallbacks');

  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\nAll checks passed.');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
