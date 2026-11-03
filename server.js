'use strict';

// Speed-to-lead demo: texts a new lead back immediately, follows up if they
// stay silent, and honors STOP. Run: node server.js  (http://127.0.0.1:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSender } = require('./sms');

const PORT = Number(process.env.PORT || 3000);
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = { businessName: process.env.BUSINESS_NAME || 'Demo HVAC Co.', phone: '' };
const FOLLOWUP_MS = Number(process.env.FOLLOWUP_DELAY_MS || 5 * 60 * 1000);
const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]?\s*$/i;
const MAX_BODY = 10 * 1024;

const sender = createSender();
let leads = [];
let messages = [];
let nextId = 1;
const timers = new Set();

function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return null;
}

function clean(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function validateConfig(b) {
  const businessName = clean(b && b.businessName, 60);
  if (!businessName) return { error: 'Enter your business name.' };
  const phone = normalizePhone(b && b.phone);
  if (!phone) return { error: 'Enter a valid 10-digit US phone number.' };
  return { config: { businessName, phone } };
}

function loadConfig(file = CONFIG_PATH) {
  try {
    const { config: saved } = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (saved) return saved;
    console.warn(`Ignoring invalid ${file}; using defaults.`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not read ${file} (${err.message}); using defaults.`);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(next, file = CONFIG_PATH) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let config = loadConfig();

// "Bayside Heating." -> "Bayside Heating" for mid-sentence use; ensure one trailing period otherwise.
const businessName = () => config.businessName.replace(/[.!?]$/, '');
const shopSentence = () => (/[.!?]$/.test(config.businessName) ? config.businessName : `${config.businessName}.`);

function record(lead, dir, body, kind) {
  const msg = { id: nextId++, leadId: lead.id, dir, body, kind, ts: Date.now() };
  messages.push(msg);
  return msg;
}

async function sendText(lead, body, kind) {
  if (lead.optedOut && kind !== 'optout-confirm') return null;
  try {
    await sender.send(lead.phone, body);
  } catch (err) {
    record(lead, 'system', `Send failed: ${err.message}`, 'error');
    return null;
  }
  return record(lead, 'out', body, kind);
}

function findLead(phone) {
  return leads.find((l) => l.phone === phone);
}

function upsertLead({ name, phone, source, request }) {
  let lead = findLead(phone);
  if (!lead) {
    lead = {
      id: nextId++,
      name,
      phone,
      source,
      request,
      createdAt: Date.now(),
      textedAt: null,
      responseMs: null,
      replied: false,
      acked: false,
      followupSent: false,
      optedOut: false,
    };
    leads.push(lead);
  } else {
    lead.name = name || lead.name;
    lead.request = request || lead.request;
  }
  return lead;
}

function scheduleFollowUp(lead) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (lead.replied || lead.optedOut || lead.followupSent) return;
    lead.followupSent = true;
    sendText(
      lead,
      `Hi again, it's ${shopSentence()} Still happy to help. Just reply with what you need and we'll get you scheduled. Reply STOP to opt out.`,
      'followup',
    );
  }, FOLLOWUP_MS);
  timers.add(timer);
}

function textBackBody(lead) {
  const first = lead.name ? lead.name.split(' ')[0] : '';
  const greet = first ? `Hi ${first}, this` : 'Hi, this';
  const opener =
    lead.source === 'missed-call'
      ? 'Sorry we missed your call!'
      : 'Thanks for reaching out!';
  return `${greet} is ${shopSentence()} ${opener} What can we help you with? Reply STOP to opt out.`;
}

async function textBack(lead) {
  const msg = await sendText(lead, textBackBody(lead), 'textback');
  if (msg && lead.textedAt == null) {
    lead.textedAt = msg.ts;
    lead.responseMs = msg.ts - lead.createdAt;
  }
  if (msg) scheduleFollowUp(lead);
}

async function handleInbound(phone, body) {
  const lead =
    findLead(phone) || upsertLead({ name: '', phone, source: 'inbound', request: '' });
  record(lead, 'in', body, 'reply');
  if (STOP_WORDS.test(body)) {
    lead.optedOut = true;
    await sendText(
      lead,
      `You're unsubscribed from ${businessName()} texts. No more messages will be sent.`,
      'optout-confirm',
    );
    return lead;
  }
  lead.replied = true;
  if (!lead.acked) {
    lead.acked = true;
    await sendText(
      lead,
      `Got it, thanks! Someone from ${businessName()} will reach out shortly.`,
      'ack',
    );
  }
  return lead;
}

function reset() {
  timers.forEach(clearTimeout);
  timers.clear();
  leads = [];
  messages = [];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/x-www-form-urlencoded')) {
          const p = new URLSearchParams(raw);
          resolve({ phone: p.get('From'), body: p.get('Body') });
        } else {
          resolve(raw ? JSON.parse(raw) : {});
        }
      } catch {
        reject(Object.assign(new Error('Invalid body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(payload) : payload;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, {
        business: config.businessName,
        businessPhone: config.phone,
        provider: sender.name,
        simulated: sender.simulated,
        followupMs: FOLLOWUP_MS,
        leads,
        messages: messages.slice(-300),
        now: Date.now(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/settings') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'settings.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/config' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'POST') {
        const result = validateConfig(await readBody(req));
        if (result.error) return send(res, 400, { error: result.error });
        saveConfig(result.config);
        config = result.config;
      }
      return send(res, 200, {
        config,
        preview: textBackBody({ name: 'Dana', source: 'missed-call' }),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      reset();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/lead') {
      const b = await readBody(req);
      const phone = normalizePhone(b.phone);
      if (!phone) return send(res, 400, { error: 'Enter a valid 10-digit US phone number.' });
      const lead = upsertLead({
        name: clean(b.name, 60),
        phone,
        source: 'web-form',
        request: clean(b.message, 500),
      });
      await textBack(lead);
      return send(res, 201, { lead });
    }
    if (req.method === 'POST' && url.pathname === '/api/missed-call') {
      const b = await readBody(req);
      const phone = normalizePhone(b.phone);
      if (!phone) return send(res, 400, { error: 'Enter a valid 10-digit US phone number.' });
      const lead = upsertLead({
        name: clean(b.name, 60),
        phone,
        source: 'missed-call',
        request: '',
      });
      await textBack(lead);
      return send(res, 201, { lead });
    }
    if (req.method === 'POST' && url.pathname === '/api/sms/inbound') {
      const b = await readBody(req);
      const phone = normalizePhone(b.phone);
      const text = clean(b.body, 500);
      if (!phone || !text) return send(res, 400, { error: 'phone and body are required.' });
      const lead = await handleInbound(phone, text);
      return send(res, 200, { lead });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Speed-to-lead demo on http://127.0.0.1:${PORT} (${sender.name})`);
  });
}

module.exports = { server, reset, loadConfig };
