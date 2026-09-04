/**
 * Minimal Port.io API client.
 *
 * Port issues short-lived bearer tokens from a client id / secret pair.
 * We cache the token in memory and refresh it a minute before it expires,
 * so a busy form doesn't re-authenticate on every submission.
 */

const BASE_URL = process.env.PORT_API_URL || 'https://api.port.io/v1';

let cachedToken = null;
let tokenExpiresAt = 0;

/** Exchange the client credentials for a bearer token, reusing a live one when possible. */
export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const clientId = process.env.PORT_CLIENT_ID;
  const clientSecret = process.env.PORT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'PORT_CLIENT_ID and PORT_CLIENT_SECRET are not set. Copy .env.example to .env and fill them in.'
    );
  }

  const res = await fetch(`${BASE_URL}/auth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });

  if (!res.ok) {
    throw new Error(`Port auth failed (${res.status}): ${await res.text()}`);
  }

  const body = await res.json();
  cachedToken = body.accessToken;

  // Port returns expiresIn as a duration string or seconds depending on the
  // endpoint version. Fall back to a conservative 50 minutes either way.
  const seconds = Number(body.expiresIn) || 3000;
  tokenExpiresAt = Date.now() + (seconds - 60) * 1000;

  return cachedToken;
}

/** Authenticated fetch against the Port API. Throws on non-2xx with the response body attached. */
export async function portFetch(path, options = {}) {
  const token = await getAccessToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = new Error(`Port API ${options.method || 'GET'} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

/**
 * Create or update an entity.
 *
 * upsert=true   -> create if missing instead of 409-ing
 * merge=true    -> only touch the fields we send, leave everything else alone
 *
 * merge matters here: a returning patient booking a second appointment should
 * not have their existing notes wiped just because this form doesn't collect them.
 */
export function upsertEntity(blueprint, entity) {
  return portFetch(`/blueprints/${blueprint}/entities?upsert=true&merge=true`, {
    method: 'POST',
    body: JSON.stringify(entity),
  });
}

/** Fetch a single entity by identifier. */
export function getEntity(blueprint, identifier) {
  return portFetch(`/blueprints/${blueprint}/entities/${encodeURIComponent(identifier)}`);
}

/** List every entity of a blueprint. */
export function listEntities(blueprint) {
  return portFetch(`/blueprints/${blueprint}/entities`);
}

/**
 * Turn an email into a stable, safe entity identifier.
 *
 * This must stay byte-for-byte identical to the JQ expression used inside the
 * clinic_book_appointment workflow:
 *     .patient_email | ascii_downcase | gsub("[^a-z0-9]"; "_")
 * Otherwise the same person booking at the front desk and on the web would end
 * up as two separate patient records.
 */
export function patientIdFromEmail(email) {
  return String(email).toLowerCase().replace(/[^a-z0-9]/g, '_');
}
