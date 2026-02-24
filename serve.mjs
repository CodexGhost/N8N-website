import { createServer } from 'http';
import { readFile }     from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { get as httpsGet } from 'https';

const PORT = 3000;
const ROOT = fileURLToPath(new URL('.', import.meta.url));

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const STRIPE_KEY       = process.env.STRIPE_SECRET_KEY     || '';
const SUPABASE_URL     = process.env.SUPABASE_URL           || '';
const SUPABASE_ANON    = process.env.SUPABASE_ANON_KEY      || '';
const SUPABASE_SVC     = process.env.SUPABASE_SERVICE_KEY   || '';
const BUCKET_NAME      = process.env.SUPABASE_STORAGE_BUCKET || '';

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
};

// ── Supabase REST helper (uses Node built-in fetch — requires Node 18+) ───────
async function sbQuery(table, qs = '', opts = {}) {
  const { method = 'GET', body, svc = false } = opts;
  const key = svc ? SUPABASE_SVC : SUPABASE_ANON;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method,
    headers: {
      apikey:          key,
      Authorization:   `Bearer ${key}`,
      'Content-Type':  'application/json',
      Prefer:          method === 'POST' ? 'return=representation' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Stripe session fetch ──────────────────────────────────────────────────────
function stripeGetSession(sessionId) {
  return new Promise((resolve, reject) => {
    if (!STRIPE_KEY) { reject(new Error('No Stripe key')); return; }
    const auth = Buffer.from(`${STRIPE_KEY}:`).toString('base64');
    httpsGet(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
      { headers: { Authorization: `Basic ${auth}` } },
      (r) => {
        let raw = '';
        r.on('data', d => raw += d);
        r.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { reject(new Error('Bad JSON')); }
        });
      }
    ).on('error', reject);
  });
}

// ── Payment verification ──────────────────────────────────────────────────────
async function verifyPayment(sessionId, slug) {
  if (!sessionId || !slug) return { ok: false };

  // 1. Check Supabase purchases table first (fast, avoids Stripe API call)
  if (SUPABASE_URL && SUPABASE_SVC) {
    try {
      const rows = await sbQuery(
        'purchases',
        `session_id=eq.${encodeURIComponent(sessionId)}&product_slug=eq.${encodeURIComponent(slug)}&select=id`,
        { svc: true }
      );
      if (Array.isArray(rows) && rows.length > 0) {
        return { ok: true, fromCache: true };
      }
    } catch { /* fall through to Stripe */ }
  }

  // 2. Fall back to Stripe API
  if (!STRIPE_KEY) return { ok: false };
  try {
    const session = await stripeGetSession(sessionId);
    const paid = session.payment_status === 'paid';

    // Find product's payment link ID from Supabase (or skip check if no Supabase)
    let linkMatch = true;
    if (SUPABASE_URL && SUPABASE_SVC) {
      const rows = await sbQuery(
        'products',
        `slug=eq.${encodeURIComponent(slug)}&select=stripe_payment_link_id`,
        { svc: true }
      );
      if (Array.isArray(rows) && rows[0]?.stripe_payment_link_id) {
        linkMatch = session.payment_link === rows[0].stripe_payment_link_id;
      }
    }

    if (paid && linkMatch) {
      // Record purchase in Supabase (ignore errors — don't block download)
      if (SUPABASE_URL && SUPABASE_SVC) {
        sbQuery('purchases', '', {
          method: 'POST',
          svc: true,
          body: {
            session_id:   sessionId,
            product_slug: slug,
            email:        session.customer_details?.email ?? null,
            amount_paid:  session.amount_total ?? null,
          },
        }).catch(() => {});
      }
      return { ok: true, session };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
createServer(async (req, res) => {
  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── /api/config — public Supabase config for client-side JS ───────────────
  if (pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON }));
    return;
  }

  // ── /api/verify — verify Stripe payment ───────────────────────────────────
  if (pathname === '/api/verify') {
    const slug      = url.searchParams.get('p')          || '';
    const sessionId = url.searchParams.get('session_id') || '';
    try {
      const { ok } = await verifyPayment(sessionId, slug);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  // ── /api/download — verify then serve workflow file ────────────────────────
  if (pathname === '/api/download') {
    const slug      = url.searchParams.get('p')          || '';
    const sessionId = url.searchParams.get('session_id') || '';
    const { ok }    = await verifyPayment(sessionId, slug);

    if (!ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Payment not verified.');
      return;
    }

    // Get file_path from Supabase
    let filePath = '';
    if (SUPABASE_URL && SUPABASE_SVC) {
      try {
        const rows = await sbQuery(
          'products',
          `slug=eq.${encodeURIComponent(slug)}&select=file_path`,
          { svc: true }
        );
        filePath = rows?.[0]?.file_path || '';
      } catch { /* handled below */ }
    }

    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Product file path not found.');
      return;
    }

    if (!BUCKET_NAME) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Storage bucket not configured.');
      return;
    }

    try {
      // Generate a signed URL from Supabase Storage (valid for 1 hour)
      const signRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET_NAME}/${filePath}`,
        {
          method: 'POST',
          headers: {
            apikey:         SUPABASE_SVC,
            Authorization:  `Bearer ${SUPABASE_SVC}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ expiresIn: 3600 }),
        }
      );
      const signData = await signRes.json();
      if (!signData.signedURL) throw new Error('No signed URL returned from storage');

      // Redirect browser directly to the signed file URL
      res.writeHead(302, { Location: `${SUPABASE_URL}${signData.signedURL}` });
      res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Could not generate download link: ${err.message}`);
    }
    return;
  }

  // ── Static file serving ────────────────────────────────────────────────────
  let staticPath = pathname === '/' ? '/index.html' : pathname;

  // Security: block path traversal and secrets
  if (staticPath.includes('..') || /\.env($|\.)/.test(staticPath) || staticPath.endsWith('.mjs')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const data        = await readFile(join(ROOT, staticPath));
    const ext         = extname(staticPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }

}).listen(PORT, () => {
  console.log(`\nFlowForge server → http://localhost:${PORT}`);
  if (!STRIPE_KEY)   console.log('  ⚠️  STRIPE_SECRET_KEY not set — payment verification disabled');
  if (!SUPABASE_URL) console.log('  ⚠️  SUPABASE_URL not set — running without Supabase backend');
  console.log();
});
