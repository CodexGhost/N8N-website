/**
 * FlowForge — Stripe Setup Script
 *
 * This script:
 *   1. Reads workflow-config.json
 *   2. Creates a Stripe Product + Price + Payment Link for each product
 *   3. Saves Stripe IDs back to workflow-config.json
 *   4. Updates the buy button href in each product HTML page
 *
 * Run once (or again after adding new products):
 *   node setup-stripe.mjs
 *
 * Prerequisites:
 *   npm install
 *   Copy .env.example → .env and fill in STRIPE_SECRET_KEY and SITE_URL
 */

import Stripe from 'stripe';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!existsSync(envPath)) {
    console.error('\n❌  .env file not found.');
    console.error('    Copy .env.example → .env and add your STRIPE_SECRET_KEY.\n');
    process.exit(1);
  }
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

loadEnv();

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const SITE_URL   = (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, '');

if (!STRIPE_KEY || STRIPE_KEY === 'sk_live_YOUR_KEY_HERE') {
  console.error('\n❌  STRIPE_SECRET_KEY is not set in .env\n');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2024-06-20' });

// ── Load config ───────────────────────────────────────────────────────────────
const configPath = join(__dir, 'workflow-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

// ── Process each product ──────────────────────────────────────────────────────
console.log(`\n🔧  FlowForge Stripe Setup`);
console.log(`    Site URL : ${SITE_URL}`);
console.log(`    Products : ${config.products.length}\n`);

for (const product of config.products) {
  process.stdout.write(`  [${product.slug}] `);

  // Skip if already set up (has payment link)
  if (product.stripePaymentLink) {
    console.log(`✅  Already configured → ${product.stripePaymentLink}`);
    continue;
  }

  try {
    // 1. Create Stripe Product
    const stripeProduct = await stripe.products.create({
      name: product.name,
      description: product.description,
      metadata: { slug: product.slug },
    });

    // 2. Create Stripe Price (one-time)
    const stripePrice = await stripe.prices.create({
      product: stripeProduct.id,
      unit_amount: product.price,
      currency: product.currency,
    });

    // 3. Create Payment Link
    //    success_url includes {CHECKOUT_SESSION_ID} — Stripe fills it in
    const successUrl = `${SITE_URL}/download.html?p=${product.slug}&session_id={CHECKOUT_SESSION_ID}`;

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: stripePrice.id, quantity: 1 }],
      after_completion: {
        type: 'redirect',
        redirect: { url: successUrl },
      },
      metadata: { product_slug: product.slug },
    });

    // 4. Update config
    product.stripeProductId    = stripeProduct.id;
    product.stripePriceId      = stripePrice.id;
    product.stripePaymentLinkId = paymentLink.id;
    product.stripePaymentLink  = paymentLink.url;

    console.log(`✅  Created → ${paymentLink.url}`);
  } catch (err) {
    console.error(`❌  Error: ${err.message}`);
    process.exit(1);
  }
}

// ── Save updated config ───────────────────────────────────────────────────────
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('\n💾  workflow-config.json updated.\n');

// ── Patch HTML buy buttons ────────────────────────────────────────────────────
console.log('🔗  Updating buy buttons in HTML pages...\n');

let patchedCount = 0;

for (const product of config.products) {
  if (!product.stripePaymentLink || !product.htmlPage) continue;

  const htmlPath = join(__dir, product.htmlPage);
  if (!existsSync(htmlPath)) {
    console.warn(`  ⚠️  ${product.htmlPage} not found — skipping`);
    continue;
  }

  let html = readFileSync(htmlPath, 'utf8');

  // Match: href="..." data-stripe-link="slug"  (any order of attributes)
  // or:    data-stripe-link="slug" ... href="..."
  // We use two passes to cover both orderings.

  // Pattern A: href comes before data-stripe-link
  // <a href="#" ... data-stripe-link="slug"
  const patternA = new RegExp(
    `(href=")[^"]*("(?=[^>]*data-stripe-link="${product.slug}"))`,
    'g'
  );

  // Pattern B: data-stripe-link comes before href
  // data-stripe-link="slug" ... href="#"
  const patternB = new RegExp(
    `(data-stripe-link="${product.slug}"[^>]*href=")[^"]*(")`  ,
    'g'
  );

  const before = html;
  html = html.replace(patternA, `$1${product.stripePaymentLink}$2`);
  html = html.replace(patternB, `$1${product.stripePaymentLink}$2`);

  if (html !== before) {
    writeFileSync(htmlPath, html);
    console.log(`  ✅  ${product.htmlPage} → buy button updated`);
    patchedCount++;
  } else {
    console.log(`  ℹ️   ${product.htmlPage} → no buy button found (check data-stripe-link attribute)`);
  }
}

console.log(`\n🎉  Done! ${patchedCount} HTML page(s) updated.`);
console.log('    Start your server: node serve.mjs\n');
