// Vercel Serverless Function — /api/download
// Verifies payment then redirects to a short-lived Supabase Storage signed URL.
// Users CANNOT download without a verified Stripe payment — returns 403 otherwise.
// Query params: ?p=product-slug&session_id=cs_xxx

import { verifyPayment } from './verify.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_KEY;
const BUCKET_NAME  = process.env.SUPABASE_STORAGE_BUCKET;

export default async function handler(req, res) {
  const slug      = req.query.p          || '';
  const sessionId = req.query.session_id || '';

  // ── 1. Verify payment ───────────────────────────────────────────────────────
  const { ok } = await verifyPayment(sessionId, slug);
  if (!ok) {
    res.status(403).send('Payment not verified.');
    return;
  }

  // ── 2. Get file_path from Supabase products table ───────────────────────────
  let filePath = '';
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/products?slug=eq.${encodeURIComponent(slug)}&select=file_path`,
      {
        headers: {
          apikey:        SUPABASE_SVC,
          Authorization: `Bearer ${SUPABASE_SVC}`,
        },
      }
    );
    const rows = await response.json();
    filePath = rows?.[0]?.file_path || '';
  } catch {
    res.status(500).send('Could not look up product.');
    return;
  }

  if (!filePath) {
    res.status(404).send('Product file path not found.');
    return;
  }

  if (!BUCKET_NAME) {
    res.status(500).send('Storage bucket not configured.');
    return;
  }

  // ── 3. Generate signed URL from Supabase Storage (valid 1 hour) ─────────────
  // URL-encode each path segment to handle special characters in filenames (brackets, spaces, etc.)
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  try {
    const signRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET_NAME}/${encodedPath}`,
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
    if (!signData.signedURL) throw new Error(`Supabase error: ${JSON.stringify(signData)} | path: ${encodedPath} | bucket: ${BUCKET_NAME}`);

    // ── 4. Redirect browser to signed file URL ─────────────────────────────────
    // signedURL from Supabase is relative to /storage/v1 (e.g. /object/sign/...)
    // &download= forces browser to save the file instead of displaying it inline
    res.redirect(302, `${SUPABASE_URL}/storage/v1${signData.signedURL}&download=`);
  } catch (err) {
    res.status(500).send(`Could not generate download link: ${err.message}`);
  }
}
