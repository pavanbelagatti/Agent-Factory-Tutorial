# Northgate Clinic — an agentic booking system on Port.io

A working appointment system for a small clinic. A patient fills in a public web form; an agent
inside Port checks the real doctor roster, assigns a doctor, and emails the patient a confirmed
time — or explains why it couldn't book them.

Everything in this repo is already live in the Port org **Pavsy**. The repo exists so you can
read it, change it, and rebuild it from scratch.

---

## What actually runs where

The important design decision: **Port is the system of record and the agent runtime. The Node
server is a thin, dumb door.** The server never decides anything. It writes an appointment with
`status: pending` and stops. That write is the trigger.

```
  PATIENT                     YOUR BOX                      PORT.IO
  ───────                     ────────                      ───────

  booking form  ──POST──▶  Express server
  (public)                       │
                                 ├── upsert clinic_patient ──▶  catalog
                                 │
                                 └── upsert clinic_appointment ─▶ catalog
                                          status: pending           │
                                                                    │ ENTITY_CREATED
                                                                    ▼
                                                       ┌────────────────────────┐
                                                       │  clinic_triage_agent   │
                                                       ├────────────────────────┤
                                                       │ 1 look up patient      │
                                                       │ 2 pull doctor roster   │
                                                       │ 3 pull bookings        │
                                                       │ 4 AI: decide + assign  │
                                                       │ 5 condition: approved? │
                                                       │ 6 write back status    │
                                                       │ 7 email the patient    │
                                                       └────────────────────────┘
                                                                    │
  slip updates ◀──poll───  GET /api/appointments/:id ◀──────────────┘


  FRONT DESK ──▶ clinic_book_appointment (self-service form inside Port)
                        └── writes the same pending appointment ──▶ same agent
```

Two front doors, one brain. The front desk and the public form both produce a pending
appointment entity, and the same agent handles both. Adding a WhatsApp bot later means writing
one more entity — no changes to the agent.

### Why the agent is event-driven rather than a step in the form

If the triage logic lived inside the booking workflow, only that form could use it. As an
`ENTITY_CREATED` automation it's decoupled: anything that can create an appointment gets triage
for free, including a bulk CSV import or a phone operator typing into the Port UI directly.

---

## What's in the catalog

| Blueprint | Holds | Notable |
|---|---|---|
| `clinic_doctor` | The roster | `working_days`, `shift_start/end`, `slot_minutes`, `max_daily_appointments`, `accepting_new_patients` |
| `clinic_patient` | People | Keyed on a slug of their email, so repeat bookings reuse the record |
| `clinic_appointment` | Requests | `status` drives everything; `triage_reasoning` is the agent's audit trail |

`clinic_appointment` relates to both. `clinic_doctor` carries an aggregation counting confirmed
appointments, which is how you spot an overloaded doctor at a glance.

The roster is not configuration buried in a prompt — it's catalog data. Change Dr. Gupta's
Friday hours in the Port UI and the next booking respects it immediately. That's the whole
argument for doing this in Port rather than in application code.

---

## Setup

### 1. Get your Port credentials

