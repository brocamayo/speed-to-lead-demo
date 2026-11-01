'use strict';

// Simulated gateway by default. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_FROM to send real texts (untested here; needs 10DLC registration).

let counter = 0;

function mockSender() {
  return {
    name: 'Simulated SMS gateway',
    simulated: true,
    async send() {
      return { id: `mock_${++counter}` };
    },
  };
}

function twilioSender({ sid, token, from }) {
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  return {
    name: 'Twilio',
    simulated: false,
    async send(to, body) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twilio error ${res.status}: ${data.message || 'unknown'}`);
      return { id: data.sid };
    },
  };
}

function createSender(env = process.env) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = env;
  return sid && token && from ? twilioSender({ sid, token, from }) : mockSender();
}

module.exports = { createSender };
