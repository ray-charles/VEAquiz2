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
 *   - MANYCHAT_API_KEY      : ManyChat API token (sent as Bearer)
 *   - WEBHOOK_SECRET        : shared token Formspree appends as ?token=...
 *   - STRIPE_WEBHOOK_SECRET : Stripe signing secret (whsec_...) for POST /stripe,
 *                             which tags buyers `compro-academia` matched by email.
 *                             Membership/annual purchases also get `membership_active`,
 *                             the suppression key for the weekly-webinar funnel.
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

// Tag applied (contact matched by email) when Stripe reports a paid purchase at
// POST /stripe. Lets your retargeting suppress buyers. (Already created in ManyChat.)
const PURCHASE_TAG = 'compro-academia';

// Product-specific buyer tags, added alongside PURCHASE_TAG.
const PRODUCT_TAG_KIT = 'compro-kit';              // $47 one-time (Tu Voz Auténtica)
const PRODUCT_TAG_MEMBERSHIP = 'compro-membresia'; // recurring membership ($27/mo or $444/yr annual)

// Suppression key for the weekly-webinar funnel: applied to anyone with an active
// (recurring) membership so the webinar's sales sends skip current members. Added
// alongside PRODUCT_TAG_MEMBERSHIP — i.e. whenever a subscription/invoice purchase
// fires, never on the one-time kit. (Create this tag in ManyChat: `membership_active`.)
const MEMBERSHIP_ACTIVE_TAG = 'membership_active';

// Stripe events that mean "money received" (one-time checkout + subscription invoices).
// Narrowed to these so a single purchase isn't double-counted via charge/payment_intent.
const STRIPE_PURCHASE_EVENTS = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_succeeded',
]);

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

    // Stripe purchase webhook lives at POST /stripe (signature auth, not ?token=).
    if (new URL(request.url).pathname === '/stripe') {
      return handleStripe(request, env);
    }

    // One-time webinar tag/field provisioning (guarded by ?token=ADMIN_SECRET).
    if (new URL(request.url).pathname === '/admin/webinar-setup') {
      return handleWebinarSetup(request, env);
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
    //    mc_id must be a numeric ManyChat id. An unresolved merge field
    //    ("{{Contact Id}}"), empty, or any non-numeric value is treated as "no id".
    const rawId = String(firstValue(payload, SUBSCRIBER_ID_FIELD) || '').trim();
    let subscriberId = /^\d+$/.test(rawId) ? rawId : null;
    let createdContact = false;

    if (!subscriberId) {
      // No usable mc_id: identify by email, creating an email contact if new,
      // so every quiz-taker still lands in ManyChat for (email) retargeting.
      const email = firstValue(payload, 'email');
      if (email) {
        subscriberId = await findSubscriberByEmail(email, env);
        if (!subscriberId) {
          subscriberId = await createEmailSubscriber(payload, env);
          createdContact = !!subscriberId;
        }
      }
    }
    if (!subscriberId) {
      return json({ error: 'no_subscriber', detail: 'no valid mc_id and no email to match/create' }, 422);
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
    return json({ ok: status === 200, subscriber_id: subscriberId, created: createdContact, ...results }, status);
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

// Create a ManyChat email subscriber from the quiz payload (used when there is
// no usable mc_id and no existing contact). Returns the new subscriber id or null.
async function createEmailSubscriber(payload, env) {
  const email = firstValue(payload, PROFILE_EMAIL_FIELD);
  if (!email) return null;
  const parts = String(firstValue(payload, PROFILE_NAME_FIELD) || '').trim().split(/\s+/).filter(Boolean);
  const body = {
    first_name: parts.shift() || String(email).split('@')[0],
    last_name: parts.join(' ') || '-',
    email: String(email),
    has_opt_in_email: EMAIL_OPT_IN,
  };
  const phone = firstValue(payload, PROFILE_PHONE_FIELD);
  if (phone) { body.phone = String(phone); body.has_opt_in_sms = SMS_OPT_IN; }
  try {
    const res = await manychat('/fb/subscriber/createSubscriber', body, env);
    const d = res && res.data;
    return (d && (d.id || d.subscriber_id)) || null;
  } catch (err) {
    // Existing contact -> use it. Any other error (notably ManyChat's
    // "Permission denied to import email" gate) -> give up gracefully so the
    // request never 500s. Enable email import in ManyChat to turn this on.
    if (/exists/i.test(err.message)) {
      try { return await findSubscriberByEmail(email, env); } catch (_) { return null; }
    }
    return null;
  }
}

// ---------------------------------------------------------------- Stripe

// POST /stripe : verify Stripe's signature, then on a paid-purchase event tag the
// matching ManyChat contact (by email) so retargeting can suppress buyers.
async function handleStripe(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'stripe_not_configured' }, 503);

  const raw = await request.text();
  const ok = await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'bad_signature' }, 400);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }

  // Acknowledge (200) non-purchase events so Stripe doesn't retry them.
  if (!STRIPE_PURCHASE_EVENTS.has(event.type)) return json({ ok: true, ignored: event.type }, 200);

  const email = extractStripeEmail(event);
  if (!email) return json({ ok: false, reason: 'no_email_in_event', type: event.type }, 200);

  const subscriberId = await findSubscriberByEmail(email, env);
  if (!subscriberId) return json({ ok: false, reason: 'no_manychat_contact', email }, 200);

  // Always add the universal buyer tag (drives suppression + Purchase Welcome),
  // plus the product-specific tag when the event tells us which product it was.
  const tags = [PURCHASE_TAG];
  const productTag = stripeProductTag(event);
  if (productTag) tags.push(productTag);
  // Membership purchases also carry the webinar-funnel suppression key.
  if (productTag === PRODUCT_TAG_MEMBERSHIP) tags.push(MEMBERSHIP_ACTIVE_TAG);

  const applied = [];
  for (const tag of tags) {
    try {
      await addTag(subscriberId, tag, env);
      applied.push(tag);
    } catch (err) {
      return json({ ok: false, error: err.message, applied }, 502);
    }
  }
  return json({ ok: true, tagged: applied, subscriber_id: subscriberId }, 200);
}

