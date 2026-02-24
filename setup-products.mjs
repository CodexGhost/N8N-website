/**
 * FlowForge — Product Setup Script
 *
 * Reads workflow folders from your LOCAL disk, creates Stripe products
 * with payment links, and populates the Supabase `products` table.
 *
 * Downloads are served via Supabase Storage signed URLs — make sure
 * your files are also uploaded to Supabase Storage (run upload-workflows.mjs).
 *
 * Run once (or re-run to add new workflows — already-set-up products are skipped):
 *   node setup-products.mjs
 *
 * To process only the first N workflows (useful for testing):
 *   node setup-products.mjs --limit 5
 */

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!existsSync(envPath)) {
    console.error('\n❌  .env not found. Fill in all keys.\n');
    process.exit(1);
  }
  const raw = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key) process.env[key] = val;
  }
}
loadEnv();

const STRIPE_KEY       = process.env.STRIPE_SECRET_KEY;
const SITE_URL         = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET_NAME      = process.env.SUPABASE_STORAGE_BUCKET;

// Local path to the workflows folder
const LOCAL_WORKFLOWS_DIR = join(__dir, 'workflows', 'n8nworkflows.xyz-main', 'workflows');
// Matching path prefix inside the Supabase Storage bucket (for download signed URLs)
const STORAGE_PREFIX = 'n8nworkflows.xyz-main/workflows';

if (!STRIPE_KEY)       { console.error('❌  STRIPE_SECRET_KEY missing from .env'); process.exit(1); }
if (!SUPABASE_URL)     { console.error('❌  SUPABASE_URL missing from .env');       process.exit(1); }
if (!SUPABASE_SVC_KEY) { console.error('❌  SUPABASE_SERVICE_KEY missing from .env'); process.exit(1); }
if (!BUCKET_NAME)      { console.error('❌  SUPABASE_STORAGE_BUCKET missing from .env'); process.exit(1); }

if (!existsSync(LOCAL_WORKFLOWS_DIR)) {
  console.error(`❌  Local workflows folder not found at:\n    ${LOCAL_WORKFLOWS_DIR}`);
  process.exit(1);
}

// Optional --limit N flag
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

const stripe   = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}

function workflowNameFromFolder(folderName) {
  return folderName.replace(/-\d+$/, '').trim();
}

function computePrice(nodeTypes) {
  const total = Object.values(nodeTypes).reduce((s, v) => s + (v.count ?? v), 0);
  if (total <= 5)  return 1499;
  if (total <= 15) return 2499;
  if (total <= 30) return 3499;
  return 4999;
}

