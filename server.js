/**
 * ClientPulse (mini) — server.js
 * Lightweight Express backend for ClientPulse dashboard.
 *
 * Features:
 *  - In-memory store for clients, reminders, and logs
 *  - Endpoints to add clients, schedule reminders, run-now, and read logs
 *  - Simple scheduler loop that checks for due reminders every 30s
 *  - Optional real email sending via nodemailer if SMTP env vars are provided
 *
 * Usage:
 *  - npm install
 *  - configure .env if you want real email (see README.md)
 *  - npm start
 */

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const nodemailer = require('nodemailer');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(require('cors')());

// -------------------- In-memory store --------------------
let nextId = 1;
const clients = []; // { id, name, email, phone, notes, createdAt }
const reminders = []; // { id, clientId, datetimeISO, message, repeat, status, createdAt, lastSentAt }
const logs = []; // { id, timeISO, type, detail }

// Helper - add log
function addLog(type, detail) {
  const entry = { id: logs.length + 1, timeISO: new Date().toISOString(), type, detail };
  logs.unshift(entry);
  console.log(`[LOG] ${entry.timeISO} ${type} - ${detail}`);
  return entry;
}

// -------------------- Mailer (optional) --------------------
let transporter = null;
const SMTP_ENABLED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
if (SMTP_ENABLED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: (process.env.SMTP_SECURE === 'true') || false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  // verify connection on startup
  transporter.verify().then(() => {
    addLog('System', 'SMTP transporter verified — real email enabled');
  }).catch(err => {
    addLog('System', `SMTP verification failed (emails will be simulated): ${err.message}`);
    transporter = null;
  });
} else {
  addLog('System', 'No SMTP configured — email sends will be simulated in logs');
}

// sendMail: tries real email if transporter exists, otherwise simulate
async function sendMail(toEmail, subject, text) {
  if (transporter) {
    const from = process.env.FROM_EMAIL || process.env.SMTP_USER;
    try {
      const info = await transporter.sendMail({ from, to: toEmail, subject, text });
      addLog('Email', `Sent to ${toEmail} (messageId ${info.messageId})`);
      return { ok: true, info };
    } catch (err) {
      addLog('Email', `Failed to ${toEmail} — ${err.message}`);
      return { ok: false, error: err.message };
    }
  } else {
    // Simulate send
    addLog('Email', `Simulated send to ${toEmail} — "${text.slice(0,80)}${text.length>80?'...':''}"`);
    return { ok: true, simulated: true };
  }
}

// -------------------- API ROUTES --------------------

// GET /api/clients
app.get('/api/clients', (req, res) => {
  res.json(clients.slice().reverse());
});

// POST /api/clients  { name, email, phone, notes }
app.post('/api/clients', (req, res) => {
  const { name, email, phone, notes } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email format' });

  const client = { id: nextId++, name, email, phone: phone||'', notes: notes||'', createdAt: new Date().toISOString() };
  clients.push(client);
  addLog('Client', `Added client ${client.name} (${client.email})`);
  res.json(client);
});

// GET /api/reminders
app.get('/api/reminders', (req, res) => {
  res.json(reminders.slice().reverse());
});

// POST /api/reminders  { clientId, datetimeISO, message, repeat }
app.post('/api/reminders', (req, res) => {
  const { clientId, datetimeISO, message, repeat } = req.body || {};
  if (!clientId || !datetimeISO || !message) return res.status(400).json({ error: 'clientId, datetimeISO and message required' });
  const client = clients.find(c => c.id === Number(clientId));
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const dt = new Date(datetimeISO);
  if (isNaN(dt.getTime())) return res.status(400).json({ error: 'Invalid date' });
  if (dt.getTime() < Date.now() - 60*1000) return res.status(400).json({ error: 'Reminder must be in the future' });

  const rem = {
    id: nextId++,
    clientId: client.id,
    datetimeISO: dt.toISOString(),
    message: String(message).trim(),
    repeat: ['none','daily','weekly'].includes(repeat) ? repeat : 'none',
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    lastSentAt: null
  };
  reminders.push(rem);
  scheduleReminderIfDueSoon(rem); // schedule if soon
  addLog('Reminder', `Scheduled for ${client.name} at ${rem.datetimeISO}`);
  res.json(rem);
});

