// Vercel Serverless Function — /api/verify
// Verifies a Stripe payment before allowing download.
// Query params: ?p=product-slug&session_id=cs_xxx
// Returns: { ok: true } or { ok: false }

const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_KEY;

async function sbQuery(table, qs, svc = false) {
  const key = svc ? SUPABASE_SVC : process.env.SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: {
      apikey:         key,
      Authorization:  `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

async function stripeGetSession(sessionId) {
  const auth = Buffer.from(`${STRIPE_KEY}:`).toString('base64');
  const res  = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  return res.json();
}

export async function verifyPayment(sessionId, slug) {
  if (!sessionId || !slug) return { ok: false };

  // 1. Fast path — check purchases table (avoids a Stripe API call)
  if (SUPABASE_URL && SUPABASE_SVC) {
    try {
      const rows = await sbQuery(
        'purchases',
        `session_id=eq.${encodeURIComponent(sessionId)}&product_slug=eq.${encodeURIComponent(slug)}&select=id`,
        true
      );
      if (Array.isArray(rows) && rows.length > 0) return { ok: true };
    } catch { /* fall through */ }
  }

  // 2. Verify with Stripe
  if (!STRIPE_KEY) return { ok: false };
  try {
    const session = await stripeGetSession(sessionId);
    const paid = session.payment_status === 'paid';

    let linkMatch = true;
    if (SUPABASE_URL && SUPABASE_SVC) {
      const rows = await sbQuery(
        'products',
        `slug=eq.${encodeURIComponent(slug)}&select=stripe_payment_link_id`,
        true
      );
      if (Array.isArray(rows) && rows[0]?.stripe_payment_link_id) {
        linkMatch = session.payment_link === rows[0].stripe_payment_link_id;
      }
    }

    if (paid && linkMatch) {
      // Record purchase so future calls skip Stripe (best-effort)
      if (SUPABASE_URL && SUPABASE_SVC) {
        fetch(`${SUPABASE_URL}/rest/v1/purchases`, {
          method: 'POST',
          headers: {
            apikey:         SUPABASE_SVC,
            Authorization:  `Bearer ${SUPABASE_SVC}`,
            'Content-Type': 'application/json',
            Prefer:         'return=minimal',
          },
          body: JSON.stringify({
            session_id:   sessionId,
            product_slug: slug,
            email:        session.customer_details?.email ?? null,
            amount_paid:  session.amount_total ?? null,
          }),
        }).catch(() => {});
      }
      return { ok: true };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export default async function handler(req, res) {
  const slug      = req.query.p          || '';
  const sessionId = req.query.session_id || '';
  try {
    const { ok } = await verifyPayment(sessionId, slug);
    res.setHeader('Content-Type', 'application/json');
    res.json({ ok });
  } catch {
    res.json({ ok: false });
  }
}