In [app.port.io](https://app.port.io), click the `...` menu top-right → **Credentials**. Copy the
Client ID and Client Secret.

```bash
cd clinic-portal
cp .env.example .env
# paste PORT_CLIENT_ID and PORT_CLIENT_SECRET into .env
npm install
```

If your account is on `app.us.port.io`, change `PORT_API_URL` to `https://api.us.port.io/v1`.

### 2. Apply the catalog and workflows

```bash
npm run apply
```

Creates or updates three blueprints and two workflows. Idempotent — run it whenever you change a
JSON file. Blueprints are PATCHed (a deep merge, so it won't wipe fields you added in the UI);
workflows are PUT, which replaces the definition and cuts a new version.

> These already exist in your org. Running this will simply update them in place.

### 3. Seed the roster

```bash
npm run seed
```

Seven doctors across six departments, with deliberately uneven schedules. Dr. Arjun Rao is set
to `accepting_new_patients: false` on purpose — it gives the agent a doctor it has to reason
its way past, which is how you can tell it's actually reading the data.

### 4. Wire up email

The workflow posts to [Resend](https://resend.com) (free tier, no card). Two minutes:

1. Sign up, create an API key.
2. In Port: **Settings → Secrets → Add secret**, name it exactly `RESEND_API_KEY`, paste the key.

On Resend's free tier with the shared `onboarding@resend.dev` sender, you can only send to the
address you signed up with. To email real patients, verify a domain in Resend and change the
`from` field in `port/workflows/clinic_triage_agent.json`.

**Skipping this is fine.** Both notify nodes are `onFailure: "continue"`, so the booking still
confirms correctly and the patient message is still written to the entity — the email step just
records a 401 in the run log. That's exactly what happened on the first test run.

To send SMS instead, swap the node's `url`, `headers` and `body` for Twilio's. Nothing else changes.

### 5. Run the form

```bash
npm start
# → http://localhost:3000
```

---

## Try it

**The happy path.** Book paediatrics for a weekday morning. Watch the slip: it prints as
`AWAITING TRIAGE`, then fills in with Dr. Meera Iyer, a time, and a room. Roughly 30–40 seconds,
almost all of it the AI node.

**Make it work for its answer.** Book paediatrics for a *Saturday*. Dr. Iyer doesn't work
Saturdays; Dr. Rao does but is closed to new patients. The agent should shift you to the nearest
valid weekday slot and say so in the message.

**Emergency screening.** Enter something like "crushing chest pain and short of breath" under
cardiology. Rule 7 fires: the agent refuses to schedule and directs the patient to emergency
care. This is the one place the agent is allowed to reason about symptoms at all.

**Read the audit trail.** Open the appointment in Port → the **Agent reasoning** property. You
get a markdown table of every doctor considered and why each was eliminated. This is the
difference between an agent you can put in front of patients and one you can't.

---

## Things worth knowing before you change it

**Patient identifiers must match in two places.** `patientIdFromEmail()` in `src/port.js` and the
JQ expression `ascii_downcase | gsub("[^a-z0-9]"; "_")` in the booking workflow. If they drift,
the same person booking on the web and at the front desk becomes two patient records.

**Hyphens break JQ.** `.outputs.my-node.field` parses as subtraction. Every node identifier here
is snake_case for that reason.

**The AI node needs `outputSchema`.** Without it the model returns prose, the downstream
`UPSERT_ENTITY` silently writes nothing, and the run reports success. With it, `response` is a
JSON string you parse with `fromjson`.

**Workflows can't fan out.** One node, one target. That's why the nodes are chained
`fetch_patient → fetch_doctors → fetch_booked` rather than run in parallel.

**Catalog reads go through webhook nodes, not AI tools.** The AI node *can* call `list_entities`,
but it's unreliable — it returns nulls or quietly skips. Fetching over `https://api.port.io` from
a `WEBHOOK` node is deterministic, and calls to Port's own API from inside a workflow are
auto-authenticated, so there's no token to manage.

**`fetch_booked` pulls every appointment.** Fine at clinic scale, wrong at thousands. Swap it for
`POST /v1/entities/search` filtered to `status = confirmed` and a date window before this sees
real volume.

---

## Where this is a demo and not a product

Be honest with yourself about these before showing it to an actual clinic:

- **The AI owns the scheduling decision.** For a production system I'd invert it: compute valid
  slots deterministically in code, hand the agent a shortlist, and let it choose and write the
  patient message. Same UX, and the availability logic becomes testable. The current design is
  the better *tutorial* because you can see the whole decision in one prompt; it is not the
  better *architecture*.
- **No real slot locking.** Two requests arriving in the same few seconds both read the same
  bookings list and can be given the same slot. Real fix: a uniqueness constraint on
  doctor + confirmed_datetime, or a deterministic allocator with a lock.
- **Patient data is in a developer portal.** Port is not a healthcare-compliant store. Real
  patient records need to satisfy whatever regime applies to you — HIPAA, GDPR, India's DPDP Act.
  Keep the identifiers in Port and the medical record somewhere appropriate.
- **The rate limit is in-memory.** It resets on restart and doesn't survive more than one process.
- **No cancellation or reschedule flow.** A confirmed slot is never released.

---

## File map

```
port/blueprints/         data model, numbered — 04 depends on 03
port/workflows/          the two workflows, byte-identical to what's live
port/apply.js            pushes all of the above
scripts/seed-doctors.js  the roster
src/port.js              Port API client, token caching, email→id slug
src/server.js            three endpoints and a rate limiter
public/                  the booking form and the token slip
```
