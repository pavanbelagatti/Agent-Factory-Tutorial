/* Northgate Clinic booking form.
   Submits to our own server, then polls until Port's triage agent resolves the
   appointment. The slip fills in live. */

const $ = (id) => document.getElementById(id);

const form = $('booking-form');
const formPanel = $('form-panel');
const slip = $('slip');
const errorBox = $('form-error');
const submitBtn = $('submit');

let pollTimer = null;

/* ------------------------------------------------------------ departments */

async function loadDepartments() {
  const box = $('departments');

  try {
    const res = await fetch('/api/departments');
    if (!res.ok) throw new Error('unreachable');

    const { departments } = await res.json();

    if (!departments.length) {
      box.innerHTML =
        '<p class="chips__empty">No departments are taking bookings right now. Please call the clinic.</p>';
      return;
    }

    box.innerHTML = departments
      .map(
        (d, i) => `
        <label class="chip">
          <input type="radio" name="specialty" value="${d.value}" ${i === 0 ? 'checked' : ''} />
          <span>${d.label}</span>
        </label>`
      )
      .join('');
  } catch {
    box.innerHTML =
      '<p class="chips__empty">Could not load departments. Refresh the page to try again.</p>';
  }
}

/* -------------------------------------------------------------- slots */

let selectedSlot = null;

async function loadSlots() {
  const specialty = document.querySelector('input[name="specialty"]:checked')?.value;
  const date = $('date').value;
  const section = $('slots-section');
  const box = $('slot-chips');
  const hint = $('slots-hint');

  selectedSlot = null;

  if (!specialty || !date) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  box.innerHTML = '<p class="chips__loading">Checking availability…</p>';
  hint.textContent = '';

  try {
    const res = await fetch(`/api/slots?specialty=${specialty}&date=${date}`);
    if (!res.ok) throw new Error('unreachable');

    const { slots, message } = await res.json();

    if (!slots.length) {
      box.innerHTML = `<p class="slots-empty">${message || 'No slots available on this date.'}</p>`;
      hint.textContent = 'Try a different date or department.';
      return;
    }

    box.className = 'chips chips--slots';
    box.innerHTML = slots
      .map(
        (s, i) => `
        <label class="chip">
          <input type="radio" name="slot" value="${s.utc}"
                 data-doctor="${s.doctor}" data-room="${s.room}" data-label="${s.label}"
                 ${i === 0 ? '' : ''} />
          <span>${s.label}<em class="chip-detail">${s.doctor}</em></span>
        </label>`
      )
      .join('');

    hint.textContent = `${slots.length} slot${slots.length > 1 ? 's' : ''} available.`;

    // Track selection
    box.querySelectorAll('input[name="slot"]').forEach((input) => {
      input.addEventListener('change', () => {
        selectedSlot = {
          utc: input.value,
          doctor: input.dataset.doctor,
          room: input.dataset.room,
          label: input.dataset.label,
        };
      });
    });
  } catch {
    box.innerHTML = '<p class="chips__empty">Could not load slots. Refresh to try again.</p>';
  }
}

// Reload slots when department or date changes
document.addEventListener('change', (e) => {
  if (e.target.name === 'specialty' || e.target.id === 'date') {
    loadSlots();
  }
});

/* ---------------------------------------------------------------- helpers */

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
  errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearError() {
  errorBox.hidden = true;
}

function prettyDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function titleCase(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function setStatus(state, text) {
  const el = $('slip-status');
  el.dataset.state = state;
  $('slip-status-text').textContent = text;
}

/* ----------------------------------------------------------------- submit */

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const data = Object.fromEntries(new FormData(form));

  if (!data.specialty) {
    showError('Pick a department.');
    return;
  }
  if (!data.date) {
    showError('Pick a date.');
    return;
  }
  if (!selectedSlot) {
    showError('Pick an available time slot.');
    return;
  }

  const preferred = new Date(selectedSlot.utc);

  submitBtn.disabled = true;
  submitBtn.querySelector('.submit__label').textContent = 'Sending…';

  try {
    const res = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: data.full_name,
        email: data.email,
        phone: data.phone,
        age: data.age,
        specialty: data.specialty,
        preferred_datetime: preferred.toISOString(),
        symptoms: data.symptoms,
      }),
    });

    const body = await res.json();

    if (!res.ok) {
      showError(body.error || 'Something went wrong. Please try again.');
      return;
    }

    renderSlip(body.id, data, preferred);
    startPolling(body.id);
  } catch {
    showError('Could not reach the clinic system. Check your connection and try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector('.submit__label').textContent = 'Request appointment';
  }
});

/* ------------------------------------------------------------------- slip */

function renderSlip(id, data, preferred) {
  $('slip-ref').textContent = id.replace('apt_web_', '').toUpperCase();
  $('slip-name').textContent = data.full_name;
  $('slip-dept').textContent = titleCase(data.specialty);
  $('slip-requested').textContent = prettyDateTime(preferred.toISOString());

  setStatus('pending', 'Awaiting triage');

  formPanel.hidden = true;
  slip.hidden = false;
  slip.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------------------------------------------------------- polling */

function startPolling(id) {
  const startedAt = Date.now();
  const TIMEOUT_MS = 3 * 60 * 1000;

  clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      clearInterval(pollTimer);
      setStatus('pending', 'Still working');
      $('slip-foot').textContent =
        'This is taking longer than usual. Your request is filed — we will email you.';
      return;
    }

    try {
      const res = await fetch(`/api/appointments/${id}`);
      if (!res.ok) return;

      const a = await res.json();

      // The multi-agent pipeline moves through several statuses before
      // reaching a terminal state. Keep polling on anything in-flight.
      const IN_FLIGHT = ['pending', 'validated', 'scheduled', 'approved'];
      if (IN_FLIGHT.includes(a.status)) {
        // Update the slip with progress so the patient knows it's working
        const stage = {
          pending: 'Screening your request…',
          validated: 'Assigning your doctor…',
          scheduled: 'Reviewing the assignment…',
          approved: 'Preparing your confirmation…',
        };
        setStatus('pending', stage[a.status] || 'Working…');
        return;
      }

      // Terminal states — stop polling
      clearInterval(pollTimer);

      if (a.status === 'confirmed') {
        setStatus('confirmed', 'Confirmed');
        $('slip-doctor').textContent = a.doctor || '—';
        $('slip-time').textContent = prettyDateTime(a.confirmed_datetime);
        $('slip-room').textContent = a.room ? `Room ${a.room}` : '—';
        $('slip-outcome').hidden = false;
        $('slip-foot').textContent = 'A confirmation email is on its way.';
      } else if (a.status === 'flagged_for_review') {
        setStatus('pending', 'Under review');
        $('slip-foot').textContent =
          'Your request needs a little extra attention. A staff member will call you within 24 hours.';
      } else {
        setStatus('rejected', 'Not booked');
        $('slip-foot').textContent = 'Nothing has been scheduled. Please read the note above.';
      }

      if (a.message) $('slip-message').textContent = a.message;
    } catch {
      // Transient network blip — keep polling.
    }
  }, 3000);
}

/* ------------------------------------------------------------- book again */

$('book-again').addEventListener('click', () => {
  clearInterval(pollTimer);
  form.reset();
  selectedSlot = null;
  $('slots-section').hidden = true;
  $('slip-outcome').hidden = true;
  $('slip-message').textContent = '';
  $('slip-foot').textContent = 'Keep this reference. A confirmation email is on its way.';
  slip.hidden = true;
  formPanel.hidden = false;
  loadDepartments();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* -------------------------------------------------------------------- init */

// Default the date picker to tomorrow — nobody books for "right now" on a form.
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
$('date').value = tomorrow.toISOString().slice(0, 10);
$('date').min = new Date().toISOString().slice(0, 10);

loadDepartments();