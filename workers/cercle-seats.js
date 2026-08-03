/* Cercle de Voix — seat counter.
 *
 * Circle knows how many seats are sold; the landing page does not. This
 * is the wire between them.
 *
 *   POST /book?slot=mardi&key=SECRET   -> +1 seat   (called by Circle)
 *   GET  /counts                       -> {"mardi":5,"mercredi":3}
 *   POST /set?slot=mardi&n=5&key=SECRET-> set exactly (seeding / fixing)
 *
 * Counting server-side rather than in the buyer's browser is deliberate:
 * a browser-side counter misses anyone with an ad blocker or who closes
 * the tab, and the number on the page has to be true.
 */

const SLOTS = ['mardi', 'mercredi'];
const CAP = 12;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors, ...extra },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    /* ---- public: what the page reads ---- */
    if (path === '/counts' && request.method === 'GET') {
      const out = {};
      for (const s of SLOTS) out[s] = Number(await env.SEATS.get(s)) || 0;
      // 30s edge cache: the page is read far more often than a seat sells,
      // and a half-minute of staleness never shows a cohort as open once full.
      return json(out, 200, { 'cache-control': 'public, max-age=30' });
    }

    /* ---- everything below needs the shared secret ---- */
    const key = url.searchParams.get('key');
    if (!env.SEATS_SECRET || key !== env.SEATS_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }

    const slot = (url.searchParams.get('slot') || '').toLowerCase();
    if (!SLOTS.includes(slot)) return json({ error: 'unknown slot', slot }, 400);

    if (path === '/book' && request.method === 'POST') {
      /* Circle may retry a webhook. If it sends an id, only count it once. */
      const id = url.searchParams.get('id');
      if (id) {
        const seen = await env.SEATS.get('seen:' + id);
        if (seen) return json({ slot, taken: Number(await env.SEATS.get(slot)) || 0, duplicate: true });
        await env.SEATS.put('seen:' + id, '1', { expirationTtl: 60 * 60 * 24 * 90 });
      }
      const next = Math.min(CAP, (Number(await env.SEATS.get(slot)) || 0) + 1);
      await env.SEATS.put(slot, String(next));
      return json({ slot, taken: next, full: next >= CAP });
    }

    if (path === '/set' && request.method === 'POST') {
      const n = Number(url.searchParams.get('n'));
      if (!Number.isInteger(n) || n < 0 || n > CAP) {
        return json({ error: 'n must be an integer 0..' + CAP }, 400);
      }
      await env.SEATS.put(slot, String(n));
      return json({ slot, taken: n });
    }

    return json({ error: 'not found' }, 404);
  },
};
