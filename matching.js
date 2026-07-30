const { pool } = require('./db');
const { normalizeTitle } = require('./normalize');

// Finds this song on the master list (matched on artist + normalized title)
// or creates it using the title text as given (usually straight from
// setlist.fm). No user input required either way.
async function findOrCreateSong(artist, title) {
  const key = normalizeTitle(title);
  const existing = (await pool.query(
    'SELECT * FROM songs WHERE artist=$1 AND normalized_key=$2', [artist, key]
  )).rows[0];
  if (existing) return existing;
  const inserted = (await pool.query(
    'INSERT INTO songs (artist, title, normalized_key) VALUES ($1,$2,$3) RETURNING *',
    [artist, title, key]
  )).rows[0];
  return inserted;
}

module.exports = { findOrCreateSong };
