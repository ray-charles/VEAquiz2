/**
 * VEA Quiz -> ManyChat sync Worker
 * ------------------------------------------------------------------
 * Formspree fires a webhook to this Worker when the VEA quiz (vea2.html)
 * is submitted. The Worker:
 *   1. Verifies the shared webhook token (?token=<WEBHOOK_SECRET>).
 *   2. Parses the quiz submission (JSON or form-encoded).
 *   3. Resolves the target ManyChat subscriber (mc_id, email fallback).
 *   4. Writes the contact's email / name / phone (enables Email & SMS channels).
 *   5. Writes the block-profile custom field on that contact.
 *   6. Adds a quiz-<profile> tag.
 *
 * Secrets (set via `wrangler secret put`, never committed):
 *   - MANYCHAT_API_KEY : ManyChat API token (sent as Bearer)
 *   - WEBHOOK_SECRET   : shared token Formspree appends as ?token=...
 */

const MANYCHAT_API = 'https://api.manychat.com';

// Which incoming Formspree field carries the quiz's block result.
// (vea2.html submits this as `bloqueo_vocal`.)
const BLOCK_PROFILE_SOURCE = 'bloqueo_vocal';

// Field that carries the ManyChat subscriber id from the quiz link.
const SUBSCRIBER_ID_FIELD = 'mc_id';

// Raw quiz result value (as emitted by vea2.html) -> friendly Spanish slug,
// used for both the "Block Profile" field value and the tag suffix.
const BLOCK_PROFILE_MAP = {
  mandibulaire: 'laringe',
  respiration:  'respiracion',
  nerveux:      'sistema_nervioso',
  identite:     'identidad_vocal',
};

// Formspree field name -> ManyChat custom field name to write into.
// Each ManyChat field listed here must already exist (created by name).
// The BLOCK_PROFILE_SOURCE field is written as its friendly mapped value.
const FIELD_MAP = {
  bloqueo_vocal:   'Bloqueo',
  objetivo_code:   'Voz ideal',
  compromiso_code: 'Compromiso',
};

// Tag added to the contact: this prefix + the friendly profile slug.
const TAG_PREFIX = 'bloqueo-';

// Extra segmentation tags from compact quiz codes: Formspree field -> tag prefix.
const CODE_TAGS = {
  compromiso_code: 'compromiso-',
  objetivo_code:   'objetivo-',
};

// Anchor tag added on every quiz sync. Use this as your single ManyChat
// automation trigger, then branch on the bloqueo- / compromiso- / objetivo- tags.
const COMPLETED_TAG = 'quiz-completado';

// Contact profile fields pushed into ManyChat so the Email/SMS channels can
// reach the lead. These name the incoming Formspree fields.
const PROFILE_EMAIL_FIELD = 'email';     // Formspree field carrying the email
const PROFILE_NAME_FIELD  = 'nombre';    // Formspree field carrying the full name
const PROFILE_PHONE_FIELD = 'telefono';  // Formspree field carrying the phone

// Set the email opt-in flag when an email is present. Keep this true only while
// the quiz lead form genuinely collects email consent (it shows a privacy note).
const EMAIL_OPT_IN = true;
// SMS opt-in stays false: ManyChat requires an explicit consent phrase for SMS,
// which the quiz does not capture. The phone is still stored for reference.
const SMS_OPT_IN = false;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    // 1. Verify the shared webhook token.
    const token = new URL(request.url).searchParams.get('token');
    if (!env.WEBHOOK_SECRET || token !== env.WEBHOOK_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }

    // 2. Parse the submission (Formspree may send JSON or form-encoded).
    let payload;
    try {
      payload = await parseBody(request);
    } catch (err) {
      return json({ error: 'bad_request', detail: 'unparseable body' }, 400);
    }

    // 3. Resolve the ManyChat subscriber id.
    let subscriberId = firstValue(payload, SUBSCRIBER_ID_FIELD);
    if (!subscriberId) {
      // Fallback: look the contact up by email if mc_id was not passed.
      const email = firstValue(payload, 'email');
      if (email) subscriberId = await findSubscriberByEmail(email, env);
    }
    if (!subscriberId) {
      return json({ error: 'no_subscriber', detail: 'mc_id missing and email lookup failed' }, 422);
    }

    // 4. Compute the friendly block profile.
    const rawBlock = firstValue(payload, BLOCK_PROFILE_SOURCE);
    const profile  = (rawBlock && BLOCK_PROFILE_MAP[rawBlock]) || rawBlock || '';

    const results = { profile: null, fields: [], tags: [], errors: [] };

    // 4b. Push the contact's email / name / phone so the Email & SMS channels
    //     can reach the lead. has_opt_in_email asserts consent (quiz privacy note).
    try {
      const updated = await updateProfile(subscriberId, payload, env);
      if (updated) results.profile = updated;
    } catch (err) {
      results.errors.push(`profile:${err.message}`);
    }

    // 5. Write mapped custom fields.
    for (const [formField, mcField] of Object.entries(FIELD_MAP)) {
      let value = firstValue(payload, formField);
      if (formField === BLOCK_PROFILE_SOURCE) value = profile;
      if (value === undefined || value === null || value === '') continue;
      try {
        await setCustomField(subscriberId, mcField, value, env);
        results.fields.push(mcField);
      } catch (err) {
        results.errors.push(`field:${mcField}:${err.message}`);
      }
    }

    // 6. Add tags: block profile, the quiz-answer codes, and the anchor.
    const tagsToAdd = [];
    if (profile) tagsToAdd.push(TAG_PREFIX + profile);
    for (const [field, prefix] of Object.entries(CODE_TAGS)) {
      const code = firstValue(payload, field);
      if (code) tagsToAdd.push(prefix + code);
    }
    if (COMPLETED_TAG) tagsToAdd.push(COMPLETED_TAG);
    for (const tagName of tagsToAdd) {
      try {
        await addTag(subscriberId, tagName, env);
        results.tags.push(tagName);
      } catch (err) {
        results.errors.push(`tag:${tagName}:${err.message}`);
      }
    }

    const status = results.errors.length ? 502 : 200;
    return json({ ok: status === 200, subscriber_id: subscriberId, ...results }, status);
  },
};

