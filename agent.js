require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { Resend } = require('resend');

const WP_BASE_URL = process.env.WP_BASE_URL;
const BP_TOKEN = process.env.BOTPRESS_API_TOKEN;
const BP_BOT_ID = process.env.BOTPRESS_BOT_ID;
const BP_TABLE_ID = process.env.BOTPRESS_TABLE_ID;

const botpressHeaders = {
  Authorization: `Bearer ${BP_TOKEN}`,
  'x-bot-id': BP_BOT_ID,
  'Content-Type': 'application/json',
};

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO || 'hiquah.media@gmail.com';

// ─── Send email with change report ───────────────────────────────────────────
async function sendChangeEmail(added, updated, deleted) {
  if (!RESEND_API_KEY) {
    console.log('  (Email skipped — RESEND_API_KEY not set in .env)');
    return;
  }

  const resend = new Resend(RESEND_API_KEY);
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let html = `<h2>AJ Real Estate — Property Sync Report</h2><p><strong>Date:</strong> ${date}</p><hr>`;

  if (added.length > 0) {
    html += `<h3>➕ New Listings Added (${added.length})</h3><ul>`;
    added.forEach(r => html += `<li><a href="${r.link}">${r.title}</a> — ${r.price} | ${r.Location}</li>`);
    html += '</ul>';
  }

  if (updated.length > 0) {
    html += `<h3>✏️ Updated Listings (${updated.length})</h3><ul>`;
    updated.forEach(({ row, changed, existing }) => {
      html += `<li><strong><a href="${row.link}">${row.title}</a></strong><ul>`;
      changed.forEach(f => html += `<li>${f}: <em>"${existing[f] ?? ''}"</em> → <strong>"${row[f] ?? ''}"</strong></li>`);
      html += '</ul></li>';
    });
    html += '</ul>';
  }

  if (deleted.length > 0) {
    html += `<h3>🗑️ Removed Listings (${deleted.length})</h3><ul>`;
    deleted.forEach(r => html += `<li>${r.title || r.externalId}</li>`);
    html += '</ul>';
  }

  html += `<hr><p style="color:#888;font-size:12px">Sent automatically by AJ Real Estate Sync Agent</p>`;

  await resend.emails.send({
    from: 'AJ Real Estate Sync <onboarding@resend.dev>',
    to: EMAIL_TO,
    subject: `Property Update — ${added.length} added, ${updated.length} updated, ${deleted.length} removed`,
    html,
  });

  console.log(`  📧 Email sent to ${EMAIL_TO}`);
}

// ─── Fetch all WP listings ────────────────────────────────────────────────────
async function fetchAllWpListings() {
  const listings = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const res = await axios.get(`${WP_BASE_URL}/wp-json/wp/v2/estate`, {
      params: { per_page: 20, page },
    });
    totalPages = parseInt(res.headers['x-wp-totalpages'], 10);
    listings.push(...res.data);
    page++;
  }
  return listings;
}

// ─── Scrape listing page for price + specs ────────────────────────────────────
async function scrapeListingDetails(url) {
  try {
    const { data: html } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(html);

    const priceUSD = $('.mh-estate__details__price__single').first().text().trim();
    const priceAWG = $('.mh-estate__details__price__single').eq(1).text().trim();
    const price = priceUSD || priceAWG || 'Contact for price';

    const details = {};
    $('.mh-estate__list__element').each((_, el) => {
      const raw = $(el).text().replace(/\t/g, '').replace(/ {2,}/g, ' ').replace(/\n+/g, '\n').trim();
      const colonIdx = raw.indexOf(':');
      if (colonIdx === -1) return;
      const label = raw.slice(0, colonIdx).trim().toLowerCase();
      const value = raw.slice(colonIdx + 1).replace(/\s+/g, ' ').trim();
      details[label] = value;
    });

    return {
      price,
      bedrooms: details['bedrooms'] || '',
      bathrooms: details['bathrooms'] || '',
      size: details['property size'] || details['built-up area'] || '',
      lotSize: details['lot size'] || '',
    };
  } catch {
    return { price: 'Contact for price', bedrooms: '', bathrooms: '', size: '', lotSize: '' };
  }
}

