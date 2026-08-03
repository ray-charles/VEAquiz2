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

function fakeStripe(charges) {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith('https://api.stripe.com/v1/charges?'), url);
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
assert.deepStrictEqual(r.body, { mardi: 2, mercredi: 1 }, 'instalments must not each buy a seat');

/* --- refunded and failed charges hold no seat --- */
fakeStripe([
  charge({ description: 'Mardi', customer: 'cus_A' }),
  charge({ description: 'Mardi', customer: 'cus_B', refunded: true }),
  charge({ description: 'Mardi', customer: 'cus_C', status: 'failed' }),
]);
r = await call();
assert.deepStrictEqual(r.body, { mardi: 1, mercredi: 0 }, 'refunds and failures free the seat');

/* --- the cohort word can arrive in metadata instead of the description --- */
fakeStripe([charge({ description: 'Voz Esencia', metadata: { paywall: 'cercle-mercredi' }, customer: 'cus_D' })]);
r = await call();
assert.deepStrictEqual(r.body, { mardi: 0, mercredi: 1 }, 'metadata is searched too');

/* --- never advertise more seats sold than exist --- */
fakeStripe(Array.from({ length: 30 }, (_, i) => charge({ description: 'Mardi', customer: 'cus_' + i })));
r = await call();
assert.strictEqual(r.body.mardi, 12, 'count is clamped to the cohort cap');

/* --- unmatched charges are ignored, not guessed at --- */
fakeStripe([charge({ description: 'Cours privé', customer: 'cus_Z' })]);
r = await call();
assert.deepStrictEqual(r.body, { mardi: 0, mercredi: 0 }, 'other products do not fill the cercle');

/* --- explain=1 exposes what it matched, so the mapping can be checked --- */
fakeStripe([charge({ description: 'Cercle de Voix — Mardi', customer: 'cus_A' })]);
r = await call('?explain=1');
assert.deepStrictEqual(r.body.matched, ['Cercle de Voix — Mardi']);

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

console.log('cercle-seats: all checks passed');
