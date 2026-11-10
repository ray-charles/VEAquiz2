/* node workers/cercle-seats.test.mjs
 *
 * Exercises /counts against a fake Stripe. The cases here are the ones that
 * would put a wrong number on the landing page: instalments counted twice,
 * refunds counted at all, and a cohort overflowing its own cap.
 */
import assert from 'node:assert';
import worker, { MANUAL } from './cercle-seats.js';

/* Seats sold off-Stripe are a live business number that moves whenever
   someone e-transfers. Every case below asserts an exact count, so start
   from zero and let the one test that cares set it. */
const clearManual = () => Object.keys(MANUAL).forEach((k) => { MANUAL[k] = 0; });
clearManual();

/* The two Thursday cohorts (spring 2027) sit at zero in every case written
   before they existed. */
const NOJEUDI = { jeudi: 0, 'jeudi-1730': 0 };

const charge = (o) => ({
  id: 'ch_' + Math.random().toString(36).slice(2),
  status: 'succeeded',
  refunded: false,
  metadata: {},
  billing_details: {},
  ...o,
});

let lastQuery = null;
function fakeStripe(charges) {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith('https://api.stripe.com/v1/charges?'), url);
    lastQuery = new URL(url).searchParams;
    return new Response(JSON.stringify({ data: charges, has_more: false }), {
      headers: { 'content-type': 'application/json' },
    });
  };
}

/* No Cache API outside the edge runtime; a miss on every call is what we
 * want under test anyway. */
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const call = async (q = '') => {
  const res = await worker.fetch(
    new Request('https://x.dev/counts' + q),
    { STRIPE_KEY: 'rk_test' },
    { waitUntil: () => {} },
  );
  return { status: res.status, body: await res.json() };
};

/* --- one seat per person, however many charges they generate --- */
fakeStripe([
  charge({ description: 'Cercle de Voix — Mardi', customer: 'cus_A' }),
  charge({ description: 'Cercle de Voix — Mardi', customer: 'cus_A' }), // instalment 2
  charge({ description: 'Cercle de Voix — Mardi', customer: 'cus_A' }), // instalment 3
  charge({ description: 'Cercle de Voix — Mardi', customer: 'cus_B' }),
  charge({ description: 'Cercle de Voix — Mercredi', customer: 'cus_C' }),
]);
let r = await call();
assert.deepStrictEqual(r.body, { ...NOJEUDI, mardi:2, mercredi: 1, 'mardi-1730': 0, 'mercredi-1730': 0, 'mardi-0900': 0, 'mardi-1045': 0 }, 'instalments must not each buy a seat');

/* --- refunded and failed charges hold no seat --- */
fakeStripe([
  charge({ description: 'Mardi', customer: 'cus_A' }),
  charge({ description: 'Mardi', customer: 'cus_B', refunded: true }),
  charge({ description: 'Mardi', customer: 'cus_C', status: 'failed' }),
]);
r = await call();
assert.deepStrictEqual(r.body, { ...NOJEUDI, mardi:1, mercredi: 0, 'mardi-1730': 0, 'mercredi-1730': 0, 'mardi-0900': 0, 'mardi-1045': 0 }, 'refunds and failures free the seat');

/* --- the cohort word can arrive in metadata instead of the description --- */
fakeStripe([charge({ description: 'Voz Esencia', metadata: { paywall: 'cercle-mercredi' }, customer: 'cus_D' })]);
r = await call();
assert.deepStrictEqual(r.body, { ...NOJEUDI, mardi:0, mercredi: 1, 'mardi-1730': 0, 'mercredi-1730': 0, 'mardi-0900': 0, 'mardi-1045': 0 }, 'metadata is searched too');

/* --- never advertise more seats sold than exist --- */
fakeStripe(Array.from({ length: 30 }, (_, i) => charge({ description: 'Mardi', customer: 'cus_' + i })));
r = await call();
assert.strictEqual(r.body.mardi, 12, 'count is clamped to the cohort cap');

/* --- unmatched charges are ignored, not guessed at --- */
fakeStripe([charge({ description: 'Cours privé', customer: 'cus_Z' })]);
r = await call();
assert.deepStrictEqual(r.body, { ...NOJEUDI, mardi:0, mercredi: 0, 'mardi-1730': 0, 'mercredi-1730': 0, 'mardi-0900': 0, 'mardi-1045': 0 }, 'other products do not fill the cercle');

