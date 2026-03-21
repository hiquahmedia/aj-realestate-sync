require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');

const WP_BASE_URL = process.env.WP_BASE_URL;
const BP_TOKEN = process.env.BOTPRESS_API_TOKEN;
const BP_BOT_ID = process.env.BOTPRESS_BOT_ID;
const BP_TABLE_ID = process.env.BOTPRESS_TABLE_ID;

const botpressHeaders = {
  Authorization: `Bearer ${BP_TOKEN}`,
  'x-bot-id': BP_BOT_ID,
  'Content-Type': 'application/json',
};

// ─── Step 1: Fetch all listings from WordPress REST API ───────────────────────
async function fetchAllListings() {
  const listings = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const response = await axios.get(`${WP_BASE_URL}/wp-json/wp/v2/estate`, {
      params: { per_page: 20, page, _embed: true },
    });

    totalPages = parseInt(response.headers['x-wp-totalpages'], 10);
    listings.push(...response.data);
    console.log(`  Fetched page ${page}/${totalPages} (${response.data.length} listings)`);
    page++;
  }

  return listings;
}

// ─── Step 2: Scrape price + specs from individual listing page ─────────────────
async function scrapeListingDetails(url) {
  try {
    const { data: html } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(html);

    // USD price — first .mh-estate__details__price__single element
    const priceUSD = $('.mh-estate__details__price__single').first().text().trim();
    const priceAWG = $('.mh-estate__details__price__single').eq(1).text().trim();
    const price = priceUSD || priceAWG || 'Contact for price';

    // Parse structured detail list items (label: value)
    const details = {};
    $('.mh-estate__list__element').each((_, el) => {
      const raw = $(el).text().replace(/\t/g, '').replace(/ {2,}/g, ' ').replace(/\n+/g, '\n').trim();
      const colonIdx = raw.indexOf(':');
      if (colonIdx === -1) return;
      const label = raw.slice(0, colonIdx).trim().toLowerCase();
      const value = raw.slice(colonIdx + 1).replace(/\s+/g, ' ').trim();
      details[label] = value;
    });

    const size = details['property size'] || details['built-up area'] || '';
    const lotSize = details['lot size'] || '';
    const bedrooms = details['bedrooms'] || '';
    const bathrooms = details['bathrooms'] || '';

    return { price, bedrooms, bathrooms, size, lotSize };
  } catch (err) {
    console.warn(`  Could not scrape ${url}: ${err.message}`);
    return { price: 'Contact for price', bedrooms: '', bathrooms: '', size: '', lotSize: '' };
  }
}

// ─── Step 3: Extract useful data from WP API listing object ───────────────────
function parseWpListing(listing) {
  const classList = listing.class_list || [];

  // Property type from class_list (e.g. "property-type-house-for-sale")
  const propertyTypeClass = classList.find(c => c.startsWith('property-type-') && c !== 'property-type');
  const propertyType = propertyTypeClass
    ? propertyTypeClass.replace('property-type-', '').replace(/-/g, ' ')
    : '';

  // Offer type — sale or rent, plus modifiers
  const offerTypeSlugs = classList
    .filter(c => c.startsWith('offer-type-'))
    .map(c => c.replace('offer-type-', '').replace(/-/g, ' '));
  const rentSale = offerTypeSlugs.join(', ');

  // City from class_list (e.g. "city-savaneta")
  const cityClass = classList.find(c => c.startsWith('city-'));
  const city = cityClass
    ? cityClass.replace('city-', '').replace(/-/g, ' ')
    : '';

  // Neighborhood
  const neighborhoodClass = classList.find(c => c.startsWith('neighborhood-'));
  const neighborhood = neighborhoodClass
    ? neighborhoodClass.replace('neighborhood-', '').replace(/-/g, ' ')
    : '';

  // Deduplicate location parts (neighborhood often equals city)
  const locationParts = [neighborhood, city, 'Aruba']
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1));
  const seen = new Set();
  const location = locationParts.filter(p => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(', ');

  return {
    externalId: String(listing.id),
    title: (listing.title?.rendered || '').replace(/&#038;/g, '&').replace(/&#8211;/g, '–').replace(/&amp;/g, '&').replace(/&#\d+;/g, c => String.fromCharCode(parseInt(c.slice(2,-1)))),
    link: listing.link || '',
    propertyType: propertyType.charAt(0).toUpperCase() + propertyType.slice(1),
    rentSale: rentSale.charAt(0).toUpperCase() + rentSale.slice(1),
    location,
  };
}

// ─── Step 4: Upsert rows to Botpress table ────────────────────────────────────
async function upsertToBotpress(rows) {
  const BATCH_SIZE = 10;
  let upserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await axios.post(
      `https://api.botpress.cloud/v1/tables/${BP_TABLE_ID}/rows/upsert`,
      { rows: batch, keyColumn: 'externalId' },
      { headers: botpressHeaders }
    );
    upserted += batch.length;
    console.log(`  Upserted ${upserted}/${rows.length} rows to Botpress`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏠 AJ Real Estate → Botpress Sync\n');

  console.log('📡 Fetching listings from WordPress...');
  const wpListings = await fetchAllListings();
  console.log(`✅ Found ${wpListings.length} listings\n`);

  console.log('🔍 Scraping listing details (price, beds, baths, size)...');
  const rows = [];

  for (let i = 0; i < wpListings.length; i++) {
    const listing = wpListings[i];
    const base = parseWpListing(listing);

    process.stdout.write(`  [${i + 1}/${wpListings.length}] ${base.title}... `);
    const details = await scrapeListingDetails(base.link);
    process.stdout.write(`${details.price || 'no price'}\n`);

    rows.push({
      externalId: base.externalId,
      PropertyType: base.propertyType,
      price: details.price,
      Location: base.location,
      RentSale: base.rentSale,
      link: base.link,
      // Extra fields stored alongside defined columns
      title: base.title,
      bedrooms: details.bedrooms,
      bathrooms: details.bathrooms,
      size: details.size,
      lotSize: details.lotSize,
    });

    // Small delay to avoid hammering the site
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n📤 Upserting ${rows.length} rows to Botpress...\n`);
  await upsertToBotpress(rows);

  console.log('\n✅ Sync complete!');
  console.log(`   Total listings synced: ${rows.length}`);
  const withPrice = rows.filter(r => r.price).length;
  console.log(`   Listings with price:   ${withPrice}/${rows.length}`);
}

main().catch(err => {
  console.error('\n❌ Sync failed:', err.message);
  process.exit(1);
});
