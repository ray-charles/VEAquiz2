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

/* Charges before the season opened belong to other products.
 *
 * This was 2026-06-01 and it was wrong: the first seat sold on 16 May 2026, so
 * that buyer sat outside the window and the page advertised their seat as free
 * for months. The cutoff is only here to keep older "mardi"/"mercredi" charges
 * from the regular classes out of the count, so it needs to sit just before the
 * season's first sale, not after it. If an earlier sale ever turns up, move
 * this back and check /counts?explain=1 for anything it drags in. */
const SINCE = Date.parse('2026-05-01T00:00:00Z') / 1000;

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
  const paid = {};      // people with at least one good charge
  const left = {};      // ...of whom these have been refunded anything
  const charges = {};   // how many charges backed those seats
  const anon = {};      // ...and how many carried no way to tell people apart
  for (const slot of Object.keys(SLOTS)) {
    paid[slot] = new Set();
    left[slot] = new Set();
    charges[slot] = 0;
    anon[slot] = 0;
  }

  /* 100 per page, 5 pages max. A cohort caps at 12 and the season sells a few
   * dozen seats, so this never gets near the ceiling — the ceiling only stops
   * a runaway loop if the account is busier than expected. */
  let starting_after = null;
  const labels = new Set();
  /* Everything succeeded, in-window and NOT claimed by a cohort. A seat that
   * goes missing looks identical to a seat that was never sold, so the only way
   * to tell them apart is to see what got thrown away. The 16 May buyer was
   * invisible for months precisely because nothing reported the discards. */
  const ignored = new Set();
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ limit: '100', 'created[gte]': String(SINCE) });
    if (starting_after) qs.set('starting_after', starting_after);
    const res = await stripe('charges?' + qs, key);

    for (const c of res.data) {
      if (c.status !== 'succeeded') continue;
      /* Descriptions carry the paywall name; metadata carries whatever Circle
       * chose to attach. Search both — Circle has moved this before. */
      const hay = [c.description, ...Object.values(c.metadata || {})].join(' ');
      let claimed = false;
      for (const [slot, re] of Object.entries(SLOTS)) {
        if (!re.test(hay)) continue;
        claimed = true;
        charges[slot]++;
        /* One person, one seat, even if Circle splits the fee into
         * instalments and files each one as its own charge. Falling back to
         * the charge id means no dedupe at all, so count how often that
         * happens — three instalments with nothing to join them on would
         * quietly sell the same seat three times. */
        const who = c.customer || c.billing_details?.email;
        if (!who) anon[slot]++;
        const id = who || c.id;
        paid[slot].add(id);
        if (c.description) labels.add(c.description);

        /* `refunded` is only true when the whole charge went back, but the
         * guarantee is a PART refund — first session kept, balance returned.
         * Someone who took it has left the cohort and their seat is free, so
         * any refunded amount releases it. Erring this way frees a seat that
         * might still be held; the other way advertises a seat that is gone,
         * which is the direction that lies to the buyer. */
        if (c.refunded || c.amount_refunded > 0) left[slot].add(id);
      }
      if (!claimed && c.description) ignored.add(c.description);
    }

    if (!res.has_more || !res.data.length) break;
    starting_after = res.data[res.data.length - 1].id;
  }

  const counts = {};
  for (const slot of Object.keys(SLOTS)) {
    counts[slot] = [...paid[slot]].filter((id) => !left[slot].has(id)).length;
  }

  for (const slot of Object.keys(counts)) counts[slot] = Math.min(CAP, counts[slot]);
  return { counts, labels: [...labels], charges, anon, ignored: [...ignored] };
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
      ? {
          ...body.counts,
          matched: body.labels,
          charges: body.charges,
          unidentified: body.anon,
          ignored: body.ignored,
        }
      : body.counts;
    return json(out, 200, { 'cache-control': 'public, max-age=60' });
  },
};
