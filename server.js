require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchema } = require('./db');
const setlistfm = require('./setlistfm');
const spotify = require('./spotify');
const ors = require('./ors');
const { findOrCreateSong } = require('./matching');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const pw = req.header('x-host-password');
  if (!process.env.HOST_PASSWORD) return res.status(500).json({ error: 'HOST_PASSWORD not configured on server' });
  if (pw !== process.env.HOST_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
  next();
}

app.post('/api/login', requireAuth, (req, res) => res.json({ ok: true }));

// ---------- settings ----------
app.get('/api/settings', requireAuth, async (req, res) => {
  const cfg = (await pool.query('SELECT * FROM config WHERE id=1')).rows[0];
  res.json({
    setlistfmUsername: cfg.setlistfm_username,
    spotifyConnected: !!cfg.spotify_refresh_token,
    seenPlaylistId: cfg.seen_playlist_id,
    wesPlaylistId: cfg.wes_playlist_id,
    dadPlaylistId: cfg.dad_playlist_id,
    defaultOriginAddress: cfg.default_origin_address,
    lastSyncedAt: cfg.last_synced_at,
  });
});

app.post('/api/settings', requireAuth, async (req, res) => {
  const { setlistfmUsername, seenPlaylistId, wesPlaylistId, dadPlaylistId, defaultOriginAddress } = req.body;
  await pool.query(
    `UPDATE config SET setlistfm_username=$1, seen_playlist_id=$2, wes_playlist_id=$3, dad_playlist_id=$4, default_origin_address=$5 WHERE id=1`,
    [setlistfmUsername, seenPlaylistId, wesPlaylistId, dadPlaylistId, defaultOriginAddress]
  );
  res.json({ ok: true });
});

// ---------- Spotify OAuth ----------
app.get('/api/spotify/connect', requireAuth, (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/api/spotify/callback`;
  res.json({ url: spotify.getAuthUrl(redirectUri, process.env.HOST_PASSWORD) });
});

app.get('/api/spotify/callback', async (req, res) => {
  const { code } = req.query;
  const redirectUri = `${req.protocol}://${req.get('host')}/api/spotify/callback`;
  try {
    await spotify.exchangeCodeForToken(code, redirectUri);
    res.send('<html><body>Spotify connected — you can close this tab and go back to the app.</body></html>');
  } catch (e) {
    res.status(500).send(`Spotify connection failed: ${e.message}`);
  }
});

