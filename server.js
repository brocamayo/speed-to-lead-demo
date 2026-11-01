'use strict';

// Speed-to-lead demo: texts a new lead back immediately, follows up if they
// stay silent, and honors STOP. Run: node server.js  (http://127.0.0.1:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSender } = require('./sms');

const PORT = Number(process.env.PORT || 3000);
const BUSINESS = process.env.BUSINESS_NAME || 'Demo HVAC Co.';
const FOLLOWUP_MS = Number(process.env.FOLLOWUP_DELAY_MS || 5 * 60 * 1000);
const SHOP = /[.!?]$/.test(BUSINESS) ? BUSINESS : `${BUSINESS}.`;
const STOP_WORDS =/^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*[.!]?\s*$/i;
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
      `Hi again, it's ${SHOP} Still happy to help. Just reply with what you need and we'll get you scheduled. Reply STOP to opt out.`,
      'followup',
    );
  }, FOLLOWUP_MS);
  timers.add(timer);
}

async function textBack(lead) {
  const first = lead.name ? lead.name.split(' ')[0] : '';
  const greet = first ? `Hi ${first}, this` : 'Hi, this';
  const opener =
    lead.source === 'missed-call'
      ? 'Sorry we missed your call!'
      : 'Thanks for reaching out!';
  const body = `${greet} is ${SHOP} ${opener} What can we help you with? Reply STOP to opt out.`;
  const msg = await sendText(lead, body, 'textback');
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
      `You're unsubscribed from ${BUSINESS.replace(/[.!?]$/, '')} texts. No more messages will be sent.`,
      'optout-confirm',
    );
    return lead;
  }
  lead.replied = true;
  if (!lead.acked) {
    lead.acked = true;
    await sendText(
      lead,
      `Got it, thanks! Someone from ${BUSINESS.replace(/[.!?]$/, '')} will reach out shortly.`,
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
        business: BUSINESS,
        provider: sender.name,
        simulated: sender.simulated,
        followupMs: FOLLOWUP_MS,
        leads,
        messages: messages.slice(-300),
        now: Date.now(),
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

module.exports = { server, reset };
