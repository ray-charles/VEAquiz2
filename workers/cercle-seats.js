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

/* Seats paid for outside Stripe — Interac e-transfer, cash at the door.
 * Stripe cannot see them, so without this the page would advertise a seat
 * that is already sold. Bump the number when one comes in; drop it back if
 * that person is refunded, because nothing else will.
 *
 * Also used to move someone between cohorts after they have paid: subtract
 * from the one Stripe recorded, add to the one they are actually attending.
 *
 *   mardi         +1  Interac e-transfer, 5 Aug 2026
 *   mercredi      +1  paid on the 17 h 30 paywall, attending 19 h 15
 *   mercredi-1730 -1  the other half of that move
 */
export const MANUAL = { 'mardi': 1, 'mercredi': 1, 'mardi-1730': 0, 'mercredi-1730': -1 };

/* Circle names each paywall charge after the paywall itself, so "mardi" or
 * "mercredi" shows up in the charge description. Matching on the word rather
 * than on a product id means a rebuilt paywall doesn't silently zero the page.
 * If Circle ever changes its wording, /counts?explain=1 shows what it sends. */
const DAY = { mardi: /mardi/i, mercredi: /mercredi/i };

/* Both Tuesday paywalls say "mardi", so the day alone puts afternoon sales
 * into the evening cohort and can stamp it full on seats it never sold.
 * The afternoon ones are told apart by their start time, spelled however
 * Circle happens to spell it. The evening pair carry no time at all today
 * ("...saison été-automne, mardi."), so they are defined as the day
 * WITHOUT an afternoon marker rather than by a time of their own. */
const AFTERNOON = /17\s*[h:.]?\s*30|(?:^|\D)5\s*[h:.]\s*30/i;

const SLOTS = {
  'mardi':         (h) => DAY.mardi.test(h)    && !AFTERNOON.test(h),
  'mercredi':      (h) => DAY.mercredi.test(h) && !AFTERNOON.test(h),
  'mardi-1730':    (h) => DAY.mardi.test(h)    &&  AFTERNOON.test(h),
  'mercredi-1730': (h) => DAY.mercredi.test(h) &&  AFTERNOON.test(h),
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
  const labels = {};   // slot -> the descriptions that landed in it
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
      for (const [slot, matches] of Object.entries(SLOTS)) {
        if (!matches(hay)) continue;
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
        if (c.description) (labels[slot] = labels[slot] || new Set()).add(c.description);

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

  for (const slot of Object.keys(counts)) {
    counts[slot] = Math.max(0, Math.min(CAP, counts[slot] + (MANUAL[slot] || 0)));
  }
  const matched = {};
  for (const k of Object.keys(labels)) matched[k] = [...labels[k]];
  return { counts, labels: matched, charges, anon, manual: MANUAL, ignored: [...ignored] };
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

    /* Serve the cached answer and refresh behind the visitor.
     *
     * Before this, a request landing after the cache expired waited on
     * Stripe — 280 ms on a good day, 2.2 s when there were enough charges to
     * page through. The picker paints "12 places restantes" until that
     * returns, so a full cohort read as open for two seconds.
     *
     * Now the only person who ever waits is the first one after a deploy or
     * an eviction. Everyone else gets the last answer immediately, and a
     * background refresh keeps it current. The cost is that a number can be
     * up to FRESH_MS old — the page is read thousands of times per seat
     * sold, so a minute of staleness is nothing next to a two-second lie. */
    const FRESH_MS = 60 * 1000;
    const cache = caches.default;
    const ck = new Request(new URL('/counts', url).toString(), { method: 'GET' });

    const store = (b) =>
      cache.put(
        ck,
        new Response(JSON.stringify(b), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=600',
            'x-fetched-at': String(Date.now()),
          },
        }),
      );

    const hit = await cache.match(ck);
    let body;
    if (hit) {
      body = await hit.json();
      const age = Date.now() - Number(hit.headers.get('x-fetched-at') || 0);
      if (age > FRESH_MS) {
        /* Stale: hand back what we have, go and get the new one after. A
         * failure here leaves the old entry in place, which is correct —
         * an outage should not blank the bars. */
        ctx.waitUntil(
          countSeats(env.STRIPE_KEY).then(store).catch(() => {}),
        );
      }
    } else {
      try {
        body = await countSeats(env.STRIPE_KEY);
      } catch (e) {
        /* Never serve a wrong number. The page keeps its own fallback when
         * the fetch fails, which is the honest outcome. */
        return json({ error: String(e.message || e) }, 502, { 'cache-control': 'no-store' });
      }
      ctx.waitUntil(store(body));
    }

    const out = url.searchParams.get('explain')
      ? {
          ...body.counts,
          matched: body.labels,
          charges: body.charges,
          unidentified: body.anon,
          manual: body.manual,
          ignored: body.ignored,
        }
      : body.counts;
    /* 30 s at the browser: the visitor's own reload should show a sale
     * that landed a moment ago, and the edge absorbs the traffic anyway. */
    return json(out, 200, { 'cache-control': 'public, max-age=30' });
  },
};
