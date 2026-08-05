/* node workers/cercle-seats.test.mjs
 *
 * Exercises /counts against a fake Stripe. The cases here are the ones that
 * would put a wrong number on the landing page: instalments counted twice,
 * refunds counted at all, and a cohort overflowing its own cap.
 */
import assert from 'node:assert';
import worker from './cercle-seats.js';

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
assert.deepStrictEqual(r.body, { mardi: 2, mercredi: 1, 'mardi-1730': 0, 'mercredi-1730': 0 }, 'instalments must not each buy a seat');

/* --- refunded and failed charges hold no seat --- */
fakeStripe([
  charge({ description: 'Mardi', customer: 'cus_A' }),
  charge({ description: 'Mardi', customer: 'cus_B', refunded: true }),
  charge({ description: 'Mardi', customer: 'cus_C', status: 'failed' }),
]);
r = await call();
assert.deepStrictEqual(r.body, { mardi: 1, mercredi: 0, 'mardi-1730': 0, 'mercredi-1730': 0 }, 'refunds and failures free the seat');

/* --- the cohort word can arrive in metadata instead of the description --- */
fakeStripe([charge({ description: 'Voz Esencia', metadata: { paywall: 'cercle-mercredi' }, customer: 'cus_D' })]);
r = await call();
assert.deepStrictEqual(r.body, { mardi: 0, mercredi: 1, 'mardi-1730': 0, 'mercredi-1730': 0 }, 'metadata is searched too');

/* --- never advertise more seats sold than exist --- */
fakeStripe(Array.from({ length: 30 }, (_, i) => charge({ description: 'Mardi', customer: 'cus_' + i })));
r = await call();
assert.strictEqual(r.body.mardi, 12, 'count is clamped to the cohort cap');

/* --- unmatched charges are ignored, not guessed at --- */
fakeStripe([charge({ description: 'Cours privé', customer: 'cus_Z' })]);
r = await call();
assert.deepStrictEqual(r.body, { mardi: 0, mercredi: 0, 'mardi-1730': 0, 'mercredi-1730': 0 }, 'other products do not fill the cercle');

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
assert.deepStrictEqual(r.body, { mardi: 1, mercredi: 0, 'mardi-1730': 0, 'mercredi-1730': 0 }, 'a part refund releases the seat');

/* --- and it frees the seat even when their other instalments were clean --- */
fakeStripe([
  charge({ description: 'Mardi', customer: 'cus_C', amount_refunded: 0 }),
  charge({ description: 'Mardi', customer: 'cus_C', amount_refunded: 0 }),
  charge({ description: 'Mardi', customer: 'cus_C', amount_refunded: 8700 }),
]);
r = await call();
assert.strictEqual(r.body.mardi, 0, 'one refunded instalment means they left');

/* --- the lookback must reach the season's first sale --------------------
 * The real one was 16 May 2026 and the window started 1 June, so Stripe was
 * never asked for that charge: five people had paid, four were counted, and
 * the page sold the same Tuesday seat twice over. The window is the only
 * thing standing between a real buyer and a seat advertised as free, so it
 * gets asserted rather than trusted. */
fakeStripe([]);
await call();
const FIRST_SALE = Date.parse('2026-05-16T00:00:00Z') / 1000;
assert.ok(
  Number(lastQuery.get('created[gte]')) <= FIRST_SALE,
  'lookback window must include the 16 May 2026 sale, asked from ' +
    new Date(Number(lastQuery.get('created[gte]')) * 1000).toISOString(),
);

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
  { mardi: 0, mercredi: 0, 'mardi-1730': 1, 'mercredi-1730': 1 },
  'both slug spellings route to the afternoon cohorts, and nothing leaks into the evening');

console.log('cercle-seats: all checks passed');