const fs = require('fs');
app.post('/api/import/historical', requireAuth, async (req, res) => {
  try {
    const seedPath = path.join(__dirname, 'seed', 'historical_seed.json');
    const shows = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    let imported = 0, skipped = 0;
    const venueCoordCache = {};

    for (const show of shows) {
      const already = (await pool.query('SELECT id FROM shows WHERE date=$1 AND venue=$2', [show.date, show.venue])).rows[0];
      if (already) { skipped++; continue; }

      const venueKey = `${show.venue}, ${show.city}, ${show.state}`;
      if (!(venueKey in venueCoordCache)) {
        try { venueCoordCache[venueKey] = await ors.geocode(venueKey); }
        catch (e) { venueCoordCache[venueKey] = null; }
      }
      const venueCoord = venueCoordCache[venueKey];
      let originCoord = null;
      try { originCoord = await ors.geocode(show.origin_address); } catch (e) {}
      let distance = null;
      if (venueCoord && originCoord) {
        try { distance = await ors.drivingDistance(originCoord, venueCoord); } catch (e) {}
      }

      const showRow = (await pool.query(
        `INSERT INTO shows (date, venue, city, state, country, origin_address, origin_lat, origin_lng, venue_lat, venue_lng, distance_miles, duration_minutes, stage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'complete') RETURNING id`,
        [show.date, show.venue, show.city, show.state, show.country, show.origin_address,
         originCoord ? originCoord.lat : null, originCoord ? originCoord.lng : null,
         venueCoord ? venueCoord.lat : null, venueCoord ? venueCoord.lng : null,
         distance ? distance.miles : null, distance ? distance.minutes : null]
      )).rows[0];

      for (const companionName of show.companions) {
        const existing = (await pool.query('SELECT id FROM companions WHERE name=$1', [companionName])).rows[0];
        const companionId = existing ? existing.id : (await pool.query('INSERT INTO companions (name) VALUES ($1) RETURNING id', [companionName])).rows[0].id;
        await pool.query('INSERT INTO show_companions (show_id, companion_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [showRow.id, companionId]);
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
      imported++;
    }
    res.json({ ok: true, imported, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- companions ----------
app.get('/api/companions', requireAuth, async (req, res) => {
  res.json((await pool.query('SELECT * FROM companions ORDER BY name')).rows);
});

// ---------- sync ----------
app.post('/api/sync', requireAuth, async (req, res) => {
  const cfg = (await pool.query('SELECT * FROM config WHERE id=1')).rows[0];
  if (!cfg.setlistfm_username) return res.status(400).json({ error: 'Set your setlist.fm username in Settings first.' });

  const attended = await setlistfm.getAttendedShows(cfg.setlistfm_username);
  const newShowIds = [];

  for (const entry of attended) {
    const existing = (await pool.query('SELECT id FROM shows WHERE setlistfm_event_id=$1', [entry.id])).rows[0];
    if (existing) continue;

    const venue = entry.venue.name;
    const city = entry.venue.city.name;
    const state = entry.venue.city.state || null;
    const country = entry.venue.city.country.name;
    const [d, m, y] = entry.eventDate.split('-'); // setlist.fm format: dd-MM-yyyy
    const isoDate = `${y}-${m}-${d}`;

    const showRow = (await pool.query(
      `INSERT INTO shows (date, venue, city, state, country, setlistfm_event_id, origin_address, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'new') RETURNING id`,
      [isoDate, venue, city, state, country, entry.id, cfg.default_origin_address]
    )).rows[0];

    const songs = setlistfm.flattenSetlistSongs(entry);
    const artistRow = (await pool.query(
      'INSERT INTO show_artists (show_id, artist, billing_order) VALUES ($1,$2,$3) RETURNING id',
      [showRow.id, entry.artist.name, null]
    )).rows[0];

    let order = 1;
    for (const s of songs) {
      const song = await findOrCreateSong(entry.artist.name, s.name);
      await pool.query(
        'INSERT INTO show_songs (show_artist_id, song_id, play_order, is_cover) VALUES ($1,$2,$3,$4)',
        [artistRow.id, song.id, order++, s.isCover]
      );
    }

    // Geocode venue up front; origin gets (re)geocoded when the user confirms it during tagging.
    try {
      const venueCoord = await ors.geocode(`${venue}, ${city}, ${state || ''}`);
      if (venueCoord) await pool.query('UPDATE shows SET venue_lat=$1, venue_lng=$2 WHERE id=$3', [venueCoord.lat, venueCoord.lng, showRow.id]);
    } catch (e) { /* non-fatal — travel distance can be filled in later */ }

    newShowIds.push(showRow.id);
  }

  await pool.query('UPDATE config SET last_synced_at=now() WHERE id=1');
  res.json({ ok: true, newShows: newShowIds.length, showIds: newShowIds });
});

app.get('/api/shows/pending', requireAuth, async (req, res) => {
  const rows = (await pool.query(`SELECT * FROM shows WHERE stage != 'complete' ORDER BY date`)).rows;
  res.json(rows);
});

// Full show list (including completed ones) so a mistake can be corrected
// after the fact — the wizard itself is safe to re-run on a complete show.
app.get('/api/shows/all', requireAuth, async (req, res) => {
  const rows = (await pool.query(`SELECT id, date, venue, city, state, stage FROM shows ORDER BY date DESC`)).rows;
  res.json(rows);
});

app.get('/api/shows/:id', requireAuth, async (req, res) => {
  const showId = Number(req.params.id);
  const show = (await pool.query('SELECT * FROM shows WHERE id=$1', [showId])).rows[0];
  if (!show) return res.status(404).json({ error: 'Not found' });
  const artists = (await pool.query('SELECT * FROM show_artists WHERE show_id=$1 ORDER BY billing_order NULLS LAST, id', [showId])).rows;
  for (const a of artists) {
    a.songs = (await pool.query(
      `SELECT ss.*, s.title, s.artist, s.spotify_status, s.spotify_track_name, s.spotify_album_name, s.spotify_album_art_url
       FROM show_songs ss JOIN songs s ON s.id = ss.song_id
       WHERE ss.show_artist_id=$1 ORDER BY ss.play_order`, [a.id]
    )).rows;
  }
  const companions = (await pool.query(
    `SELECT c.* FROM companions c JOIN show_companions sc ON sc.companion_id=c.id WHERE sc.show_id=$1`, [showId]
  )).rows;
  res.json({ ...show, artists, companions });
});

// ---------- tagging ----------

// Lets the user drop a specific song out of the dataset entirely — mainly
// for live covers with no official Spotify release, which the sync pulls
// in from setlist.fm alongside everything else so the user can review them.
app.post('/api/show-songs/:id/remove', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM show_songs WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post('/api/shows/:id/tag', requireAuth, async (req, res) => {
  const showId = Number(req.params.id);
  const { companionIds, newCompanionNames, originAddress, songs } = req.body;

  for (const s of songs) {
    await pool.query(
      'UPDATE show_songs SET known=$1, liked_now=$2, status=$3 WHERE id=$4',
      [s.known, s.likedNow, s.status, s.showSongId]
    );
  }

  const allCompanionIds = [...(companionIds || [])];
  for (const name of (newCompanionNames || [])) {
    const existing = (await pool.query('SELECT id FROM companions WHERE name=$1', [name])).rows[0];
    const id = existing ? existing.id : (await pool.query('INSERT INTO companions (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    allCompanionIds.push(id);
  }
  await pool.query('DELETE FROM show_companions WHERE show_id=$1', [showId]);
  for (const cid of allCompanionIds) {
    await pool.query('INSERT INTO show_companions (show_id, companion_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [showId, cid]);
  }

  if (originAddress) {
    const show = (await pool.query('SELECT venue_lat, venue_lng FROM shows WHERE id=$1', [showId])).rows[0];
    let originCoord = null;
    try { originCoord = await ors.geocode(originAddress); } catch (e) { /* leave distance blank if this fails */ }
    let distance = null;
    if (originCoord && show.venue_lat && show.venue_lng) {
      try { distance = await ors.drivingDistance(originCoord, { lat: show.venue_lat, lng: show.venue_lng }); } catch (e) {}
    }
    await pool.query(
      `UPDATE shows SET origin_address=$1, origin_lat=$2, origin_lng=$3, distance_miles=$4, duration_minutes=$5 WHERE id=$6`,
      [originAddress, originCoord ? originCoord.lat : null, originCoord ? originCoord.lng : null, distance ? distance.miles : null, distance ? distance.minutes : null, showId]
    );
  }

  await pool.query(`UPDATE shows SET stage='tagged' WHERE id=$1`, [showId]);
  res.json({ ok: true });
});

// ---------- fill gaps ----------
app.post('/api/shows/:id/fill-gap/search', requireAuth, async (req, res) => {
  const { artistName } = req.body;
  const results = await setlistfm.searchSetlistsByArtist(artistName);
  res.json(results.map(r => ({
    id: r.id,
    date: r.eventDate,
    venue: r.venue.name,
    city: r.venue.city.name,
    songCount: (r.sets && r.sets.set) ? r.sets.set.reduce((n, s) => n + (s.song ? s.song.length : 0), 0) : 0,
  })));
});

app.post('/api/shows/:id/fill-gap/apply', requireAuth, async (req, res) => {
  const showId = Number(req.params.id);
  const { setlistId, showArtistId, artistName } = req.body;
  const setlist = await setlistfm.getSetlist(setlistId);
  const songs = setlistfm.flattenSetlistSongs(setlist);
  await pool.query('DELETE FROM show_songs WHERE show_artist_id=$1', [showArtistId]);
  let order = 1;
  for (const s of songs) {
    const song = await findOrCreateSong(artistName, s.name);
    await pool.query(
      'INSERT INTO show_songs (show_artist_id, song_id, play_order, is_cover) VALUES ($1,$2,$3,$4)',
      [showArtistId, song.id, order++, s.isCover]
    );
  }
  res.json({ ok: true, songCount: songs.length });
});

app.post('/api/spotify/search', requireAuth, async (req, res) => {
  const { query, artist } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const results = await spotify.searchTrack(query, artist || '');
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Spotify match review ----------
app.get('/api/shows/:id/spotify-review', requireAuth, async (req, res) => {
  const showId = Number(req.params.id);
  const rows = (await pool.query(
    `SELECT s.id, s.artist, s.title, s.spotify_status, s.spotify_track_id, s.spotify_track_name, s.spotify_album_name, s.spotify_album_art_url,
       array_agg(ss.id) AS show_song_ids
     FROM songs s JOIN show_songs ss ON ss.song_id=s.id JOIN show_artists sa ON sa.id=ss.show_artist_id
     WHERE sa.show_id=$1
     GROUP BY s.id, s.artist, s.title, s.spotify_status, s.spotify_track_id, s.spotify_track_name, s.spotify_album_name, s.spotify_album_art_url`, [showId]
  )).rows;

  const out = [];
  for (const song of rows) {
    if (song.spotify_status === 'pending') {
      let candidates = [];
      try { candidates = await spotify.searchTrack(song.title, song.artist); } catch (e) { /* leave empty, user can search manually */ }
      const best = candidates[0];
      out.push({ songId: song.id, showSongIds: song.show_song_ids, artist: song.artist, title: song.title, status: 'pending', candidates, suggested: best || null });
    } else {
      out.push({
        songId: song.id, showSongIds: song.show_song_ids, artist: song.artist, title: song.title, status: song.spotify_status,
        current: song.spotify_track_id ? { id: song.spotify_track_id, name: song.spotify_track_name, albumName: song.spotify_album_name, albumArtUrl: song.spotify_album_art_url } : null,
      });
    }
  }
  res.json(out);
});

app.post('/api/shows/:id/spotify-review', requireAuth, async (req, res) => {
  const { decisions } = req.body; // [{songId, action: 'approve'|'select'|'exclude', track?}]
  for (const d of decisions) {
    if (d.action === 'exclude') {
      await pool.query(`UPDATE songs SET spotify_status='excluded' WHERE id=$1`, [d.songId]);
    } else if (d.action === 'approve' || d.action === 'select') {
      const t = d.track;
      await pool.query(
        `UPDATE songs SET spotify_status='matched', spotify_track_id=$1, spotify_track_name=$2, spotify_album_name=$3, spotify_album_art_url=$4 WHERE id=$5`,
        [t.id, t.name, t.albumName, t.albumArtUrl, d.songId]
      );
    }
  }
  await pool.query(`UPDATE shows SET stage='spotify_reviewed' WHERE id=$1`, [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- playlist submit ----------
async function playlistTargets(showId) {
  const cfg = (await pool.query('SELECT * FROM config WHERE id=1')).rows[0];
  const companions = (await pool.query(
    `SELECT c.name FROM companions c JOIN show_companions sc ON sc.companion_id=c.id WHERE sc.show_id=$1`, [showId]
  )).rows.map(r => r.name);
  const targets = [{ key: 'seen', label: 'Seen In Concert', playlistId: cfg.seen_playlist_id }];
  if (companions.includes('Wes')) targets.push({ key: 'wes', label: 'Wes Concerts', playlistId: cfg.wes_playlist_id });
  if (companions.includes('Jeff')) targets.push({ key: 'dad', label: 'Concerts with Dad', playlistId: cfg.dad_playlist_id });
  return targets;
}

app.get('/api/shows/:id/playlist-preview', requireAuth, async (req, res) => {
  const showId = Number(req.params.id);
  const targets = await playlistTargets(showId);
  const songs = (await pool.query(
    `SELECT ss.id AS show_song_id, s.id AS song_id, s.title, s.artist, s.spotify_track_name, s.spotify_album_name, s.spotify_album_art_url, s.spotify_status, ss.added_to_seen, ss.added_to_wes, ss.added_to_dad
     FROM show_songs ss JOIN songs s ON s.id=ss.song_id JOIN show_artists sa ON sa.id=ss.show_artist_id
     WHERE sa.show_id=$1 AND s.spotify_status IN ('matched','assumed_added')`, [showId]
  )).rows;
  res.json({ targets, songs });
});

app.post('/api/shows/:id/playlist-submit', requireAuth, async (req, res) => {
  const showId = Number(req.params.id);
  const { drops, swaps } = req.body; // drops: [showSongId], swaps: {showSongId: track}
  for (const [showSongId, track] of Object.entries(swaps || {})) {
    const row = (await pool.query('SELECT song_id FROM show_songs WHERE id=$1', [showSongId])).rows[0];
    await pool.query(
      `UPDATE songs SET spotify_track_id=$1, spotify_track_name=$2, spotify_album_name=$3, spotify_album_art_url=$4 WHERE id=$5`,
      [track.id, track.name, track.albumName, track.albumArtUrl, row.song_id]
    );
  }

  const targets = await playlistTargets(showId);
  const songs = (await pool.query(
    `SELECT ss.id AS show_song_id, s.spotify_track_id, ss.added_to_seen, ss.added_to_wes, ss.added_to_dad
     FROM show_songs ss JOIN songs s ON s.id=ss.song_id JOIN show_artists sa ON sa.id=ss.show_artist_id
     WHERE sa.show_id=$1 AND s.spotify_status IN ('matched','assumed_added') AND s.spotify_track_id IS NOT NULL`, [showId]
  )).rows;
  const dropSet = new Set((drops || []).map(String));
  const keep = songs.filter(s => !dropSet.has(String(s.show_song_id)));

  for (const target of targets) {
    const flagCol = `added_to_${target.key}`;
    const uris = keep.filter(s => !s[flagCol]).map(s => `spotify:track:${s.spotify_track_id}`);
    await spotify.addTracksToPlaylist(target.playlistId, uris);
    for (const s of keep) {
      await pool.query(`UPDATE show_songs SET ${flagCol}=true WHERE id=$1`, [s.show_song_id]);
    }
  }

  await pool.query(`UPDATE shows SET stage='complete' WHERE id=$1`, [showId]);
  res.json({ ok: true, added: keep.length });
});

// A show needs a playlist push (without redoing tagging/review) whenever it
// has a song that's matched on Spotify but hasn't made it into every
// playlist that show belongs in — most commonly because the song was
// re-matched after the fact (see /api/spotify/recheck-excluded below).
app.get('/api/shows/needs-playlist-update', requireAuth, async (req, res) => {
  const candidates = (await pool.query(`
    SELECT DISTINCT sh.id, sh.date, sh.venue
    FROM shows sh
    JOIN show_artists sa ON sa.show_id = sh.id
    JOIN show_songs ss ON ss.show_artist_id = sa.id
    JOIN songs s ON s.id = ss.song_id
    WHERE s.spotify_status IN ('matched','assumed_added')
      AND (NOT ss.added_to_seen OR NOT ss.added_to_wes OR NOT ss.added_to_dad)
    ORDER BY sh.date DESC
  `)).rows;

  const needing = [];
  for (const c of candidates) {
    const targets = await playlistTargets(c.id);
    const songs = (await pool.query(
      `SELECT ss.added_to_seen, ss.added_to_wes, ss.added_to_dad
       FROM show_songs ss JOIN show_artists sa ON sa.id=ss.show_artist_id JOIN songs s ON s.id=ss.song_id
       WHERE sa.show_id=$1 AND s.spotify_status IN ('matched','assumed_added')`, [c.id]
    )).rows;
    const pending = songs.some(s => targets.some(t => !s[`added_to_${t.key}`]));
    if (pending) needing.push({ id: c.id, date: c.date, venue: c.venue });
  }
  res.json(needing);
});

// Re-searches Spotify for every song currently marked "excluded" — for when
// a band releases an official studio/live version of something after you
// saw it, and it wasn't findable at review time. Only returns songs that
// now have at least one candidate, so this stays quiet otherwise.
app.get('/api/spotify/recheck-excluded', requireAuth, async (req, res) => {
  const excluded = (await pool.query(`SELECT id, artist, title FROM songs WHERE spotify_status='excluded'`)).rows;
  const out = [];
  for (const song of excluded) {
    let candidates = [];
    try { candidates = await spotify.searchTrack(song.title, song.artist); } catch (e) { /* skip on search failure */ }
    if (candidates.length) out.push({ songId: song.id, artist: song.artist, title: song.title, candidates: candidates.slice(0, 3) });
  }
  res.json(out);
});

app.post('/api/spotify/recheck-excluded/apply', requireAuth, async (req, res) => {
  const { songId, track } = req.body;
  await pool.query(
    `UPDATE songs SET spotify_status='matched', spotify_track_id=$1, spotify_track_name=$2, spotify_album_name=$3, spotify_album_art_url=$4 WHERE id=$5`,
    [track.id, track.name, track.albumName, track.albumArtUrl, songId]
  );
  res.json({ ok: true });
});

// ---------- reports ----------

// A song counts as a genuine "regret" only if you have NEVER known it at any
// show you've seen it at. If you later saw the same song again and knew it
// that time, none of its occurrences count as a regret anymore.
const REGRET_SQL = `(NOT ss.known AND ss.liked_now AND NOT EXISTS (
  SELECT 1 FROM show_songs ss2 WHERE ss2.song_id = ss.song_id AND ss2.known = true
))`;

// Attendee filter: ?companions=1,2,3 on any report endpoint. Absent or
// "all" means no filtering (every show included).
function companionIdsParam(req) {
  const raw = req.query.companions;
  if (!raw || raw === 'all') return null;
  const ids = String(raw).split(',').map(Number).filter(Number.isFinite);
  return ids.length ? ids : null;
}

// Best-effort city extraction from a free-text "Street, City, ST ZIP"
// (or "City, ST ZIP") address string, for the "traveled from" column.
function extractCity(address) {
  if (!address) return null;
  const parts = String(address).split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || null;
}

function orderLabel(order, max) {
  if (order == null) return 'Headliner';
  if (max == null || order === 1) return `${order} — Headliner`;
  if (order === max) return `${order} — Opener`;
  return `${order} — Support`;
}

// Shared show→artist→song tree builder used by both Overview and Journey.
// Pass cIds (attendee filter, or null for all) and/or an explicit showIds
// list (used by Journey to pull specific shows regardless of the filter).
async function getShowsNested({ cIds = null, showIds = null } = {}) {
  const params = [cIds, showIds];
  const where = `
    ($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))
    AND ($2::int[] IS NULL OR sh.id = ANY($2::int[]))
  `;

  const showRows = (await pool.query(
    `SELECT sh.id, sh.date, sh.venue, sh.city, sh.state, sh.origin_address FROM shows sh WHERE ${where} ORDER BY sh.date`,
    params
  )).rows;

  const artistRows = (await pool.query(`
    SELECT sa.id AS show_artist_id, sa.show_id, sa.artist, sa.billing_order,
      count(ss.id) AS song_count,
      round(100.0 * sum(CASE WHEN ss.known THEN 1 ELSE 0 END) / NULLIF(count(*),0), 0) AS pct_known,
      (array_agg(s.title ORDER BY ss.play_order ASC))[1] AS opener,
      (array_agg(s.title ORDER BY ss.play_order DESC))[1] AS closer,
      (SELECT max(billing_order) FROM show_artists sa2 WHERE sa2.show_id = sa.show_id) AS max_billing
    FROM show_artists sa
    JOIN shows sh ON sh.id = sa.show_id
    JOIN show_songs ss ON ss.show_artist_id = sa.id
    JOIN songs s ON s.id = ss.song_id
    WHERE ${where}
    GROUP BY sa.id
  `, params)).rows;

  const songRows = (await pool.query(`
    SELECT sa.id AS show_artist_id, s.title, ss.known, (ss.status='missed') AS missed,
      ${REGRET_SQL} AS regret, ss.play_order
    FROM show_songs ss
    JOIN show_artists sa ON sa.id = ss.show_artist_id
    JOIN shows sh ON sh.id = sa.show_id
    JOIN songs s ON s.id = ss.song_id
    WHERE ${where}
    ORDER BY ss.play_order
  `, params)).rows;

  const songsByArtist = {};
  for (const r of songRows) (songsByArtist[r.show_artist_id] = songsByArtist[r.show_artist_id] || []).push(r);

  const artistsByShow = {};
  for (const a of artistRows) {
    (artistsByShow[a.show_id] = artistsByShow[a.show_id] || []).push({
      showArtistId: a.show_artist_id,
      artist: a.artist,
      billingOrder: a.billing_order,
      orderLabel: orderLabel(a.billing_order, a.max_billing),
      songCount: Number(a.song_count),
      pctKnown: a.pct_known == null ? 0 : Number(a.pct_known),
      opener: a.opener,
      closer: a.closer,
      songs: (songsByArtist[a.show_artist_id] || []).map(s => ({ title: s.title, known: s.known, missed: s.missed, regret: s.regret })),
    });
  }

  return showRows.map(sh => {
    const artists = (artistsByShow[sh.id] || []).slice().sort((x, y) => (x.billingOrder ?? 1) - (y.billingOrder ?? 1));
    const headliner = artists.find(a => a.billingOrder === 1 || a.billingOrder == null) || artists[0];
    return {
      id: sh.id,
      date: sh.date,
      venue: sh.venue,
      city: sh.city,
      state: sh.state,
      headliner: headliner ? headliner.artist : '—',
      location: [sh.city, sh.state].filter(Boolean).join(', '),
      traveledFrom: extractCity(sh.origin_address),
      artists,
    };
  });
}

app.get('/api/report/overview', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);

  const totals = (await pool.query(`
    SELECT count(DISTINCT sh.id) AS shows, count(DISTINCT sa.artist) AS unique_artists, count(DISTINCT ss.song_id) AS unique_songs,
      round(100.0 * sum(CASE WHEN ss.known THEN 1 ELSE 0 END) / NULLIF(count(*),0), 1) AS pct_known
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id
    WHERE ($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))
  `, [cIds])).rows[0];

  const shows = await getShowsNested({ cIds });
  res.json({ totals, shows });
});

app.get('/api/report/trends', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);

  async function bucketedCounts(bucketExpr) {
    return (await pool.query(`
      SELECT ${bucketExpr} AS bucket, count(DISTINCT sh.id) AS shows,
        count(DISTINCT sa.artist) AS artists, count(DISTINCT ss.song_id) AS songs, count(DISTINCT sh.venue) AS venues
      FROM shows sh
      JOIN show_artists sa ON sa.show_id = sh.id
      JOIN show_songs ss ON ss.show_artist_id = sa.id
      WHERE ($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))
      GROUP BY 1 ORDER BY 1
    `, [cIds])).rows;
  }

  const byYear = await bucketedCounts('extract(year FROM sh.date)::int');
  const byMonth = await bucketedCounts('extract(month FROM sh.date)::int');
  const bySeasonRaw = await bucketedCounts(`CASE
    WHEN extract(month FROM sh.date) IN (3,4,5) THEN 'Spring'
    WHEN extract(month FROM sh.date) IN (6,7,8) THEN 'Summer'
    WHEN extract(month FROM sh.date) IN (9,10,11) THEN 'Fall'
    ELSE 'Winter' END`);
  const byWeekday = await bucketedCounts('extract(dow FROM sh.date)::int');

  const seasonOrder = ['Spring', 'Summer', 'Fall', 'Winter'];
  const bySeason = seasonOrder.map(s => bySeasonRaw.find(r => r.bucket === s)).filter(Boolean);

  res.json({ byYear, byMonth, bySeason, byWeekday });
});

app.get('/api/report/travel', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);
  const filterClause = `($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))`;

  const totals = (await pool.query(
    `SELECT sum(distance_miles) AS miles, sum(duration_minutes)/60.0 AS hours FROM shows sh WHERE ${filterClause}`,
    [cIds]
  )).rows[0];

  const local = (await pool.query(`
    SELECT venue, count(*) AS show_count
    FROM shows sh
    WHERE (state ILIKE 'Georgia' OR state ILIKE 'GA') AND ${filterClause}
    GROUP BY venue ORDER BY show_count DESC, venue ASC
  `, [cIds])).rows;

  const travel = (await pool.query(`
    SELECT sh.id, sh.venue, sh.city, sh.state, sh.distance_miles, sh.duration_minutes,
      (SELECT string_agg(sa.artist, ', ' ORDER BY COALESCE(sa.billing_order, 1)) FROM show_artists sa WHERE sa.show_id = sh.id) AS bands
    FROM shows sh
    WHERE NOT (state ILIKE 'Georgia' OR state ILIKE 'GA') AND ${filterClause}
    ORDER BY sh.distance_miles DESC NULLS LAST
  `, [cIds])).rows;

  res.json({ totals, local, travel });
});

app.get('/api/report/superlatives', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);
  const filterClause = `($1::int[] IS NULL OR sa.show_id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))`;

  const perShow = (await pool.query(`
    SELECT sa.artist, sa.show_id,
      (array_agg(s.title ORDER BY ss.play_order ASC))[1] AS opener,
      (array_agg(s.title ORDER BY ss.play_order DESC))[1] AS closer,
      (sa.billing_order = 1 OR sa.billing_order IS NULL) AS is_headliner_appearance
    FROM show_artists sa
    JOIN show_songs ss ON ss.show_artist_id = sa.id
    JOIN songs s ON s.id = ss.song_id
    WHERE ${filterClause}
    GROUP BY sa.artist, sa.show_id, sa.billing_order
  `, [cIds])).rows;

  const songCounts = (await pool.query(`
    SELECT sa.artist, count(DISTINCT ss.song_id) AS unique_songs, count(*) AS total_slots
    FROM show_artists sa JOIN show_songs ss ON ss.show_artist_id = sa.id
    WHERE ${filterClause}
    GROUP BY sa.artist
  `, [cIds])).rows;
  const songCountByArtist = Object.fromEntries(songCounts.map(r => [r.artist, r]));

  const byArtist = {};
  for (const r of perShow) {
    const a = byArtist[r.artist] = byArtist[r.artist] || { artist: r.artist, timesSeen: 0, headlineCount: 0, openers: new Set(), closers: new Set() };
    a.timesSeen++;
    if (r.is_headliner_appearance) a.headlineCount++;
    a.openers.add(r.opener);
    a.closers.add(r.closer);
  }

  const bandsSeenMost = Object.values(byArtist).map(a => {
    const sc = songCountByArtist[a.artist] || { unique_songs: 0, total_slots: 0 };
    const openCloseVariationPct = Math.round(100 * ((a.openers.size + a.closers.size) / (2 * a.timesSeen)) * 10) / 10;
    return {
      artist: a.artist,
      timesSeen: a.timesSeen,
      songCount: Number(sc.unique_songs),
      pctHeadline: Math.round(100 * a.headlineCount / a.timesSeen * 10) / 10,
      setlistVariationPct: sc.total_slots ? Math.round(100 * sc.unique_songs / sc.total_slots * 10) / 10 : 0,
      openCloseVariationPct,
    };
  }).sort((a, b) => b.timesSeen - a.timesSeen).slice(0, 10);

  const repeatArtists = Object.values(byArtist).filter(a => a.timesSeen > 1);
  const mostUniqueSongsRepeat = repeatArtists.map(a => {
    const sc = songCountByArtist[a.artist] || { unique_songs: 0 };
    return { artist: a.artist, timesSeen: a.timesSeen, uniqueSongs: Number(sc.unique_songs) };
  }).sort((a, b) => b.uniqueSongs - a.uniqueSongs).slice(0, 5);

  const mostOpenCloseVariation = repeatArtists.map(a => ({
    artist: a.artist,
    timesSeen: a.timesSeen,
    openCloseVariationPct: Math.round(100 * ((a.openers.size + a.closers.size) / (2 * a.timesSeen)) * 10) / 10,
  })).sort((a, b) => b.openCloseVariationPct - a.openCloseVariationPct).slice(0, 5);

  res.json({ bandsSeenMost, mostUniqueSongsRepeat, mostOpenCloseVariation });
});

app.get('/api/report/journey', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);
  const filterClause = `($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))`;

  const firstIds = (await pool.query(
    `SELECT id FROM shows sh WHERE ${filterClause} ORDER BY date ASC, id ASC LIMIT 3`, [cIds]
  )).rows.map(r => r.id);
  const lastIds = (await pool.query(
    `SELECT id FROM shows sh WHERE ${filterClause} ORDER BY date DESC, id DESC LIMIT 3`, [cIds]
  )).rows.map(r => r.id).reverse();

  const allShows = await getShowsNested({ cIds, showIds: [...firstIds, ...lastIds] });
  const byId = Object.fromEntries(allShows.map(s => [s.id, s]));

  res.json({
    first: firstIds.map(id => byId[id]).filter(Boolean),
    latest: lastIds.map(id => byId[id]).filter(Boolean),
  });
});

app.get('/api/report/unknowns', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);
  const filterClause = `($1::int[] IS NULL OR sa.show_id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))`;

  const totals = (await pool.query(`
    SELECT round(100.0*sum(CASE WHEN ss.known THEN 1 ELSE 0 END)/NULLIF(count(*),0),1) AS pct_known,
      round(100.0*sum(CASE WHEN ss.status='missed' THEN 1 ELSE 0 END)/NULLIF(count(*),0),1) AS pct_missed,
      round(100.0*sum(CASE WHEN ss.status='skipped' THEN 1 ELSE 0 END)/NULLIF(count(*),0),1) AS pct_skipped,
      sum(CASE WHEN ${REGRET_SQL} THEN 1 ELSE 0 END) AS regret_count
    FROM show_songs ss JOIN show_artists sa ON sa.id = ss.show_artist_id
    WHERE ${filterClause}
  `, [cIds])).rows[0];

  const songs = (await pool.query(`
    SELECT s.artist, s.title, bool_or(${REGRET_SQL}) AS regret
    FROM show_songs ss JOIN show_artists sa ON sa.id = ss.show_artist_id JOIN songs s ON s.id=ss.song_id
    WHERE NOT ss.known AND ${filterClause}
    GROUP BY s.id, s.artist, s.title
    ORDER BY regret DESC, s.artist ASC, s.title ASC
    LIMIT 500
  `, [cIds])).rows;

  res.json({ totals, songs });
});

// Songs you've seen live that never made it into a Spotify playlist:
// - legacy (pre-app) shows, using the "already on Spotify" flag from the
//   historical import directly
// - shows synced through the app, where no valid Spotify match was ever
//   found/approved during review, so it was marked excluded. (Covers with
//   no official release get dropped at tagging time via the Remove button,
//   so anything that reaches here already passed the user's own judgment
//   call on whether it belongs in the dataset.)
app.get('/api/report/spotify-gaps', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);
  const rows = (await pool.query(`
    SELECT artist, title FROM (
      SELECT s.artist, s.title
      FROM show_songs ss
      JOIN show_artists sa ON sa.id = ss.show_artist_id
      JOIN shows sh ON sh.id = sa.show_id
      JOIN songs s ON s.id = ss.song_id
      WHERE sh.setlistfm_event_id IS NULL
        AND ss.already_on_spotify = false
        AND ($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))
      UNION
      SELECT s.artist, s.title
      FROM show_songs ss
      JOIN show_artists sa ON sa.id = ss.show_artist_id
      JOIN shows sh ON sh.id = sa.show_id
      JOIN songs s ON s.id = ss.song_id
      WHERE sh.setlistfm_event_id IS NOT NULL
        AND s.spotify_status = 'excluded'
        AND ($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))
    ) gaps
    ORDER BY artist ASC, title ASC
  `, [cIds])).rows;
  res.json({ songs: rows });
});

// One-off maintenance: retries geocoding/driving-distance for any show
// still missing miles/minutes (usually a transient ORS failure during
// import), so travel rollups aren't silently short.
app.post('/api/admin/backfill-travel', requireAuth, async (req, res) => {
  const missing = (await pool.query(
    `SELECT id, origin_address, venue, city, state, venue_lat, venue_lng FROM shows WHERE (distance_miles IS NULL OR duration_minutes IS NULL) AND origin_address IS NOT NULL`
  )).rows;
  let fixed = 0, stillMissing = 0;
  for (const sh of missing) {
    try {
      let venueCoord = (sh.venue_lat && sh.venue_lng) ? { lat: sh.venue_lat, lng: sh.venue_lng } : null;
      if (!venueCoord) {
        venueCoord = await ors.geocode(`${sh.venue}, ${sh.city}, ${sh.state || ''}`);
        if (venueCoord) await pool.query('UPDATE shows SET venue_lat=$1, venue_lng=$2 WHERE id=$3', [venueCoord.lat, venueCoord.lng, sh.id]);
      }
      const originCoord = await ors.geocode(sh.origin_address);
      if (venueCoord && originCoord) {
        const distance = await ors.drivingDistance(originCoord, venueCoord);
        await pool.query(
          'UPDATE shows SET origin_lat=$1, origin_lng=$2, distance_miles=$3, duration_minutes=$4 WHERE id=$5',
          [originCoord.lat, originCoord.lng, distance.miles, distance.minutes, sh.id]
        );
        fixed++;
      } else stillMissing++;
    } catch (e) { stillMissing++; }
  }
  res.json({ ok: true, fixed, stillMissing, checked: missing.length });
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`Concert tracker running on port ${PORT}`)))
  .catch(err => { console.error('Failed to init schema', err); process.exit(1); });