// ─── Parse WP listing into flat object ───────────────────────────────────────
function parseWpListing(listing) {
  const classList = listing.class_list || [];

  const propertyTypeClass = classList.find(c => c.startsWith('property-type-') && c !== 'property-type');
  const propertyType = propertyTypeClass
    ? propertyTypeClass.replace('property-type-', '').replace(/-/g, ' ')
    : '';

  const offerTypeSlugs = classList
    .filter(c => c.startsWith('offer-type-'))
    .map(c => c.replace('offer-type-', '').replace(/-/g, ' '));
  const rentSale = offerTypeSlugs.join(', ');

  const cityClass = classList.find(c => c.startsWith('city-'));
  const city = cityClass ? cityClass.replace('city-', '').replace(/-/g, ' ') : '';

  const neighborhoodClass = classList.find(c => c.startsWith('neighborhood-'));
  const neighborhood = neighborhoodClass
    ? neighborhoodClass.replace('neighborhood-', '').replace(/-/g, ' ')
    : '';

  const locationParts = [neighborhood, city, 'Aruba']
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1));
  const seen = new Set();
  const location = locationParts
    .filter(p => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .join(', ');

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const decodeHtml = s => (s || '').replace(/&#038;/g, '&').replace(/&#8211;/g, '–').replace(/&amp;/g, '&').replace(/&#\d+;/g, c => String.fromCharCode(parseInt(c.slice(2, -1))));

  return {
    externalId: String(listing.id),
    title: decodeHtml(listing.title?.rendered || ''),
    link: listing.link || '',
    PropertyType: cap(propertyType),
    RentSale: cap(rentSale),
    Location: location,
  };
}

// ─── Fetch all rows from Botpress table ───────────────────────────────────────
async function fetchAllBotpressRows() {
  const rows = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await axios.post(
      `https://api.botpress.cloud/v1/tables/${BP_TABLE_ID}/rows/find`,
      { limit, offset },
      { headers: botpressHeaders }
    );
    rows.push(...res.data.rows);
    if (!res.data.hasMore) break;
    offset += limit;
  }
  return rows;
}

// ─── Delete rows from Botpress by table row id ───────────────────────────────
async function deleteRows(rowIds) {
  await axios.post(
    `https://api.botpress.cloud/v1/tables/${BP_TABLE_ID}/rows/delete`,
    { ids: rowIds },
    { headers: botpressHeaders }
  );
}

// ─── Upsert rows ──────────────────────────────────────────────────────────────
async function upsertRows(rows) {
  const BATCH = 10;
  for (let i = 0; i < rows.length; i += BATCH) {
    await axios.post(
      `https://api.botpress.cloud/v1/tables/${BP_TABLE_ID}/rows/upsert`,
      { rows: rows.slice(i, i + BATCH), keyColumn: 'externalId' },
      { headers: botpressHeaders }
    );
  }
}

// ─── Compare two row objects — returns list of changed field names ─────────────
const TRACKED_FIELDS = ['title', 'PropertyType', 'price', 'Location', 'RentSale', 'link', 'bedrooms', 'bathrooms', 'size', 'lotSize'];

function findChanges(existing, incoming) {
  return TRACKED_FIELDS.filter(f => {
    const a = (existing[f] ?? '').toString().trim();
    const b = (incoming[f] ?? '').toString().trim();
    return a !== b;
  });
}