/* --- explain=1 exposes what it matched, so the mapping can be checked --- */
fakeStripe([charge({ description: 'Cercle de Voix — Mardi', customer: 'cus_A' })]);
r = await call('?explain=1');
assert.deepStrictEqual(r.body.matched['mardi'], ['Cercle de Voix — Mardi']);

/* --- a Stripe outage must not report zero seats --- */
globalThis.fetch = async () => new Response('down', { status: 500 });
r = await call();
assert.strictEqual(r.status, 502, 'a failed lookup errors instead of returning 0');

/* --- and must not quote the key back over a public endpoint --- */
globalThis.fetch = async () =>
  new Response('{"error":{"message":"Invalid API Key provided: rk_live_abc123"}}', { status: 401 });
r = await call();
assert.strictEqual(r.status, 502);
assert.ok(!JSON.stringify(r.body).includes('rk_live'), 'Stripe body must not reach the caller');

/* --- explain reports charges vs seats, so instalment dedupe is checkable --- */
fakeStripe([
  charge({ description: 'Mardi', customer: 'cus_A' }),
  charge({ description: 'Mardi', customer: 'cus_A' }),
  charge({ description: 'Mardi', customer: 'cus_A' }),
]);
r = await call('?explain=1');
assert.strictEqual(r.body.mardi, 1);
assert.strictEqual(r.body.charges.mardi, 3, 'three charges behind one seat');
assert.strictEqual(r.body.unidentified.mardi, 0);

/* --- a charge with no customer and no email cannot be deduped: say so --- */
fakeStripe([
  charge({ description: 'Mardi' }),
  charge({ description: 'Mardi' }),
]);
r = await call('?explain=1');
assert.strictEqual(r.body.mardi, 2, 'nothing to join on, so they count separately');
assert.strictEqual(r.body.unidentified.mardi, 2, 'and that is reported, not hidden');

/* --- the guarantee is a PARTIAL refund and must free the seat --- */
fakeStripe([
  charge({ description: 'Mardi', customer: 'cus_A', amount: 13200, amount_refunded: 0 }),
  charge({ description: 'Mardi', customer: 'cus_B', amount: 39600, amount_refunded: 35100 }), // kept 45 $
]);
r = await call();
assert.deepStrictEqual(r.body, { ...NOJEUDI, mardi:1, mercredi: 0, 'mardi-1730': 0, 'mercredi-1730': 0, 'mardi-0900': 0, 'mardi-1045': 0 }, 'a part refund releases the seat');

/* --- and it frees the seat even when their other instalments were clean --- */
fakeStripe([
  charge({ description: 'Mardi', customer: 'cus_C', amount_refunded: 0 }),
  charge({ description: 'Mardi', customer: 'cus_C', amount_refunded: 0 }),
  charge({ description: 'Mardi', customer: 'cus_C', amount_refunded: 8700 }),
]);
r = await call();
assert.strictEqual(r.body.mardi, 0, 'one refunded instalment means they left');

/* --- the lookback must reach the season's first sale, and no further ------
 * In 2026 the first sale (16 May) sat before the window, and the page sold the
 * same Tuesday seat twice. Spring 2027 reuses the autumn mercredi paywalls, so
 * the window must also stop short of the autumn sales (last one 15 Sep 2026)
 * or those buyers fill the spring Wednesdays. Spring went on sale 10 Nov 2026
 * around 01:40 UTC; a 152 $ autumn instalment was retried 9 Nov 06:40 UTC. */
fakeStripe([]);
await call();
const since = Number(lastQuery.get('created[gte]'));
const asked = new Date(since * 1000).toISOString();
assert.ok(since <= Date.parse('2026-11-10T01:40:00Z') / 1000,
  'lookback must include the first spring sale, asked from ' + asked);
assert.ok(since > Date.parse('2026-11-09T06:40:00Z') / 1000,
  'lookback must leave out the autumn 2026 instalments, asked from ' + asked);

/* --- spring 2027: the four paywalls exactly as named in Circle --- */
fakeStripe([
  charge({ description: 'Cercle de Voix mercredi 17h30', customer: 'cus_w1' }),
  charge({ description: 'Cercle de Voix mercredi 19h15', customer: 'cus_w2' }),
  charge({ description: 'Cercle de Voix jeudi 17h30',    customer: 'cus_t1' }),
  charge({ description: 'Cercle de Voix jeudi 19h15',    customer: 'cus_t2' }),
  charge({ description: 'Cercle de Voix jeudi 19h15',    customer: 'cus_t3' }),
]);
r = await call();
assert.deepStrictEqual(r.body,
  { mardi: 0, mercredi: 1, 'mardi-1730': 0, 'mercredi-1730': 1, 'mardi-0900': 0, 'mardi-1045': 0,
    jeudi: 2, 'jeudi-1730': 1 },
  'each spring paywall fills its own cohort and nothing else');