// POST /api/reminders/run-now  { reminderId }
app.post('/api/reminders/run-now', async (req, res) => {
  const { reminderId } = req.body || {};
  const rem = reminders.find(r => r.id === Number(reminderId));
  if (!rem) return res.status(404).json({ error: 'Reminder not found' });
  const client = clients.find(c => c.id === rem.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // try send
  const subject = `Follow-up: ${client.name}`;
  const text = `Hi ${client.name},\n\n${rem.message}\n\n— Sent by ClientPulse`;
  const result = await sendMail(client.email, subject, text);
  if (result.ok) {
    rem.lastSentAt = new Date().toISOString();
    if (rem.repeat === 'none') rem.status = 'sent';
    addLog('Send', `Reminder sent to ${client.email} (id ${rem.id})`);
    return res.json({ ok: true, reminder: rem });
  } else {
    rem.status = 'failed';
    addLog('Send', `Failed to send to ${client.email} — ${result.error || 'unknown'}`);
    return res.status(500).json({ ok: false, error: result.error || 'send failed' });
  }
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  res.json(logs.slice(0, 200));
});

// GET /api/export  -> returns JSON dump of clients & reminders
app.get('/api/export', (req, res) => {
  res.json({ clients, reminders, logs });
});

// -------------------- Scheduler (simple loop) --------------------
const SCHEDULER_INTERVAL_MS = 30 * 1000; // 30s

function scheduleReminderIfDueSoon(rem) {
  // nothing heavy here: the loop checks all reminders every interval
  // this function exists to indicate immediate scheduling if needed
}

async function checkDueReminders() {
  const now = Date.now();
  for (const rem of reminders) {
    if (rem.status === 'scheduled') {
      const due = new Date(rem.datetimeISO).getTime();
      // if due within past 30s to now+30s, try send
      if (due <= now + 30000 && due <= now + 60*1000) {
        const client = clients.find(c => c.id === rem.clientId);
        if (!client) {
          rem.status = 'failed';
          addLog('Scheduler', `Client missing for reminder ${rem.id}`);
          continue;
        }
        // send
        try {
          const subject = `Follow-up: ${client.name}`;
          const text = `Hi ${client.name},\n\n${rem.message}\n\n— Sent by ClientPulse`;
          const result = await sendMail(client.email, subject, text);
          if (result.ok) {
            rem.lastSentAt = new Date().toISOString();
            addLog('Scheduler', `Sent reminder ${rem.id} to ${client.email}`);
            if (rem.repeat === 'none') rem.status = 'sent';
            if (rem.repeat === 'daily') {
              // schedule next day
              const next = new Date(rem.datetimeISO);
              next.setDate(next.getDate() + 1);
              rem.datetimeISO = next.toISOString();
              addLog('Scheduler', `Rescheduled daily reminder ${rem.id} to ${rem.datetimeISO}`);
            } else if (rem.repeat === 'weekly') {
              const next = new Date(rem.datetimeISO);
              next.setDate(next.getDate() + 7);
              rem.datetimeISO = next.toISOString();
              addLog('Scheduler', `Rescheduled weekly reminder ${rem.id} to ${rem.datetimeISO}`);
            }
          } else {
            rem.status = 'failed';
            addLog('Scheduler', `Failed to send reminder ${rem.id} to ${client.email}`);
          }
        } catch (err) {
          rem.status = 'failed';
          addLog('Scheduler', `Exception sending reminder ${rem.id}: ${err.message}`);
        }
      }
    }
  }
}

// start loop
setInterval(() => {
  checkDueReminders().catch(err => {
    addLog('Scheduler', `Scheduler loop error: ${err.message}`);
  });
}, SCHEDULER_INTERVAL_MS);

// -------------------- UI fallback route (serve index.html) --------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start server
app.listen(PORT, () => {
  addLog('System', `ClientPulse server started on port ${PORT}`);
  console.log(`ClientPulse running on port ${PORT}`);
});