// ---------------------------------------------------------------- helpers

async function parseBody(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    return await request.json();
  }
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const obj = {};
    for (const [k, v] of form.entries()) obj[k] = v;
    return obj;
  }
  // Last resort: try JSON, then form text.
  const text = await request.text();
  try { return JSON.parse(text); }
  catch { return Object.fromEntries(new URLSearchParams(text)); }
}

// Formspree may nest fields; check top level then common containers.
function firstValue(payload, key) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (payload[key] !== undefined) return payload[key];
  for (const container of ['data', 'submission', 'fields', 'form']) {
    const c = payload[container];
    if (c && typeof c === 'object' && c[key] !== undefined) return c[key];
  }
  return undefined;
}

async function setCustomField(subscriberId, fieldName, fieldValue, env) {
  return manychat('/fb/subscriber/setCustomFieldByName', {
    subscriber_id: subscriberId,
    field_name: fieldName,
    field_value: fieldValue,
  }, env);
}

async function addTag(subscriberId, tagName, env) {
  return manychat('/fb/subscriber/addTagByName', {
    subscriber_id: subscriberId,
    tag_name: tagName,
  }, env);
}

// Set email / name / phone on the contact via updateSubscriber so ManyChat's
// Email (and SMS) channels can reach them. Returns the list of fields written,
// or null if the submission carried nothing to write.
async function updateProfile(subscriberId, payload, env) {
  const body = { subscriber_id: toId(subscriberId) };

  const name = firstValue(payload, PROFILE_NAME_FIELD);
  if (name) {
    const parts = String(name).trim().split(/\s+/);
    body.first_name = parts.shift() || String(name);
    if (parts.length) body.last_name = parts.join(' ');
  }
  const email = firstValue(payload, PROFILE_EMAIL_FIELD);
  if (email) { body.email = String(email); body.has_opt_in_email = EMAIL_OPT_IN; }
  const phone = firstValue(payload, PROFILE_PHONE_FIELD);
  if (phone) { body.phone = String(phone); body.has_opt_in_sms = SMS_OPT_IN; }

  if (Object.keys(body).length <= 1) return null; // only subscriber_id -> nothing to do

  try {
    await manychat('/fb/subscriber/updateSubscriber', body, env);
    return Object.keys(body).filter(k => k !== 'subscriber_id');
  } catch (err) {
    // "email already exists" just means the contact already has this email (the
    // desired state). Drop the email and retry so name/phone still update.
    if (/already exists/i.test(err.message) && body.email) {
      delete body.email;
      delete body.has_opt_in_email;
      if (Object.keys(body).length <= 1) return ['email(already set)'];
      await manychat('/fb/subscriber/updateSubscriber', body, env);
      return Object.keys(body).filter(k => k !== 'subscriber_id').concat('email(already set)');
    }
    throw err;
  }
}

// ManyChat's updateSubscriber wants subscriber_id as an integer.
function toId(v) {
  return /^\d+$/.test(String(v)) ? Number(v) : v;
}

async function findSubscriberByEmail(email, env) {
  const url = `${MANYCHAT_API}/fb/subscriber/findBySystemField?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.MANYCHAT_API_KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const data = body && body.data;
  if (Array.isArray(data)) return (data[0] && (data[0].id || data[0].subscriber_id)) || null;
  if (data && (data.id || data.subscriber_id)) return data.id || data.subscriber_id;
  return null;
}

async function manychat(path, body, env) {
  const res = await fetch(MANYCHAT_API + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MANYCHAT_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`manychat ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