/* --- a real, in-window charge that no cohort claims must be reported ----
 * Silently discarding it is what let the May buyer vanish; explain has to
 * show the leftovers so the next mismatch is one request away from an answer. */
fakeStripe([
  charge({ description: 'Cercle de Voix, saison été-automne, mardi.', customer: 'cus_A' }),
  charge({ description: 'Atelier ponctuel du jeudi', customer: 'cus_Y' }),
]);
r = await call('?explain=1');
assert.strictEqual(r.body.mardi, 1);
assert.deepStrictEqual(r.body.ignored, ['Atelier ponctuel du jeudi'], 'discards are surfaced');

/* --- the two Tuesday paywalls must not feed each other --- */
fakeStripe([
  charge({ description: 'Cercle de Voix, saison été-automne, mardi.', customer: 'cus_1' }),
  charge({ description: 'Cercle de Voix, saison été-automne, mardi 17 h 30', customer: 'cus_2' }),
  charge({ description: 'Cercle de Voix mercredi 17h30', customer: 'cus_3' }),
  charge({ description: 'Cercle de Voix, saison été-automne, mercredi', customer: 'cus_4' }),
]);
r = await call('?explain=1');
assert.strictEqual(r.body.mardi, 1, 'the evening cohort must not absorb the 17 h 30 sale');
assert.strictEqual(r.body['mardi-1730'], 1);
assert.strictEqual(r.body.mercredi, 1);
assert.strictEqual(r.body['mercredi-1730'], 1);
assert.deepStrictEqual(r.body.matched['mardi'], ['Cercle de Voix, saison été-automne, mardi.'],
  'explain shows which description landed in which cohort');

/* --- the real Circle slugs, both spellings, exactly as Charles created them.
       The afternoon paywalls are named after their URL, and the two were not
       created to the same convention: 1730 on the Tuesday, 17h30 on the
       Wednesday. Either must land in the afternoon cohort. --- */
fakeStripe([
  charge({ description: 'cercle-de-voix-mardi-1730',     customer: 'cus_a' }),
  charge({ description: 'cercle-de-voix-mercredi-17h30', customer: 'cus_b' }),
]);
r = await call();
assert.deepStrictEqual(r.body,
  { ...NOJEUDI, mardi:0, mercredi: 0, 'mardi-1730': 1, 'mercredi-1730': 1, 'mardi-0900': 0, 'mardi-1045': 0 },
  'both slug spellings route to the afternoon cohorts, and nothing leaks into the evening');

/* --- the evening paywalls were renamed on 2026-08-03 to match the afternoon
       pair (…-mardi-19h15 rather than …-saison-ete-automne-mardi). New charges
       carry the new wording, every charge already taken carries the old one,
       and both must land in the same cohort or the seats sold so far vanish. --- */
fakeStripe([
  charge({ description: 'cercle-de-voix-mardi-19h15',                customer: 'cus_new_ma' }),
  charge({ description: 'cercle-de-voix-mercredi-19h15',             customer: 'cus_new_me' }),
  charge({ description: 'Cercle de Voix, saison été-automne, mardi.', customer: 'cus_old_ma' }),
  charge({ description: 'Cercle de Voix, saison été-automne, mercredi', customer: 'cus_old_me' }),
]);
r = await call();
assert.deepStrictEqual(r.body,
  { ...NOJEUDI, mardi:2, mercredi: 2, 'mardi-1730': 0, 'mercredi-1730': 0, 'mardi-0900': 0, 'mardi-1045': 0 },
  'old and new paywall names count into the same evening cohorts');

/* --- the autumn morning cohorts. Four paywalls now say "mardi", and the
       evening one is the only Tuesday defined as "no time on it at all", so a
       morning sale that fails to match its own rule silently lands there and
       stamps a sold-out evening cohort full on seats it never sold. --- */
