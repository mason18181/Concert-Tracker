require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, initSchema } = require('./db');
const setlistfm = require('./setlistfm');
const spotify = require('./spotify');
const ors = require('./ors');
const { findOrCreateSong } = require('./matching');

const app = express();
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
    `SELECT DISTINCT s.id, s.artist, s.title, s.spotify_status, s.spotify_track_id, s.spotify_track_name, s.spotify_album_name, s.spotify_album_art_url
     FROM songs s JOIN show_songs ss ON ss.song_id=s.id JOIN show_artists sa ON sa.id=ss.show_artist_id
     WHERE sa.show_id=$1`, [showId]
  )).rows;

  const out = [];
  for (const song of rows) {
    if (song.spotify_status === 'pending') {
      let candidates = [];
      try { candidates = await spotify.searchTrack(song.title, song.artist); } catch (e) { /* leave empty, user can search manually */ }
      const best = candidates[0];
      out.push({ songId: song.id, artist: song.artist, title: song.title, status: 'pending', candidates, suggested: best || null });
    } else {
      out.push({
        songId: song.id, artist: song.artist, title: song.title, status: song.spotify_status,
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

// ---------- reports ----------
app.get('/api/report/overview', requireAuth, async (req, res) => {
  const totals = (await pool.query(`
    SELECT count(DISTINCT sh.id) AS shows, count(DISTINCT sa.artist) AS artists, count(DISTINCT ss.song_id) AS songs,
      round(100.0 * sum(CASE WHEN ss.known THEN 1 ELSE 0 END) / NULLIF(count(*),0), 1) AS pct_known,
      round(100.0 * sum(CASE WHEN ss.status='missed' THEN 1 ELSE 0 END) / NULLIF(count(*),0), 1) AS pct_missed,
      round(100.0 * sum(CASE WHEN NOT ss.known AND ss.liked_now THEN 1 ELSE 0 END) / NULLIF(count(*),0), 1) AS pct_regret
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id
  `)).rows[0];

  const showLog = (await pool.query(`
    SELECT sh.id, sh.date, sa.artist, sa.billing_order, count(ss.id) AS song_count,
      round(100.0 * sum(CASE WHEN ss.known THEN 1 ELSE 0 END) / NULLIF(count(*),0),0) AS pct_known,
      (array_agg(s.title ORDER BY ss.play_order ASC))[1] AS opener,
      (array_agg(s.title ORDER BY ss.play_order DESC))[1] AS closer
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id JOIN songs s ON s.id=ss.song_id
    GROUP BY sh.id, sh.date, sa.artist, sa.billing_order, sa.id
    ORDER BY sh.date DESC
  `)).rows;

  res.json({ totals, showLog });
});

app.get('/api/report/yearly', requireAuth, async (req, res) => {
  const rows = (await pool.query(`
    SELECT extract(year FROM date)::int AS year, count(*) AS shows
    FROM shows GROUP BY 1 ORDER BY 1
  `)).rows;
  res.json(rows);
});

app.get('/api/report/trends', requireAuth, async (req, res) => {
  const bySeason = (await pool.query(`
    SELECT CASE
      WHEN extract(month FROM date) IN (3,4,5) THEN 'Spring'
      WHEN extract(month FROM date) IN (6,7,8) THEN 'Summer'
      WHEN extract(month FROM date) IN (9,10,11) THEN 'Fall'
      ELSE 'Winter' END AS season, count(*) AS shows
    FROM shows GROUP BY 1
  `)).rows;
  const byMonth = (await pool.query(`SELECT extract(month FROM date)::int AS month, count(*) AS shows FROM shows GROUP BY 1 ORDER BY 1`)).rows;
  const byWeekday = (await pool.query(`SELECT extract(dow FROM date)::int AS weekday, count(*) AS shows FROM shows GROUP BY 1 ORDER BY 1`)).rows;
  res.json({ bySeason, byMonth, byWeekday });
});

app.get('/api/report/travel', requireAuth, async (req, res) => {
  const totals = (await pool.query(`SELECT sum(distance_miles) AS miles, sum(duration_minutes)/60.0 AS hours FROM shows`)).rows[0];
  const shows = (await pool.query(`SELECT date, venue, city, state, distance_miles, duration_minutes FROM shows ORDER BY distance_miles DESC NULLS LAST`)).rows;
  res.json({ totals, shows });
});

app.get('/api/report/superlatives', requireAuth, async (req, res) => {
  const mostSongsAtShow = (await pool.query(`
    SELECT sh.date, sa.artist, count(*) AS song_count
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id
    GROUP BY sh.date, sa.artist ORDER BY song_count DESC LIMIT 5
  `)).rows;
  const mostRegretByArtist = (await pool.query(`
    SELECT sa.artist, count(*) AS regret_count
    FROM show_artists sa JOIN show_songs ss ON ss.show_artist_id=sa.id
    WHERE NOT ss.known AND ss.liked_now
    GROUP BY sa.artist ORDER BY regret_count DESC LIMIT 5
  `)).rows;
  const mostMissedInSet = (await pool.query(`
    SELECT sa.artist, sh.date, count(*) AS missed_count
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id
    WHERE ss.status='missed' GROUP BY sa.artist, sh.date ORDER BY missed_count DESC LIMIT 5
  `)).rows;
  res.json({ mostSongsAtShow, mostRegretByArtist, mostMissedInSet });
});

app.get('/api/report/song-status', requireAuth, async (req, res) => {
  const totals = (await pool.query(`
    SELECT round(100.0*sum(CASE WHEN known THEN 1 ELSE 0 END)/NULLIF(count(*),0),1) AS pct_known,
      round(100.0*sum(CASE WHEN status='missed' THEN 1 ELSE 0 END)/NULLIF(count(*),0),1) AS pct_missed,
      round(100.0*sum(CASE WHEN status='skipped' THEN 1 ELSE 0 END)/NULLIF(count(*),0),1) AS pct_skipped,
      sum(CASE WHEN NOT known AND liked_now THEN 1 ELSE 0 END) AS regret_count
    FROM show_songs
  `)).rows[0];
  const notKnown = (await pool.query(`
    SELECT DISTINCT s.title, s.artist FROM show_songs ss JOIN songs s ON s.id=ss.song_id WHERE NOT ss.known LIMIT 50
  `)).rows;
  const regret = (await pool.query(`
    SELECT DISTINCT s.title, s.artist FROM show_songs ss JOIN songs s ON s.id=ss.song_id WHERE NOT ss.known AND ss.liked_now LIMIT 50
  `)).rows;
  res.json({ totals, notKnown, regret });
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`Concert tracker running on port ${PORT}`)))
  .catch(err => { console.error('Failed to init schema', err); process.exit(1); });
