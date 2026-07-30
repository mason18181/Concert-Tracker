require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, initSchema } = require('./db');
const { findOrCreateSong } = require('./matching');
const ors = require('./ors');

async function getOrCreateCompanion(name) {
  const existing = (await pool.query('SELECT id FROM companions WHERE name=$1', [name])).rows[0];
  if (existing) return existing.id;
  const inserted = (await pool.query('INSERT INTO companions (name) VALUES ($1) RETURNING id', [name])).rows[0];
  return inserted.id;
}

async function run() {
  await initSchema();
  const seedPath = path.join(__dirname, 'seed', 'historical_seed.json');
  const shows = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  console.log(`Importing ${shows.length} historical shows...`);

  const venueCoordCache = {};

  for (const show of shows) {
    const already = (await pool.query('SELECT id FROM shows WHERE date=$1 AND venue=$2', [show.date, show.venue])).rows[0];
    if (already) { console.log(`Skipping already-imported show: ${show.date} ${show.venue}`); continue; }

    // Geocode venue (cached per unique venue) and this show's origin address.
    const venueKey = `${show.venue}, ${show.city}, ${show.state}`;
    if (!(venueKey in venueCoordCache)) {
      try { venueCoordCache[venueKey] = await ors.geocode(venueKey); }
      catch (e) { console.warn(`Venue geocode failed for ${venueKey}: ${e.message}`); venueCoordCache[venueKey] = null; }
    }
    const venueCoord = venueCoordCache[venueKey];

    let originCoord = null;
    try { originCoord = await ors.geocode(show.origin_address); }
    catch (e) { console.warn(`Origin geocode failed for ${show.origin_address}: ${e.message}`); }

    let distance = null;
    if (venueCoord && originCoord) {
      try { distance = await ors.drivingDistance(originCoord, venueCoord); }
      catch (e) { console.warn(`Directions failed for ${show.date}: ${e.message}`); }
    }

    const showRow = (await pool.query(
      `INSERT INTO shows (date, venue, city, state, country, origin_address, origin_lat, origin_lng, venue_lat, venue_lng, distance_miles, duration_minutes, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'complete') RETURNING id`,
      [
        show.date, show.venue, show.city, show.state, show.country, show.origin_address,
        originCoord ? originCoord.lat : null, originCoord ? originCoord.lng : null,
        venueCoord ? venueCoord.lat : null, venueCoord ? venueCoord.lng : null,
        distance ? distance.miles : null, distance ? distance.minutes : null,
      ]
    )).rows[0];

    for (const companionName of show.companions) {
      const companionId = await getOrCreateCompanion(companionName);
      await pool.query(
        'INSERT INTO show_companions (show_id, companion_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [showRow.id, companionId]
      );
    }

    for (const artistBlock of show.artists) {
      const artistRow = (await pool.query(
        'INSERT INTO show_artists (show_id, artist, billing_order) VALUES ($1,$2,$3) RETURNING id',
        [showRow.id, artistBlock.artist, artistBlock.billing_order]
      )).rows[0];

      for (const s of artistBlock.songs) {
        const song = await findOrCreateSong(artistBlock.artist, s.song);
        if (s.already_on_spotify && song.spotify_status === 'pending') {
          await pool.query(`UPDATE songs SET spotify_status='assumed_added' WHERE id=$1`, [song.id]);
        }
        await pool.query(
          `INSERT INTO show_songs (show_artist_id, song_id, play_order, known, liked_now, status, already_on_spotify, added_to_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [artistRow.id, song.id, s.play_order, s.known, s.liked_now, s.status, s.already_on_spotify, s.already_on_spotify]
        );
      }
    }
    console.log(`Imported: ${show.date} — ${show.venue}`);
  }

  console.log('Import complete.');
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
