/**
 * VEA Quiz -> ManyChat sync Worker
 * ------------------------------------------------------------------
 * Formspree fires a webhook to this Worker when the VEA quiz (vea2.html)
 * is submitted. The Worker:
 *   1. Verifies the shared webhook token (?token=<WEBHOOK_SECRET>).
 *   2. Parses the quiz submission (JSON or form-encoded).
 *   3. Resolves the target ManyChat subscriber (mc_id, email fallback).
 *   4. Writes the block-profile custom field on that contact.
 *   5. Adds a quiz-<profile> tag.
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
  bloqueo_vocal: 'Block Profile',
};

// Tag added to the contact: this prefix + the friendly profile slug.
const TAG_PREFIX = 'quiz-';

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

    const results = { fields: [], tag: null, errors: [] };

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

    // 6. Add the block-profile tag.
    if (profile) {
      const tagName = TAG_PREFIX + profile;
      try {
        await addTag(subscriberId, tagName, env);
        results.tag = tagName;
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
  return manychat('/fp/subscriber/setCustomFieldByName', {
    subscriber_id: subscriberId,
    field_name: fieldName,
    field_value: fieldValue,
  }, env);
}

async function addTag(subscriberId, tagName, env) {
  return manychat('/fp/subscriber/addTagByName', {
    subscriber_id: subscriberId,
    tag_name: tagName,
  }, env);
}

async function findSubscriberByEmail(email, env) {
  const url = `${MANYCHAT_API}/fp/subscriber/findBySystemField?email=${encodeURIComponent(email)}`;
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