fakeStripe([
  charge({ description: 'cercle-de-voix-mardi-9h00',  customer: 'cus_m9' }),
  charge({ description: 'cercle-de-voix-mardi-10h45', customer: 'cus_m10' }),
]);
r = await call();
assert.deepStrictEqual(r.body,
  { ...NOJEUDI, mardi:0, mercredi: 0, 'mardi-1730': 0, 'mercredi-1730': 0,
    'mardi-0900': 1, 'mardi-1045': 1 },
  'the morning paywalls route to their own cohorts and leak nowhere');

/* --- the hour guard. "19h15" contains a 9 and "29.09" contains an 09; either
       one read as a 9 h charge would move an evening seat, or a date in a
       description would invent one. --- */
fakeStripe([
  charge({ description: 'cercle-de-voix-mardi-19h15',                 customer: 'cus_ev' }),
  charge({ description: 'Cercle de Voix mardi, début 29.09.2026',      customer: 'cus_dt' }),
]);
r = await call();
assert.strictEqual(r.body['mardi-0900'], 0, 'neither 19h15 nor a date reads as 9 h');
assert.strictEqual(r.body.mardi, 2, 'both stay on the evening cohort');

/* --- the spellings Circle might use for the same two cohorts --- */
for (const [desc, slot] of Object.entries({
  'cercle-de-voix-mardi-9h':     'mardi-0900',
  'Cercle de Voix — mardi 9 h 00': 'mardi-0900',
  'Cercle de Voix — mardi 9:00':   'mardi-0900',
  'Cercle de Voix — mardi 10 h 45': 'mardi-1045',
  'Cercle de Voix — mardi 10:45':   'mardi-1045',
  /* the two live paywall slugs, as Charles created them */
  'cercle-de-voix-mardi-10h45':    'mardi-1045',
  'cercle-de-voix-mardi-9h':       'mardi-0900',
})) {
  fakeStripe([charge({ description: desc, customer: 'cus_x' })]);
  r = await call();
  assert.strictEqual(r.body[slot], 1, `"${desc}" must land in ${slot}`);
  assert.strictEqual(r.body.mardi, 0, `"${desc}" must not land on the evening bar`);
}

/* --- a seat paid by e-transfer is invisible to Stripe, so MANUAL adds it --- */
MANUAL.mardi = 1;
fakeStripe([
  charge({ description: 'cercle-de-voix-mardi-19h15', customer: 'cus_stripe' }),
]);
r = await call('?explain=1');
assert.strictEqual(r.body.mardi, 2, 'one Stripe sale plus the manual e-transfer seat');
assert.strictEqual(r.body.charges.mardi, 1, 'the manual seat is not a charge');
assert.strictEqual(r.body.manual.mardi, 1, 'and explain says where the extra seat came from');

/* --- and it can never push a cohort past the cap --- */
fakeStripe(Array.from({ length: 12 }, (_, i) =>
  charge({ description: 'cercle-de-voix-mardi-19h15', customer: 'cus_' + i })));
r = await call();
assert.strictEqual(r.body.mardi, 12, 'manual seats are still capped at 12');

/* --- moving someone between cohorts: minus one side, plus the other, and a
       negative adjustment must never take a cohort below zero and advertise
       more seats than exist --- */
clearManual();
MANUAL['mercredi'] = 1;
MANUAL['mercredi-1730'] = -1;
fakeStripe([
  charge({ description: 'Cercle de Voix mercredi 17h30', customer: 'cus_moved' }),
]);
r = await call();
assert.strictEqual(r.body.mercredi, 1, 'the seat lands in the cohort they attend');
assert.strictEqual(r.body['mercredi-1730'], 0, 'and leaves the one Stripe recorded');

fakeStripe([]);
r = await call();
assert.strictEqual(r.body['mercredi-1730'], 0, 'a negative adjustment floors at zero');
clearManual();

/* ================================================================
   WAITLIST -> KIT
   ================================================================ */
