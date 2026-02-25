/**
 * FlowForge — Supabase Storage Upload Script
 *
 * Uploads all workflow folders from your local disk to Supabase Storage.
 * Already-uploaded files are skipped automatically.
 *
 * Run:
 *   node upload-workflows.mjs
 *
 * To upload only the first N folders (for testing):
 *   node upload-workflows.mjs --limit 5
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(__dir, '.env');
  if (!existsSync(envPath)) { console.error('❌  .env not found'); process.exit(1); }
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

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET_NAME      = process.env.SUPABASE_STORAGE_BUCKET;

if (!SUPABASE_URL)     { console.error('❌  SUPABASE_URL missing');        process.exit(1); }
if (!SUPABASE_SVC_KEY) { console.error('❌  SUPABASE_SERVICE_KEY missing'); process.exit(1); }
if (!BUCKET_NAME)      { console.error('❌  SUPABASE_STORAGE_BUCKET missing'); process.exit(1); }

const LOCAL_WORKFLOWS_DIR = join(__dir, 'workflows', 'n8nworkflows.xyz-main', 'workflows');
const STORAGE_PREFIX      = 'n8nworkflows.xyz-main/workflows';

if (!existsSync(LOCAL_WORKFLOWS_DIR)) {
  console.error(`❌  Local workflows folder not found:\n    ${LOCAL_WORKFLOWS_DIR}`);
  process.exit(1);
}

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

// ── MIME type map ─────────────────────────────────────────────────────────────
const MIME = {
  '.json': 'application/json',
  '.md':   'text/markdown',
  '.webp': 'image/webp',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt':  'text/plain',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract numeric ID from folder name e.g. "[eBay] MCP Server-5579" → "5579"
// Used as the storage folder name to avoid special character issues
function workflowId(folderName) {
  const m = folderName.match(/-(\d+)$/);
  return m ? m[1] : null;
}

async function uploadFile(localPath, storagePath) {
  const ext         = extname(localPath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const fileBuffer  = readFileSync(localPath);

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: false,   // don't overwrite existing files
    });

  if (error) {
    if (error.message?.includes('already exists') || error.statusCode === '409') {
      return 'exists';
    }
    throw error;
  }
  return 'uploaded';
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n📤  FlowForge — Supabase Storage Upload');
console.log(`    Bucket : ${BUCKET_NAME}`);
console.log(`    Source : ${LOCAL_WORKFLOWS_DIR}`);
if (LIMIT < Infinity) console.log(`    Limit  : ${LIMIT} folders`);
console.log();

const allFolders = readdirSync(LOCAL_WORKFLOWS_DIR).filter(name => {
  const p = join(LOCAL_WORKFLOWS_DIR, name);
  return statSync(p).isDirectory() && /-\d+$/.test(name);
});

const folders = LIMIT < Infinity ? allFolders.slice(0, LIMIT) : allFolders;
console.log(`    Found ${allFolders.length} workflow folders locally. Uploading ${folders.length}.\n`);

let uploaded = 0, skipped = 0, failed = 0;

for (let i = 0; i < folders.length; i++) {
  const folderName = folders[i];
  const id = workflowId(folderName);
  if (!id) { skipped++; continue; }

  const localFolder   = join(LOCAL_WORKFLOWS_DIR, folderName);
  const storageFolder = `${STORAGE_PREFIX}/${id}`;   // use ID only — no special chars
  const files         = readdirSync(localFolder);

  process.stdout.write(`  [${String(i + 1).padStart(5)}/${folders.length}] ${folderName.substring(0, 50).padEnd(50)} `);

  let folderUploaded = 0, folderSkipped = 0, folderFailed = 0;

  for (const file of files) {
    const localPath   = join(localFolder, file);
    const storagePath = `${storageFolder}/${file}`;

    // Skip directories (shouldn't exist but just in case)
    if (statSync(localPath).isDirectory()) continue;

    try {
      const result = await uploadFile(localPath, storagePath);
      if (result === 'exists') folderSkipped++;
      else { folderUploaded++; uploaded++; }
    } catch (err) {
      folderFailed++;
      failed++;
      process.stdout.write(`\n      ⚠️  ${file}: ${err.message}`);
    }
  }

  if (folderFailed > 0) {
    console.log(`❌  ${folderUploaded} uploaded, ${folderSkipped} skipped, ${folderFailed} FAILED`);
  } else if (folderSkipped === files.length) {
    console.log(`⏭   Already uploaded`);
    skipped++;
  } else {
    console.log(`✅  ${folderUploaded} file(s) uploaded`);
  }
}

console.log(`\n✨  Done!`);
console.log(`    Files uploaded : ${uploaded}`);
console.log(`    Folders skipped: ${skipped} (already in storage)`);
console.log(`    Files failed   : ${failed}`);
console.log('\n    Run setup next: node setup-products.mjs\n');
