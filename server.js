// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const {google} = require('googleapis');
const twilio = require('twilio');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- FIRESTORE (opcional, mas recomendado) ---
if (!admin.apps.length) {
  // You can use a Firebase service account if you want; below we init with env JSON (string)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    // If you don't want Firestore, skip this init and just comment out Firestore usage below.
    console.warn('WARNING: Firestore not initialized. Set FIREBASE_SERVICE_ACCOUNT env to enable DB storage.');
  }
}

const db = admin.apps.length ? admin.firestore() : null;

// --- Google Calendar auth (service account)
const keys = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || fs.readFileSync('./service-account-key.json').toString());
const auth = new google.auth.JWT(
  keys.client_email,
  null,
  keys.private_key,
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({version: 'v3', auth});
const CALENDAR_ID = process.env.GCAL_ID || 'primary'; // use the calendar id you shared with the service account

// --- Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // ex: 'whatsapp:+14155238886'

// Helpers
function toISO(dateStr, timeStr, tz = process.env.DEFAULT_TZ || 'Europe/Lisbon') {
  // dateStr 'YYYY-MM-DD', timeStr 'HH:MM'
  // Returns ISO string with timezone offset (simple approach)
  const iso = new Date(`${dateStr}T${timeStr}:00`).toISOString();
  return iso;
}

// Check availability in time window
async function isAvailable(startISO, endISO) {
  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items || []).length === 0;
}

app.post('/api/book', async (req, res) => {
  try {
    const { service, date, time, duration = 60, name, phone, email } = req.body;
    if (!service || !date || !time || !name || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // start and end ISO (basic)
    const startISO = toISO(date, time);
    const endDate = new Date(startISO);
    endDate.setMinutes(endDate.getMinutes() + Number(duration));
    const endISO = endDate.toISOString();

    // 1) check availability
    const available = await isAvailable(startISO, endISO);
    if (!available) return res.status(409).json({ error: 'Slot not available' });

    // 2) store in Firestore (optional)
    let bookingRef = null;
    if (db) {
      bookingRef = await db.collection('bookings').add({
        service, date, time, duration, name, phone, email, status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // 3) create event on calendar
    const event = {
      summary: `AZ Clean — ${service} - ${name}`,
      description: `Cliente: ${name}\nTelefone: ${phone}\nEmail: ${email || '-'}\nServiço: ${service}`,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      // attendees: email ? [{ email }] : undefined,
    };

    const insertRes = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    // Update Firestore with event id
    if (db && bookingRef) {
      await bookingRef.update({ status: 'confirmed', calendarEventId: insertRes.data.id });
    }

    // 4) send WhatsApp confirmation via Twilio (if sandbox/number configured)
    if (TWILIO_WHATSAPP_FROM) {
      const bodyMsg = `AZ Clean: Olá ${name}! Sua marcação para ${service} foi confirmada em ${date} às ${time}. Obrigado!`;
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${phone.startsWith('+') ? phone : '+' + phone}`,
        body: bodyMsg,
      });
    }

    return res.json({ success: true, eventId: insertRes.data.id, bookingId: bookingRef ? bookingRef.id : null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro interno', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
