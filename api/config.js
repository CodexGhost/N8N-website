// Vercel Serverless Function — /api/config
// Returns public Supabase credentials to the frontend.
// Only the anon key is exposed (read-only, safe to be public).
// The service key and Stripe key never leave the server.

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL      || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
