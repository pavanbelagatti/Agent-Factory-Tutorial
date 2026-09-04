import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { upsertEntity, getEntity, listEntities, patientIdFromEmail } from './port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

const SPECIALTIES = [
  'paediatrics',
  'general_medicine',
  'dermatology',
  'orthopaedics',
  'cardiology',
  'ent',
];

/* --------------------------------------------------------------------------
 * Crude per-IP rate limit.
 *
 * A public booking form is an open door to your catalog. This is deliberately
 * simple and in-memory; in front of real traffic put a real limiter (or a WAF)
 * here instead. The point is that the door is not wide open by default.
 * ----------------------------------------------------------------------- */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    return res.status(429).json({
      error: 'Too many requests from this address. Try again in a few minutes, or call the clinic.',
    });
  }

  recent.push(now);
  hits.set(ip, recent);
  next();
}

/* --------------------------------------------------------------------------
 * GET /api/departments
 *
 * Derived live from the catalog, not hardcoded in the frontend. If every doctor
 * in a department switches off accepting_new_patients, that department stops
 * appearing on the form. The roster is the source of truth.
 * ----------------------------------------------------------------------- */
app.get('/api/departments', async (_req, res) => {
  try {
    const { entities } = await listEntities('clinic_doctor');
    const open = new Set(
      entities
        .filter((d) => d.properties?.accepting_new_patients)
        .map((d) => d.properties?.specialty)
        .filter(Boolean)
    );

    res.json({
      departments: SPECIALTIES.filter((s) => open.has(s)).map((s) => ({
        value: s,
        label: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      })),
    });
  } catch (err) {
    console.error('Could not load departments:', err.message, err.body ?? '');
    res.status(502).json({ error: 'Could not reach the clinic system.' });
  }
});

/* --------------------------------------------------------------------------
 * GET /api/slots?specialty=ent&date=2026-08-27
 *
 * Deterministic slot computation. No AI involved. Reads the doctor roster
 * and existing bookings, generates every valid slot on the requested date,
 * and removes the ones already taken. The frontend shows these as clickable
 * chips instead of a free-form time picker.
 * ----------------------------------------------------------------------- */
app.get('/api/slots', async (req, res) => {
  const { specialty, date } = req.query;

  if (!specialty || !SPECIALTIES.includes(specialty)) {
    return res.status(400).json({ error: 'Valid specialty required.' });
  }
  if (!date || Number.isNaN(Date.parse(date))) {
    return res.status(400).json({ error: 'Valid date required (YYYY-MM-DD).' });
  }

  try {
    const [{ entities: doctors }, { entities: appointments }] = await Promise.all([
      listEntities('clinic_doctor'),
      listEntities('clinic_appointment'),
    ]);

    const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    // What day of the week is this date in IST?
    const dateIST = new Date(date + 'T00:00:00+05:30');
    const weekday = DAY_NAMES[dateIST.getUTCDay()];

    // Eligible doctors: right specialty, accepting patients, works this day
    const eligible = doctors.filter(
      (d) =>
        d.properties?.specialty === specialty &&
        d.properties?.accepting_new_patients &&
        (d.properties?.working_days || []).includes(weekday)
    );

    if (!eligible.length) {
      return res.json({
        slots: [],
        message: `No ${specialty.replace(/_/g, ' ')} doctors work on ${weekday.charAt(0).toUpperCase() + weekday.slice(1)}s.`,
      });
    }

    // All confirmed/scheduled/approved bookings, mapped to { doctor, utcMs }
    const booked = appointments
      .filter((a) => ['confirmed', 'scheduled', 'approved'].includes(a.properties?.status))
      .map((a) => ({
        doctor: a.relations?.doctor,
        utcMs: a.properties?.confirmed_datetime
          ? new Date(a.properties.confirmed_datetime).getTime()
          : null,
      }))
      .filter((b) => b.utcMs !== null);

    const now = Date.now();
    const slots = [];

    for (const doc of eligible) {
      const [startH, startM] = (doc.properties?.shift_start || '09:00').split(':').map(Number);
      const [endH, endM] = (doc.properties?.shift_end || '17:00').split(':').map(Number);
      const step = doc.properties?.slot_minutes || 20;
      const maxPerDay = doc.properties?.max_daily_appointments || 10;

      // Count how many bookings this doctor already has on this date
      const datePrefix = date; // YYYY-MM-DD
      const doctorBookingsToday = booked.filter((b) => {
        if (b.doctor !== doc.identifier) return false;
        const bIST = new Date(b.utcMs + 330 * 60 * 1000); // UTC → IST
        return bIST.toISOString().slice(0, 10) === datePrefix;
      });

      if (doctorBookingsToday.length >= maxPerDay) continue;

      let h = startH;
      let m = startM;
      const shiftEndMin = endH * 60 + endM;

      while (h * 60 + m + step <= shiftEndMin) {
        // Build the IST timestamp for this slot
        const hh = String(h).padStart(2, '0');
        const mm = String(m).padStart(2, '0');
        const slotISO = new Date(`${date}T${hh}:${mm}:00+05:30`);
        const slotMs = slotISO.getTime();

        // Skip past slots
        if (slotMs > now) {
          // Check if taken
          const taken = booked.some(
            (b) => b.doctor === doc.identifier && b.utcMs === slotMs
          );

          if (!taken) {
            // Format readable label
            const hour12 = h % 12 || 12;
            const ampm = h < 12 ? 'AM' : 'PM';
            const label = `${hour12}:${mm} ${ampm}`;

            slots.push({
              time: `${hh}:${mm}`,
              label,
              doctor: doc.title,
              doctor_id: doc.identifier,
              room: doc.properties?.room || '',
              utc: slotISO.toISOString(),
            });
          }
        }

        m += step;
        if (m >= 60) {
          h += Math.floor(m / 60);
          m = m % 60;
        }
      }
    }

    // Sort by time, then by doctor name
    slots.sort((a, b) => a.time.localeCompare(b.time) || a.doctor.localeCompare(b.doctor));

    res.json({ slots, date, specialty, weekday });
  } catch (err) {
    console.error('Could not compute slots:', err.message, err.body ?? '');
    res.status(502).json({ error: 'Could not reach the clinic system.' });
  }
});