function shortDescription(readme) {
  if (!readme) return '';
  const match = readme.match(/###\s+1\.\s+Workflow Overview[\s\S]*?\n([\s\S]+?)(?:\n\n|\n-{3}|\n###)/);
  const raw = match
    ? match[1]
    : readme.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.match(/^https?:\/\//));
  return (raw || '').replace(/\n/g, ' ').trim().substring(0, 300);
}

// ── Local disk discovery ──────────────────────────────────────────────────────

function getWorkflowFolders() {
  return readdirSync(LOCAL_WORKFLOWS_DIR).filter(name => {
    const fullPath = join(LOCAL_WORKFLOWS_DIR, name);
    return statSync(fullPath).isDirectory() && /-\d+$/.test(name);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🔧  FlowForge — Product Setup (reading from local disk)');
console.log(`    Workflows : ${LOCAL_WORKFLOWS_DIR}`);
console.log(`    Bucket    : ${BUCKET_NAME}`);
console.log(`    Site URL  : ${SITE_URL}`);
if (LIMIT < Infinity) console.log(`    Limit     : ${LIMIT} workflows`);
console.log('\n🔍  Scanning local workflow folders...\n');

const allFolderNames = getWorkflowFolders();

if (allFolderNames.length === 0) {
  console.error('❌  No workflow folders found locally.');
  process.exit(1);
}

const folderNames = LIMIT < Infinity ? allFolderNames.slice(0, LIMIT) : allFolderNames;
console.log(`    Found ${allFolderNames.length} workflow folders. Processing ${folderNames.length}.\n`);

let created = 0, skipped = 0, failed = 0;

for (const folderName of folderNames) {
  const name = workflowNameFromFolder(folderName);
  const slug = slugify(name);
  if (!slug) { skipped++; continue; }

  process.stdout.write(`  [${slug.substring(0, 45).padEnd(45)}] `);

  try {
    // Skip if already configured in Supabase
    const { data: existing } = await supabase
      .from('products')
      .select('stripe_payment_link')
      .eq('slug', slug)
      .maybeSingle();

    if (existing?.stripe_payment_link) {
      console.log('⏭   Already set up');
      skipped++;
      continue;
    }

    // Read files from local disk
    const folderPath  = join(LOCAL_WORKFLOWS_DIR, folderName);
    const files       = readdirSync(folderPath);

    const metaFile     = files.find(f => f.startsWith('metada-') && f.endsWith('.json'));
    const workflowFile = files.find(f => f.endsWith('.json') && !f.startsWith('metada-'));
    const readmeFile   = files.find(f => f.endsWith('.md'));

    if (!metaFile || !workflowFile) {
      console.log('⚠️   Skipped — missing metadata or workflow file');
      skipped++;
      continue;
    }

    const metaText   = readFileSync(join(folderPath, metaFile),   'utf8');
    const readmeText = readmeFile ? readFileSync(join(folderPath, readmeFile), 'utf8') : '';

    const meta      = JSON.parse(metaText);
    const nodeTypes = meta.nodeTypes  || {};
    const category  = meta.categories?.[0]?.name || 'Automation';
    const nodeNames = Object.keys(nodeTypes).map(k => k.split('.').pop());
    const price     = computePrice(nodeTypes);
    const desc      = shortDescription(readmeText);
    const longDesc  = readmeText.substring(0, 2000) || desc;

    // Supabase Storage path for this workflow's JSON file (used for signed URL downloads)
    const filePath = `${STORAGE_PREFIX}/${folderName}/${workflowFile}`;

    // ── Create Stripe Product ─────────────────────────────────────────────────
    const stripeProduct = await stripe.products.create({
      name,
      description: desc || name,
      metadata:    { slug },
    });

    // ── Create Stripe Price (one-time) ────────────────────────────────────────
    const stripePrice = await stripe.prices.create({
      product:     stripeProduct.id,
      unit_amount: price,
      currency:    'usd',
    });

    // ── Create Payment Link ───────────────────────────────────────────────────
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: stripePrice.id, quantity: 1 }],
      after_completion: {
        type:     'redirect',
        redirect: { url: `${SITE_URL}/download.html?p=${slug}&session_id={CHECKOUT_SESSION_ID}` },
      },
      metadata: { product_slug: slug },
    });

    // ── Upsert into Supabase ──────────────────────────────────────────────────
    const { error } = await supabase.from('products').upsert({
      slug,
      name,
      description:            desc,
      long_description:       longDesc,
      price,
      currency:               'usd',
      category,
      node_types:             nodeNames,
      file_path:              filePath,
      stripe_product_id:      stripeProduct.id,
      stripe_price_id:        stripePrice.id,
      stripe_payment_link_id: paymentLink.id,
      stripe_payment_link:    paymentLink.url,
      active:                 true,
    }, { onConflict: 'slug' });

    if (error) throw new Error(error.message);

    console.log(`✅  $${(price / 100).toFixed(2)}`);
    created++;

  } catch (err) {
    console.error(`❌  ${err.message}`);
    failed++;
  }
}

console.log(`\n✨  Done!  Created: ${created}  |  Skipped: ${skipped}  |  Failed: ${failed}`);
console.log('    Check products: Supabase Dashboard → Table Editor → products');
console.log('    Upload files:   node upload-workflows.mjs');
console.log('    Start server:   node serve.mjs\n');