// Map a Stripe purchase event to its product-specific tag (null if undetermined).
// Uses checkout mode (payment = one-time kit, subscription = membership) and treats
// recurring invoices as membership. Amount-agnostic, so coupons don't break it.
function stripeProductTag(event) {
  const o = (event.data && event.data.object) || {};
  if (event.type === 'checkout.session.completed') {
    if (o.mode === 'subscription') return PRODUCT_TAG_MEMBERSHIP;
    if (o.mode === 'payment') return PRODUCT_TAG_KIT;
    return null;
  }
  return PRODUCT_TAG_MEMBERSHIP; // invoice.paid / invoice.payment_succeeded
}

// Pull the buyer's email from whichever Stripe object the event carries.
function extractStripeEmail(event) {
  const o = (event && event.data && event.data.object) || {};
  return (o.customer_details && o.customer_details.email)
    || o.customer_email
    || (o.billing_details && o.billing_details.email)
    || o.receipt_email
    || (o.charges && o.charges.data && o.charges.data[0] && o.charges.data[0].billing_details && o.charges.data[0].billing_details.email)
    || null;
}

// Verify the Stripe-Signature header (scheme: "t=<ts>,v1=<hmac>") with HMAC-SHA256
// over `${t}.${rawBody}`, plus a 5-minute timestamp tolerance to block replays.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  for (const kv of sigHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  // Replay guard: reject signatures whose timestamp is more than 5 minutes old.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, v1);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------- Webinar setup

// POST /admin/webinar-setup?token=<ADMIN_SECRET>&cohort=W1
// One-time, idempotent provisioning of the weekly-webinar tags + custom fields via
// the ManyChat page API. Uses the Worker's own MANYCHAT_API_KEY, so the token never
// leaves Cloudflare. Re-run with &cohort=W2 (etc.) to add each new cohort's tags.
async function handleWebinarSetup(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  if (!env.ADMIN_SECRET || !timingSafeEqual(token, env.ADMIN_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const cohort = (url.searchParams.get('cohort') || 'W1').trim();
  if (!/^W\d+$/.test(cohort)) return json({ error: 'bad_cohort', detail: 'use W<n>, e.g. W1' }, 400);

  const tags = [
    'membership_active', 'webinar_nobuy', 'long_nurture',
    'webinar_cycle_1', 'webinar_cycle_2', 'webinar_cycle_3', 'webinar_cycle_4',
    `webinar_registered_${cohort}`, `webinar_attended_${cohort}`, `webinar_noshow_${cohort}`,
  ];
  const fields = [
    { caption: 'webinar_date', type: 'text' },
    { caption: 'registration_source', type: 'text' },
    { caption: 'committed_yes', type: 'boolean' },
  ];

  const out = { ok: true, cohort, tags: {}, fields: {} };
  for (const name of tags) out.tags[name] = await createOne('/fb/page/createTag', { name }, env);
  for (const f of fields) {
    out.fields[f.caption] = await createOne('/fb/page/createCustomField',
      { caption: f.caption, type: f.type, description: 'webinar funnel' }, env);
  }
  return json(out, 200);
}

// Create a tag/field; treat an "already exists" response as success (idempotent).
async function createOne(path, body, env) {
  try { await manychat(path, body, env); return 'created'; }
  catch (err) { return /exist/i.test(err.message) ? 'exists' : `error:${err.message}`; }
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