// ─── Main agent ───────────────────────────────────────────────────────────────
async function main() {
  console.log('🤖 AJ Real Estate — Property Sync Agent\n');

  // 1. Load current state from both sources
  process.stdout.write('📡 Fetching WordPress listings... ');
  const wpListings = await fetchAllWpListings();
  console.log(`${wpListings.length} found`);

  process.stdout.write('📋 Fetching Botpress table rows... ');
  const bpRows = await fetchAllBotpressRows();
  console.log(`${bpRows.length} found\n`);

  // 2. Build lookup maps
  const wpById = new Map();     // externalId → WP listing
  const bpByExternalId = new Map();  // externalId → BP row

  for (const r of bpRows) {
    if (r.externalId) bpByExternalId.set(String(r.externalId), r);
  }

  // 3. Scrape live details for each WP listing
  console.log('🔍 Scanning all listings for current details...\n');
  const incoming = [];

  for (let i = 0; i < wpListings.length; i++) {
    const listing = wpListings[i];
    const base = parseWpListing(listing);
    process.stdout.write(`  [${i + 1}/${wpListings.length}] ${base.title}... `);
    const details = await scrapeListingDetails(base.link);
    process.stdout.write(`${details.price}\n`);

    incoming.push({ ...base, ...details });
    wpById.set(base.externalId, true);

    await new Promise(r => setTimeout(r, 300));
  }

  // 4. Determine what needs to change
  const toAdd = [];
  const toUpdate = [];
  const toDelete = [];

  // New or changed listings
  for (const row of incoming) {
    const existing = bpByExternalId.get(row.externalId);
    if (!existing) {
      toAdd.push(row);
    } else {
      const changed = findChanges(existing, row);
      if (changed.length > 0) {
        toUpdate.push({ row, changed, existing });
      }
    }
  }

  // Stale rows (in Botpress but no longer on site) — only delete rows with a valid WP externalId
  for (const bpRow of bpRows) {
    const id = String(bpRow.externalId || '');
    if (id && !wpById.has(id)) {
      toDelete.push(bpRow);
    }
  }

  // 5. Report
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Change Report');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅ Unchanged: ${incoming.length - toAdd.length - toUpdate.length}`);
  console.log(`  ➕ New listings to add: ${toAdd.length}`);
  console.log(`  ✏️  Listings with updates: ${toUpdate.length}`);
  console.log(`  🗑️  Stale listings to delete: ${toDelete.length}`);

  if (toAdd.length > 0) {
    console.log('\n  New listings:');
    toAdd.forEach(r => console.log(`    + ${r.title}`));
  }

  if (toUpdate.length > 0) {
    console.log('\n  Updated listings:');
    toUpdate.forEach(({ row, changed }) => {
      const existing = bpByExternalId.get(row.externalId);
      console.log(`    ~ ${row.title}`);
      changed.forEach(f => console.log(`        ${f}: "${existing[f] ?? ''}" → "${row[f] ?? ''}"`));
    });
  }

  if (toDelete.length > 0) {
    console.log('\n  Removed listings:');
    toDelete.forEach(r => console.log(`    - ${r.title || r.externalId}`));
  }

  // 6. Apply changes
  if (toAdd.length === 0 && toUpdate.length === 0 && toDelete.length === 0) {
    console.log('\n✅ Everything is up to date. No changes needed.');
    return;
  }

  console.log('\n⚙️  Applying changes...');

  if (toAdd.length > 0) {
    await upsertRows(toAdd);
    console.log(`  ➕ Added ${toAdd.length} new listing(s)`);
  }

  if (toUpdate.length > 0) {
    await upsertRows(toUpdate.map(({ row }) => row));
    console.log(`  ✏️  Updated ${toUpdate.length} listing(s)`);
  }

  if (toDelete.length > 0) {
    await deleteRows(toDelete.map(r => r.id));
    console.log(`  🗑️  Deleted ${toDelete.length} stale listing(s)`);
  }

  console.log('\n📧 Sending change report email...');
  await sendChangeEmail(toAdd, toUpdate, toDelete);

  console.log('\n✅ Agent complete. Botpress table is fully up to date.');
}

main().catch(err => {
  console.error('\n❌ Agent failed:', err.message);
  process.exit(1);
});
