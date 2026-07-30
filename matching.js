const { pool, artistKey } = require('./db');
const { normalizeTitle } = require('./normalize');

// Finds this song on the master list (matched on normalized artist + normalized
// title) or creates it using the title/artist text as given (usually straight
// from setlist.fm). No user input required either way.
async function findOrCreateSong(artist, title) {
  const key = normalizeTitle(title);
  const aKey = artistKey(artist);
  const existing = (await pool.query(
    'SELECT * FROM songs WHERE artist_key=$1 AND normalized_key=$2', [aKey, key]
  )).rows[0];
  if (existing) return existing;
  const inserted = (await pool.query(
    'INSERT INTO songs (artist, title, normalized_key, artist_key) VALUES ($1,$2,$3,$4) RETURNING *',
    [artist, title, key, aKey]
  )).rows[0];
  return inserted;
}

module.exports = { findOrCreateSong };
