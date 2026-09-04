/**
 * Seeds the doctor roster.
 *
 *   npm run seed
 *
 * The roster is deliberately uneven - different shift lengths, slot sizes and
 * working days - because that's what makes the triage agent's job non-trivial.
 * Dr. Arjun Rao is closed to new patients on purpose: it gives you a doctor the
 * agent has to reason its way past.
 */

import 'dotenv/config';
import { upsertEntity } from '../src/port.js';

const DOCTORS = [
  {
    identifier: 'dr_meera_iyer',
    title: 'Dr. Meera Iyer',
    properties: {
      specialty: 'paediatrics',
      email: 'meera.iyer@northgateclinic.example',
      working_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      shift_start: '09:00',
      shift_end: '13:00',
      slot_minutes: 20,
      max_daily_appointments: 12,
      accepting_new_patients: true,
      room: '101',
      languages: ['English', 'Kannada', 'Hindi'],
    },
  },
  {
    identifier: 'dr_arjun_rao',
    title: 'Dr. Arjun Rao',
    properties: {
      specialty: 'paediatrics',
      email: 'arjun.rao@northgateclinic.example',
      working_days: ['tue', 'thu', 'sat'],
      shift_start: '14:00',
      shift_end: '18:00',
      slot_minutes: 20,
      max_daily_appointments: 10,
      accepting_new_patients: false,
      room: '102',
      languages: ['English', 'Telugu'],
    },
  },
  {
    identifier: 'dr_kavya_nair',
    title: 'Dr. Kavya Nair',
    properties: {
      specialty: 'general_medicine',
      email: 'kavya.nair@northgateclinic.example',
      working_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
      shift_start: '09:00',
      shift_end: '17:00',
      slot_minutes: 15,
      max_daily_appointments: 24,
      accepting_new_patients: true,
      room: '201',
      languages: ['English', 'Malayalam', 'Hindi'],
    },
  },
  {
    identifier: 'dr_sanjay_gupta',
    title: 'Dr. Sanjay Gupta',
    properties: {
      specialty: 'dermatology',
      email: 'sanjay.gupta@northgateclinic.example',
      working_days: ['mon', 'wed', 'fri'],
      shift_start: '10:00',
      shift_end: '16:00',
      slot_minutes: 30,
      max_daily_appointments: 10,
      accepting_new_patients: true,
      room: '301',
      languages: ['English', 'Hindi'],
    },
  },
  {
    identifier: 'dr_farida_khan',
    title: 'Dr. Farida Khan',
    properties: {
      specialty: 'orthopaedics',
      email: 'farida.khan@northgateclinic.example',
      working_days: ['tue', 'thu'],
      shift_start: '09:00',
      shift_end: '15:00',
      slot_minutes: 30,
      max_daily_appointments: 10,
      accepting_new_patients: true,
      room: '401',
      languages: ['English', 'Urdu', 'Hindi'],
    },
  },
  {
    identifier: 'dr_vikram_shetty',
    title: 'Dr. Vikram Shetty',
    properties: {
      specialty: 'cardiology',
      email: 'vikram.shetty@northgateclinic.example',
      working_days: ['mon', 'wed', 'fri'],
      shift_start: '08:00',
      shift_end: '12:00',
      slot_minutes: 30,
      max_daily_appointments: 8,
      accepting_new_patients: true,
      room: '501',
      languages: ['English', 'Kannada', 'Tulu'],
    },
  },
  {
    identifier: 'dr_leena_das',
    title: 'Dr. Leena Das',
    properties: {
      specialty: 'ent',
      email: 'leena.das@northgateclinic.example',
      working_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      shift_start: '15:00',
      shift_end: '18:00',
      slot_minutes: 20,
      max_daily_appointments: 9,
      accepting_new_patients: true,
      room: '601',
      languages: ['English', 'Bengali', 'Hindi'],
    },
  },
];

async function main() {
  console.log('\nSeeding doctor roster…\n');

  for (const doctor of DOCTORS) {
    await upsertEntity('clinic_doctor', doctor);
    const open = doctor.properties.accepting_new_patients ? 'open' : 'CLOSED to new patients';
    console.log(`  ${doctor.title.padEnd(20)} ${doctor.properties.specialty.padEnd(18)} ${open}`);
  }

  console.log(`\n${DOCTORS.length} doctors seeded.\n`);
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
