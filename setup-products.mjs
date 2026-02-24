/**
 * FlowForge — Product Setup Script
 *
 * Automatically discovers all workflow folders in your Supabase Storage
 * bucket, reads metadata + readme from each, creates Stripe products
 * with payment links, and populates the Supabase `products` table.
 *
 * Run once (or re-run to add new workflows — already-set-up products are skipped):
 *   node setup-products.mjs
 *
 * To process only the first N workflows (useful for testing):
 *   node setup-products.mjs --limit 5
 */

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
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
  const raw = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
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

if (!STRIPE_KEY)       { console.error('❌  STRIPE_SECRET_KEY missing from .env'); process.exit(1); }
if (!SUPABASE_URL)     { console.error('❌  SUPABASE_URL missing from .env');       process.exit(1); }
if (!SUPABASE_SVC_KEY) { console.error('❌  SUPABASE_SERVICE_KEY missing from .env'); process.exit(1); }
if (!BUCKET_NAME)      { console.error('❌  SUPABASE_STORAGE_BUCKET missing from .env'); process.exit(1); }

// Optional --limit N flag
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

const stripe   = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .replace(/[^\w\s-]/g, ' ')   // remove emoji and special chars
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}

function workflowNameFromFolder(folderName) {
  // Folder format: "Workflow Name-1234" — strip the trailing numeric ID
  return folderName.replace(/-\d+$/, '').trim();
}

function computePrice(nodeTypes) {
  // Tier pricing based on workflow complexity (total node count)
  const total = Object.values(nodeTypes).reduce((s, v) => s + (v.count ?? v), 0);
  if (total <= 5)  return 1499;   // $14.99 — simple
  if (total <= 15) return 2499;   // $24.99 — standard
  if (total <= 30) return 3499;   // $34.99 — advanced
  return 4999;                     // $49.99 — complex
}

function shortDescription(readme) {
  if (!readme) return '';
  // Try to extract the Workflow Overview paragraph
  const match = readme.match(/###\s+1\.\s+Workflow Overview[\s\S]*?\n([\s\S]+?)(?:\n\n|\n-{3}|\n###)/);
  const raw = match
    ? match[1]
    : readme.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.match(/^https?:\/\//));
  return (raw || '').replace(/\n/g, ' ').trim().substring(0, 300);
}

// ── Supabase Storage helpers ──────────────────────────────────────────────────

async function listFolder(prefix) {
  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .list(prefix || undefined, { limit: 1000 });
  if (error) { console.error(`  list error (${prefix}): ${error.message}`); return []; }
  return data || [];
}

async function downloadText(path) {
  const { data, error } = await supabase.storage.from(BUCKET_NAME).download(path);
  if (error || !data) return null;
  return await data.text();
}

// Recursively find all "workflow folders" (folders containing a metada-*.json file)
async function findWorkflowFolders(prefix = '', depth = 0) {
  if (depth > 6) return [];
  const items = await listFolder(prefix);
  const results = [];

  for (const item of items) {
    // Files have metadata.size; folders do not
    const isFolder = !item.metadata?.size;
    if (!isFolder) continue;

    const path = prefix ? `${prefix}/${item.name}` : item.name;
    const contents = await listFolder(path);
    const hasMetadata = contents.some(
      f => f.name.startsWith('metada-') && f.name.endsWith('.json')
    );

    if (hasMetadata) {
      results.push({ folderPath: path, folderName: item.name, files: contents });
    } else {
      // Not a workflow folder — go one level deeper
      const deeper = await findWorkflowFolders(path, depth + 1);
      results.push(...deeper);
    }
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🔧  FlowForge — Product Setup');
console.log(`    Bucket  : ${BUCKET_NAME}`);
console.log(`    Site URL: ${SITE_URL}`);
if (LIMIT < Infinity) console.log(`    Limit   : ${LIMIT} workflows`);
console.log('\n🔍  Scanning Supabase Storage for workflow folders...\n');

const allFolders = await findWorkflowFolders();

if (allFolders.length === 0) {
  console.error('❌  No workflow folders found. Check SUPABASE_STORAGE_BUCKET in .env.');
  process.exit(1);
}

const folders = allFolders.slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`    Found ${allFolders.length} workflow folders. Processing ${folders.length}.\n`);

let created = 0, skipped = 0, failed = 0;

for (const { folderPath, folderName, files } of folders) {
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

    // Locate the relevant files in this folder
    const metaFile     = files.find(f => f.name.startsWith('metada-') && f.name.endsWith('.json'));
    const workflowFile = files.find(f => f.name.endsWith('.json') && !f.name.startsWith('metada-'));
    const readmeFile   = files.find(f => f.name.endsWith('.md'));

    if (!metaFile || !workflowFile) {
      console.log('⚠️   Skipped — missing metadata or workflow file');
      skipped++;
      continue;
    }

    // Download metadata + readme in parallel
    const [metaText, readmeText] = await Promise.all([
      downloadText(`${folderPath}/${metaFile.name}`),
      readmeFile ? downloadText(`${folderPath}/${readmeFile.name}`) : Promise.resolve(''),
    ]);

    if (!metaText) {
      console.log('⚠️   Skipped — could not read metadata');
      skipped++;
      continue;
    }

    const meta      = JSON.parse(metaText);
    const nodeTypes = meta.nodeTypes  || {};
    const category  = meta.categories?.[0]?.name || 'Automation';
    const nodeNames = Object.keys(nodeTypes).map(k => k.split('.').pop());
    const price     = computePrice(nodeTypes);
    const desc      = shortDescription(readmeText || '');
    const longDesc  = (readmeText || desc).substring(0, 2000);
    const filePath  = `${folderPath}/${workflowFile.name}`;

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
console.log('    Check your products: Supabase Dashboard → Table Editor → products');
console.log('    Start the server:    node serve.mjs\n');
