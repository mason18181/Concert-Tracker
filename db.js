const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// Same normalization matching.js uses for artist names, kept here too so the
// migration below can run standalone without circular-requiring matching.js.
function artistKey(artist) {
  return String(artist).trim().toLowerCase().replace(/\s+/g, ' ');
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      id INT PRIMARY KEY DEFAULT 1,
      setlistfm_username TEXT,
      spotify_access_token TEXT,
      spotify_refresh_token TEXT,
      spotify_token_expires_at TIMESTAMPTZ,
      seen_playlist_id TEXT,
      wes_playlist_id TEXT,
      dad_playlist_id TEXT,
      default_origin_address TEXT,
      last_synced_at TIMESTAMPTZ
    );
    INSERT INTO config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS companions (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS songs (
      id SERIAL PRIMARY KEY,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      normalized_key TEXT NOT NULL,
      spotify_track_id TEXT,
      spotify_track_name TEXT,
      spotify_album_name TEXT,
      spotify_album_art_url TEXT,
      spotify_status TEXT NOT NULL DEFAULT 'pending', -- pending | matched | excluded
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (artist, normalized_key)
    );

    CREATE TABLE IF NOT EXISTS shows (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL,
      venue TEXT NOT NULL,
      city TEXT,
      state TEXT,
      country TEXT,
      setlistfm_event_id TEXT,
      origin_address TEXT,
      origin_lat NUMERIC,
      origin_lng NUMERIC,
      venue_lat NUMERIC,
      venue_lng NUMERIC,
      distance_miles NUMERIC,
      duration_minutes NUMERIC,
      stage TEXT NOT NULL DEFAULT 'new', -- new | tagged | spotify_reviewed | complete
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (date, venue)
    );

    CREATE TABLE IF NOT EXISTS show_artists (
      id SERIAL PRIMARY KEY,
      show_id INT REFERENCES shows(id) ON DELETE CASCADE,
      artist TEXT NOT NULL,
      billing_order INT,
      original_setlist JSONB,
      setlist_source TEXT DEFAULT 'setlist.fm'
    );

    CREATE TABLE IF NOT EXISTS show_songs (
      id SERIAL PRIMARY KEY,
      show_artist_id INT REFERENCES show_artists(id) ON DELETE CASCADE,
      song_id INT REFERENCES songs(id),
      play_order INT,
      known BOOLEAN,
      liked_now BOOLEAN,
      status TEXT, -- seen | missed | skipped
      is_cover BOOLEAN DEFAULT false,
      already_on_spotify BOOLEAN DEFAULT false,
      added_to_seen BOOLEAN DEFAULT false,
      added_to_wes BOOLEAN DEFAULT false,
      added_to_dad BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS show_companions (
      show_id INT REFERENCES shows(id) ON DELETE CASCADE,
      companion_id INT REFERENCES companions(id),
      PRIMARY KEY (show_id, companion_id)
    );
  `);

  await pool.query(`
    ALTER TABLE show_artists ADD COLUMN IF NOT EXISTS original_setlist JSONB;
    ALTER TABLE show_artists ADD COLUMN IF NOT EXISTS setlist_source TEXT DEFAULT 'setlist.fm';
    ALTER TABLE show_artists ADD COLUMN IF NOT EXISTS tour_name TEXT;
    ALTER TABLE show_artists ADD COLUMN IF NOT EXISTS setlistfm_checked BOOLEAN DEFAULT false;
    ALTER TABLE show_artists ADD COLUMN IF NOT EXISTS setlistfm_url TEXT;
    ALTER TABLE show_artists ADD COLUMN IF NOT EXISTS setlistfm_id TEXT;
  `);

  await dedupeSongs();
}

// ---------------------------------------------------------------------
// One-time-ish migration: the original UNIQUE(artist, normalized_key)
// constraint matched on the *raw* artist string, so the same artist typed
// with different casing/whitespace across two shows (e.g. "Jimmy Eat World"
// vs "Jimmy eat world ") created two separate "songs" rows for the same
// actual song — inflating the unique-song count. This adds a normalized
// artist_key column, merges any rows that collide once artist casing/
// whitespace is ignored, and repoints the constraint to that key so it
// can't happen again. Safe to run every boot — it's a no-op once clean.
// ---------------------------------------------------------------------
async function dedupeSongs() {
  await pool.query(`ALTER TABLE songs ADD COLUMN IF NOT EXISTS artist_key TEXT;`);
  await pool.query(`
    UPDATE songs SET artist_key = lower(regexp_replace(trim(artist), '\\s+', ' ', 'g'))
    WHERE artist_key IS DISTINCT FROM lower(regexp_replace(trim(artist), '\\s+', ' ', 'g'))
  `);

  const dupGroups = (await pool.query(`
    SELECT artist_key, normalized_key, array_agg(id ORDER BY id) AS ids
    FROM songs
    GROUP BY artist_key, normalized_key
    HAVING count(*) > 1
  `)).rows;

  for (const g of dupGroups) {
    const [keepId, ...dupIds] = g.ids;
    await pool.query(`UPDATE show_songs SET song_id=$1 WHERE song_id = ANY($2::int[])`, [keepId, dupIds]);
    await pool.query(`DELETE FROM songs WHERE id = ANY($1::int[])`, [dupIds]);
  }

  // Repoint the uniqueness guarantee to the normalized key so this class of
  // duplicate can't reappear, regardless of what the original constraint
  // happened to be named.
  await pool.query(`
    DO $$
    DECLARE
      c RECORD;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'songs'::regclass AND contype = 'u'
      LOOP
        EXECUTE format('ALTER TABLE songs DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$;
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS songs_artist_key_normalized_key_idx ON songs(artist_key, normalized_key);`);
}

module.exports = { pool, initSchema, artistKey };