/* --------------------------------------------------------------------------
 * POST /api/appointments
 *
 * Writes two entities and then gets out of the way. Creating the appointment
 * with status "pending" is what fires the clinic_triage_agent workflow inside
 * Port. This server never decides anything clinical.
 * ----------------------------------------------------------------------- */
app.post('/api/appointments', rateLimit, async (req, res) => {
  const { full_name, email, phone, age, specialty, preferred_datetime, symptoms } = req.body || {};

  const problems = [];
  if (!full_name || String(full_name).trim().length < 2) problems.push('a name');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('a valid email address');
  if (!SPECIALTIES.includes(specialty)) problems.push('a department');
  if (!preferred_datetime || Number.isNaN(Date.parse(preferred_datetime))) problems.push('a date and time');
  if (!symptoms || String(symptoms).trim().length < 5) problems.push('a reason for the visit');

  if (problems.length) {
    return res.status(400).json({ error: `Please add ${problems.join(', ')}.` });
  }

  const patientId = patientIdFromEmail(email);
  const appointmentId = `apt_web_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  try {
    await upsertEntity('clinic_patient', {
      identifier: patientId,
      title: String(full_name).trim(),
      properties: {
        email: String(email).toLowerCase().trim(),
        phone: phone ? String(phone).trim() : '',
        ...(age ? { age: Number(age) } : {}),
      },
    });

    // This POST is the trigger. The moment it lands with status "pending",
    // Port's ENTITY_CREATED event fires clinic_triage_agent.
    await upsertEntity('clinic_appointment', {
      identifier: appointmentId,
      title: `${String(full_name).trim()} - ${specialty}`,
      properties: {
        status: 'pending',
        source: 'web_form',
        requested_specialty: specialty,
        requested_datetime: new Date(preferred_datetime).toISOString(),
        symptoms: String(symptoms).trim(),
        urgency: 'routine',
      },
      relations: { patient: patientId },
    });

    res.status(202).json({ id: appointmentId, status: 'pending' });
  } catch (err) {
    console.error('Booking failed:', err.message, err.body ?? '');
    res.status(502).json({ error: 'Could not file your request. Please call the clinic.' });
  }
});

/* --------------------------------------------------------------------------
 * GET /api/appointments/:id
 *
 * The browser polls this while the agent works. Only fields safe to show a
 * patient are returned - the internal triage_reasoning stays in Port for staff.
 * ----------------------------------------------------------------------- */
app.get('/api/appointments/:id', async (req, res) => {
  const { id } = req.params;

  if (!/^apt_[a-zA-Z0-9_]+$/.test(id)) {
    return res.status(400).json({ error: 'Unknown reference.' });
  }

  try {
    const { entity } = await getEntity('clinic_appointment', id);
    const p = entity.properties || {};

    let doctorName = null;
    let room = null;

    if (entity.relations?.doctor) {
      try {
        const { entity: doc } = await getEntity('clinic_doctor', entity.relations.doctor);
        doctorName = doc.title;
        room = doc.properties?.room ?? null;
      } catch {
        // A missing doctor record shouldn't blank out the whole slip.
      }
    }

    res.json({
      id,
      status: p.status,
      department: p.requested_specialty,
      requested_datetime: p.requested_datetime,
      confirmed_datetime: p.confirmed_datetime,
      message: p.patient_message,
      doctor: doctorName,
      room,
    });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Unknown reference.' });
    console.error('Lookup failed:', err.message, err.body ?? '');
    res.status(502).json({ error: 'Could not reach the clinic system.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Northgate Clinic booking form → http://localhost:${PORT}\n`);
});