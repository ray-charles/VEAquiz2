/* Cercle de Voix — seat counter, read straight from Stripe.
 *
 *   GET /counts            -> {"mardi":5,"mercredi":3}
 *   GET /counts?explain=1  -> the same, plus the charge descriptions it
 *                             matched, so the mapping can be eyeballed
 *
 * The landing page polls /counts and raises its yellow bars to match.
 *
 * Why Stripe and not a ping from Circle: a ping is an event, and events get
 * missed — a retry that never lands, a refund nobody tells us about, a
 * checkout completed while the worker was down, and the bar is wrong forever
 * with no way to notice. Stripe already holds the answer, so this recounts it
 * from scratch on every cache miss. Nothing to seed, nothing to drift, and a
 * refund removes a seat on its own.
 *
 * Deliberately no KV: there is no state worth keeping when the truth is one
 * HTTP call away.
 *
 * Needs one secret — STRIPE_KEY, a RESTRICTED key with read access to
 * Charges and nothing else. Never a live secret key: this endpoint is public.
 */

const CAP = 12;

/* Circle names each paywall charge after the paywall itself, so "mardi" or
 * "mercredi" shows up in the charge description. Matching on the word rather
 * than on a product id means a rebuilt paywall doesn't silently zero the page.
 * If Circle ever changes its wording, /counts?explain=1 shows what it sends. */
const SLOTS = {
  mardi: /mardi/i,
  mercredi: /mercredi/i,
};

/* Charges before the season opened belong to other products. */
const SINCE = Date.parse('2026-06-01T00:00:00Z') / 1000;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors, ...extra },
  });

async function stripe(path, key) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { authorization: 'Bearer ' + key },
  });
  if (!r.ok) {
    /* Stripe quotes the offending key back in its 401 body. /counts is public,
     * so the detail goes to the log where `wrangler tail` can read it and the
     * caller gets the status and nothing else. */
    console.error('stripe ' + r.status + ' ' + (await r.text()).slice(0, 300));
    throw new Error('stripe ' + r.status);
  }
  return r.json();
}

async function countSeats(key) {
  const counts = {};
  const seen = {};
  for (const slot of Object.keys(SLOTS)) {
    counts[slot] = 0;
    seen[slot] = new Set();
  }

  /* 100 per page, 5 pages max. A cohort caps at 12 and the season sells a few
   * dozen seats, so this never gets near the ceiling — the ceiling only stops
   * a runaway loop if the account is busier than expected. */
  let starting_after = null;
  const labels = new Set();
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ limit: '100', 'created[gte]': String(SINCE) });
    if (starting_after) qs.set('starting_after', starting_after);
    const res = await stripe('charges?' + qs, key);

    for (const c of res.data) {
      if (c.status !== 'succeeded' || c.refunded) continue;
      /* Descriptions carry the paywall name; metadata carries whatever Circle
       * chose to attach. Search both — Circle has moved this before. */
      const hay = [c.description, ...Object.values(c.metadata || {})].join(' ');
      for (const [slot, re] of Object.entries(SLOTS)) {
        if (!re.test(hay)) continue;
        /* One person, one seat, even if Circle splits the fee into
         * instalments and files each one as its own charge. */
        const who = c.customer || c.billing_details?.email || c.id;
        if (seen[slot].has(who)) continue;
        seen[slot].add(who);
        counts[slot]++;
        if (c.description) labels.add(c.description);
      }
    }

    if (!res.has_more || !res.data.length) break;
    starting_after = res.data[res.data.length - 1].id;
  }

  for (const slot of Object.keys(counts)) counts[slot] = Math.min(CAP, counts[slot]);
  return { counts, labels: [...labels] };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (path !== '/counts' || request.method !== 'GET') {
      return json({ error: 'not found' }, 404);
    }
    if (!env.STRIPE_KEY) return json({ error: 'not configured' }, 500);

    /* One Stripe call a minute at most, however hard the page is hit. The
     * page is read thousands of times for every seat that sells, so a minute
     * of staleness costs nothing and a cache miss storm would cost a lot. */
    const cache = caches.default;
    const ck = new Request(new URL('/counts', url).toString(), { method: 'GET' });
    const hit = await cache.match(ck);
    let body;
    if (hit) {
      body = await hit.json();
    } else {
      try {
        body = await countSeats(env.STRIPE_KEY);
      } catch (e) {
        /* Never serve a wrong number. The page keeps its own fallback when
         * the fetch fails, which is the honest outcome. */
        return json({ error: String(e.message || e) }, 502, { 'cache-control': 'no-store' });
      }
      ctx.waitUntil(
        cache.put(ck, json(body, 200, { 'cache-control': 'public, max-age=60' }).clone()),
      );
    }

    const out = url.searchParams.get('explain')
      ? { ...body.counts, matched: body.labels }
      : body.counts;
    return json(out, 200, { 'cache-control': 'public, max-age=60' });
  },
};
