const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

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
      billing_order INT
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
}

module.exports = { pool, initSchema };