let kitCalls = [];
function fakeKit({ fail = false } = {}) {
  kitCalls = [];
  globalThis.fetch = async (url, opts) => {
    kitCalls.push({ url: String(url), body: JSON.parse(opts.body) });
    if (fail) return new Response('kit is down', { status: 500 });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const postWaitlist = async (lead, env = { KIT_API_KEY: 'kit_test' }) => {
  const res = await worker.fetch(
    new Request('https://x.dev/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lead),
    }),
    env,
    { waitUntil: () => {} },
  );
  return { status: res.status, body: await res.json() };
};

const LEAD = {
  prenom: 'Camille', nom: 'Roy', telephone: '5145551234',
  email: 'camille@example.com',
  creneau: 'Mardi 19 h 15 à 20 h 45', cohorte: 'mardi',
};

/* --- the happy path: subscriber, sequence, then every tag --- */
fakeKit();
let w = await postWaitlist(LEAD);
assert.strictEqual(w.status, 200);
assert.ok(w.body.ok);
assert.deepStrictEqual(kitCalls.map(c => c.url.replace('https://api.kit.com/v4', '')), [
  '/subscribers',
  '/sequences/2846692/subscribers',
  '/tags/21782116/subscribers',   // cercle-liste-attente
  '/tags/20683832/subscribers',   // idioma-fr
  '/tags/22821184/subscribers',   // cercle-attente-mardi-1915
], 'subscribe, enrol, then tag — in that order');
assert.strictEqual(kitCalls[0].body.first_name, 'Camille');
assert.strictEqual(kitCalls[0].body.fields.telefono, '5145551234');
assert.strictEqual(kitCalls[0].body.fields.creneau, 'Mardi 19 h 15 à 20 h 45');

/* --- each cohort gets its own tag, so spring can invite the right people --- */
for (const [cohorte, tag] of Object.entries({
  'mercredi': 22821185, 'mardi-1730': 21754675, 'mercredi-1730': 21754676,
  'mardi-0900': 23250804, 'mardi-1045': 23250805,
})) {
  fakeKit();
  await postWaitlist({ ...LEAD, cohorte });
  assert.ok(kitCalls.some(c => c.url.endsWith(`/tags/${tag}/subscribers`)),
    `${cohorte} must tag ${tag}`);
}

/* --- an unknown cohort still lands on the list, just without a night --- */
fakeKit();
await postWaitlist({ ...LEAD, cohorte: 'jeudi-midi' });
assert.strictEqual(kitCalls.filter(c => c.url.includes('/tags/')).length, 2,
  'only the two always-tags when the cohort is unrecognised');

/* --- Kit being down must never fail the visitor: Formspree already has them --- */
fakeKit({ fail: true });
w = await postWaitlist(LEAD);
assert.ok(w.status < 400, 'a Kit outage must not surface as an error, got ' + w.status);

/* --- rubbish never reaches Kit --- */
fakeKit();
w = await postWaitlist({ ...LEAD, email: 'not-an-address' });
assert.strictEqual(w.status, 400);
assert.strictEqual(kitCalls.length, 0, 'a bad address must not spend a Kit call');

/* --- and without the secret it says so rather than failing silently --- */
w = await postWaitlist(LEAD, {});
assert.strictEqual(w.status, 500);

/* --- a stale cached answer is refreshed in the foreground, so the first
       visitor after a sale sees it (they used to get the old number) --- */
{
  clearManual();
  const oldBody = { counts: { 'mardi-0900': 0 }, labels: {}, charges: {}, anon: {}, manual: {}, ignored: [] };
  const saved = globalThis.caches;
  let stored = null;
  globalThis.caches = { default: {
    match: async () => new Response(JSON.stringify(oldBody), {
      headers: { 'x-fetched-at': String(Date.now() - 60 * 1000) } }),
    put: async (_k, res) => { stored = await res.json(); },
  } };
  fakeStripe([charge({ description: 'Cercle de Voix mardi 9h', customer: 'cus_new' })]);
  const waits = [];
  const res = await worker.fetch(new Request('https://x.dev/counts'), { STRIPE_KEY: 'rk_test' },
    { waitUntil: (p) => waits.push(p) });
  const got = await res.json();
  await Promise.all(waits);
  assert.strictEqual(got['mardi-0900'], 1, 'a stale entry must not hide a new sale from the next visitor');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store', 'browsers must not keep an old count');
  assert.strictEqual(stored.counts['mardi-0900'], 1, 'and the fresh count is written back');

  /* Stripe too slow: the visitor gets the cached answer instead of waiting */
  globalThis.fetch = () => new Promise((r) => setTimeout(() => r(new Response(
    JSON.stringify({ data: [], has_more: false }))), 4000));
  const t0 = Date.now();
  const slow = await worker.fetch(new Request('https://x.dev/counts'), { STRIPE_KEY: 'rk_test' },
    { waitUntil: () => {} });
  assert.ok(Date.now() - t0 < 2500, 'a slow Stripe never holds a visitor past the wait cap');
  assert.strictEqual((await slow.json())['mardi-0900'], 0, 'and they get the cached answer');
  globalThis.caches = saved;
}

console.log('cercle-seats: all checks passed');
