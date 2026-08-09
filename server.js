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
        const originalTitles = [...artistBlock.songs].sort((a, b) => a.play_order - b.play_order).map(s => s.song);
        const artistRow = (await pool.query(
          'INSERT INTO show_artists (show_id, artist, billing_order, original_setlist, setlist_source) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [showRow.id, artistBlock.artist, artistBlock.billing_order, JSON.stringify(originalTitles), 'spreadsheet import']
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
      'INSERT INTO show_artists (show_id, artist, billing_order, original_setlist, setlist_source) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [showRow.id, entry.artist.name, null, JSON.stringify(songs.map(s => s.name)), 'setlist.fm']
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
  const rows = (await pool.query(`
    SELECT sh.*, (SELECT sa.artist FROM show_artists sa WHERE sa.show_id=sh.id ORDER BY sa.billing_order NULLS LAST, sa.id LIMIT 1) AS headliner
    FROM shows sh WHERE sh.stage != 'complete' ORDER BY sh.date
  `)).rows;
  res.json(rows);
});

// Full show list (including completed ones) so a mistake can be corrected
// after the fact — the wizard itself is safe to re-run on a complete show.
app.get('/api/shows/all', requireAuth, async (req, res) => {
  const rows = (await pool.query(`
    SELECT sh.id, sh.date, sh.venue, sh.city, sh.state, sh.stage,
      (SELECT sa.artist FROM show_artists sa WHERE sa.show_id=sh.id ORDER BY sa.billing_order NULLS LAST, sa.id LIMIT 1) AS headliner
    FROM shows sh ORDER BY sh.date DESC
  `)).rows;
  res.json(rows);
});

app.get('/api/shows/:id(\\d+)', requireAuth, async (req, res) => {
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
    a.diff = computeSetlistDiff(a.original_setlist, a.songs.map(s => s.title));
  }
  const companions = (await pool.query(
    `SELECT c.* FROM companions c JOIN show_companions sc ON sc.companion_id=c.id WHERE sc.show_id=$1`, [showId]
  )).rows;
  res.json({ ...show, artists, companions });
});

// Compares the current song order/composition against the original pull so
// the tagging screen can show exactly what's actually been edited, instead
// of leaving you to guess whether a swap or a cover exclusion is what made
// the setlist "look" different.
function computeSetlistDiff(original, current) {
  if (!original) return null; // no baseline recorded (older data) — nothing to compare
  const originalCounts = {};
  original.forEach(t => { originalCounts[t] = (originalCounts[t] || 0) + 1; });
  const currentCounts = {};
  current.forEach(t => { currentCounts[t] = (currentCounts[t] || 0) + 1; });

  const added = [];
  for (const t of current) {
    if ((currentCounts[t] > (originalCounts[t] || 0))) { added.push(t); currentCounts[t]--; }
  }
  const removed = [];
  const remaining = { ...originalCounts };
  current.forEach(t => { if (remaining[t] > 0) remaining[t]--; });
  for (const t of original) {
    if (remaining[t] > 0) { removed.push(t); remaining[t]--; }
  }

  const commonOriginalOrder = original.filter(t => current.includes(t));
  const commonCurrentOrder = current.filter(t => original.includes(t));
  const reordered = JSON.stringify(commonOriginalOrder) !== JSON.stringify(commonCurrentOrder);

  return { added, removed, reordered, hasChanges: added.length > 0 || removed.length > 0 || reordered };
}

// Reassigns play_order 1..N to match the given sequence — used by the
// move-up/move-down controls in the tagging screen.
app.post('/api/show-artists/:id/reorder', requireAuth, async (req, res) => {
  const { orderedShowSongIds } = req.body;
  for (let i = 0; i < orderedShowSongIds.length; i++) {
    await pool.query('UPDATE show_songs SET play_order=$1 WHERE id=$2', [i + 1, orderedShowSongIds[i]]);
  }
  res.json({ ok: true });
});

// Lets the user add a song the setlist pull missed entirely (rare, but
// happens) — same effect as one coming in from setlist.fm, just typed
// instead of pulled, and still runs through the normal master-list match.
app.post('/api/show-artists/:id/add-song', requireAuth, async (req, res) => {
  const showArtistId = Number(req.params.id);
  const { title } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Song title is required' });
  const artistRow = (await pool.query('SELECT artist FROM show_artists WHERE id=$1', [showArtistId])).rows[0];
  if (!artistRow) return res.status(404).json({ error: 'Show artist not found' });
  const maxOrder = (await pool.query('SELECT COALESCE(max(play_order),0) AS m FROM show_songs WHERE show_artist_id=$1', [showArtistId])).rows[0].m;
  const song = await findOrCreateSong(artistRow.artist, title.trim());
  const inserted = (await pool.query(
    `INSERT INTO show_songs (show_artist_id, song_id, play_order) VALUES ($1,$2,$3) RETURNING id`,
    [showArtistId, song.id, Number(maxOrder) + 1]
  )).rows[0];
  res.json({ ok: true, showSongId: inserted.id, title: song.title, playOrder: Number(maxOrder) + 1 });
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
    const show = (await pool.query('SELECT origin_address, venue_lat, venue_lng, distance_miles, duration_minutes FROM shows WHERE id=$1', [showId])).rows[0];
    const addressChanged = show.origin_address !== originAddress;
    const dataMissing = show.distance_miles === null || show.duration_minutes === null;

    if (!addressChanged && !dataMissing) {
      // Nothing relevant changed — leave the existing (already-correct)
      // travel data alone rather than re-running geocoding on every save.
      await pool.query('UPDATE shows SET origin_address=$1 WHERE id=$2', [originAddress, showId]);
    } else {
      let originCoord = null;
      let geocodeError = null;
      try { originCoord = await ors.geocode(originAddress); } catch (e) { geocodeError = e.message; }
      let distance = null;
      if (originCoord && show.venue_lat && show.venue_lng) {
        try { distance = await ors.drivingDistance(originCoord, { lat: show.venue_lat, lng: show.venue_lng }); } catch (e) { geocodeError = e.message; }
      }
      if (originCoord && distance) {
        // A real result — safe to overwrite.
        await pool.query(
          `UPDATE shows SET origin_address=$1, origin_lat=$2, origin_lng=$3, distance_miles=$4, duration_minutes=$5 WHERE id=$6`,
          [originAddress, originCoord.lat, originCoord.lng, distance.miles, distance.minutes, showId]
        );
      } else {
        // Geocoding failed this time — update the address text so it's not
        // lost, but never blank out previously-good distance/duration with
        // a failed attempt's null result.
        await pool.query('UPDATE shows SET origin_address=$1 WHERE id=$2', [originAddress, showId]);
      }
    }
  }

  await pool.query(`UPDATE shows SET stage='tagged' WHERE id=$1`, [showId]);
  res.json({ ok: true });
});

// Backs a show's review out to "not started" — used when someone wants to
// abandon progress on a show rather than push through to completion. Leaves
// whatever flags/matches were already saved in place (harmless, re-editable
// next time) — this only resets which step it's parked on.
app.post('/api/shows/:id/reset-stage', requireAuth, async (req, res) => {
  await pool.query(`UPDATE shows SET stage='new' WHERE id=$1`, [Number(req.params.id)]);
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
  // This is a deliberate wholesale replacement, not an ad-hoc edit — reset
  // the diff baseline to the new pull so later small edits (a swap, a
  // reorder) don't get misread as "most of the setlist was removed."
  const sourceLabel = `filled in from ${setlist.eventDate} at ${setlist.venue.name}`;
  await pool.query(
    'UPDATE show_artists SET original_setlist=$1, setlist_source=$2 WHERE id=$3',
    [JSON.stringify(songs.map(s => s.name)), sourceLabel, showArtistId]
  );
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
      let searchError = null;
      try { candidates = await spotify.searchTrack(song.title, song.artist); }
      catch (e) { searchError = e.message; }
      const best = candidates[0];
      out.push({ songId: song.id, showSongIds: song.show_song_ids, artist: song.artist, title: song.title, status: 'pending', candidates, suggested: best || null, searchError });
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
    const current = (await pool.query('SELECT spotify_track_id FROM songs WHERE id=$1', [d.songId])).rows[0];
    const newTrackId = d.action === 'exclude' ? null : (d.track && d.track.id);
    const changingTrack = current && current.spotify_track_id && current.spotify_track_id !== newTrackId;

    if (changingTrack) {
      // This song's match is shared across every show it appears in — pull
      // the old track out of anywhere it was already pushed, everywhere,
      // then let it get re-added fresh under the new match.
      const targets = [
        { key: 'seen', playlistId: (await pool.query('SELECT seen_playlist_id FROM config WHERE id=1')).rows[0].seen_playlist_id },
      ];
      const cfg = (await pool.query('SELECT wes_playlist_id, dad_playlist_id FROM config WHERE id=1')).rows[0];
      targets.push({ key: 'wes', playlistId: cfg.wes_playlist_id }, { key: 'dad', playlistId: cfg.dad_playlist_id });
      const affected = (await pool.query('SELECT id, added_to_seen, added_to_wes, added_to_dad FROM show_songs WHERE song_id=$1', [d.songId])).rows;
      for (const t of targets) {
        if (affected.some(r => r[`added_to_${t.key}`])) {
          try { await spotify.removeTracksFromPlaylist(t.playlistId, [`spotify:track:${current.spotify_track_id}`]); } catch (e) {}
        }
      }
      await pool.query('UPDATE show_songs SET added_to_seen=false, added_to_wes=false, added_to_dad=false WHERE song_id=$1', [d.songId]);
    }

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
  const { drops, skipSync } = req.body; // drops: [showSongId]
  const targets = await playlistTargets(showId);

  // A dropped song that had already made it into a playlist needs to come
  // back out, not just stop being tracked.
  const dropIds = (drops || []).map(Number).filter(Number.isFinite);
  if (dropIds.length) {
    const droppedRows = (await pool.query(
      `SELECT ss.id, ss.added_to_seen, ss.added_to_wes, ss.added_to_dad, s.spotify_track_id
       FROM show_songs ss JOIN songs s ON s.id=ss.song_id WHERE ss.id = ANY($1::int[])`, [dropIds]
    )).rows;
    if (!skipSync) {
      for (const row of droppedRows) {
        if (!row.spotify_track_id) continue;
        for (const target of targets) {
          if (row[`added_to_${target.key}`]) {
            try { await spotify.removeTracksFromPlaylist(target.playlistId, [`spotify:track:${row.spotify_track_id}`]); } catch (e) {}
          }
        }
      }
    }
    await pool.query(`UPDATE show_songs SET added_to_seen=false, added_to_wes=false, added_to_dad=false WHERE id = ANY($1::int[])`, [dropIds]);
  }

  if (skipSync) {
    // Dataset changes are saved (above), but nothing gets pushed to Spotify.
    // Leaving added_to_* flags as-is means anything genuinely out of sync
    // will surface again on its own via "Playlist updates needed."
    await pool.query(`UPDATE shows SET stage='complete' WHERE id=$1`, [showId]);
    return res.json({ ok: true, added: 0, skipped: true });
  }

  const songs = (await pool.query(
    `SELECT ss.id AS show_song_id, s.spotify_track_id, ss.added_to_seen, ss.added_to_wes, ss.added_to_dad
     FROM show_songs ss JOIN songs s ON s.id=ss.song_id JOIN show_artists sa ON sa.id=ss.show_artist_id
     WHERE sa.show_id=$1 AND s.spotify_status IN ('matched','assumed_added') AND s.spotify_track_id IS NOT NULL`, [showId]
  )).rows;
  const dropSet = new Set(dropIds.map(String));
  const keep = songs.filter(s => !dropSet.has(String(s.show_song_id)));

  let added = 0;
  for (const target of targets) {
    const flagCol = `added_to_${target.key}`;
    // Only the songs actually missing this specific playlist get pushed —
    // already-added songs are left alone, not resent.
    const toAdd = keep.filter(s => !s[flagCol]);
    const uris = toAdd.map(s => `spotify:track:${s.spotify_track_id}`);
    await spotify.addTracksToPlaylist(target.playlistId, uris);
    added += toAdd.length;
    for (const s of toAdd) {
      await pool.query(`UPDATE show_songs SET ${flagCol}=true WHERE id=$1`, [s.show_song_id]);
    }
  }

  await pool.query(`UPDATE shows SET stage='complete' WHERE id=$1`, [showId]);
  res.json({ ok: true, added });
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
      (sa.billing_order = 1) AS is_headliner_appearance
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
      songCount: Number(sc.total_slots),
      pctHeadline: Math.round(100 * a.headlineCount / a.timesSeen * 10) / 10,
      setlistVariationPct: sc.total_slots ? Math.round(100 * sc.unique_songs / sc.total_slots * 10) / 10 : 0,
      openCloseVariationPct,
    };
  }).sort((a, b) => b.timesSeen - a.timesSeen).slice(0, 10);

  const repeatArtists = Object.values(byArtist).filter(a => a.timesSeen > 1);

  // "Most new songs vs. the immediately-preceding time you saw them" — for
  // each artist you've seen more than once, compare every show to the one
  // right before it chronologically (show 2 vs show 1, show 3 vs show 2,
  // etc.) and take that artist's single biggest new-song count from any one
  // of those comparisons.
  const artistShowSongs = (await pool.query(`
    SELECT sa.artist, sh.date, array_agg(DISTINCT ss.song_id) AS song_ids
    FROM show_artists sa
    JOIN shows sh ON sh.id = sa.show_id
    JOIN show_songs ss ON ss.show_artist_id = sa.id
    WHERE ${filterClause}
    GROUP BY sa.artist, sh.date
    ORDER BY sa.artist, sh.date
  `, [cIds])).rows;
  const showsByArtist = {};
  for (const r of artistShowSongs) (showsByArtist[r.artist] = showsByArtist[r.artist] || []).push(r.song_ids.map(Number));
  const mostUniqueSongsRepeat = repeatArtists.map(a => {
    const shows = showsByArtist[a.artist] || [];
    let best = 0;
    for (let i = 1; i < shows.length; i++) {
      const prevSet = new Set(shows[i - 1]);
      const newCount = shows[i].filter(id => !prevSet.has(id)).length;
      if (newCount > best) best = newCount;
    }
    return { artist: a.artist, timesSeen: a.timesSeen, newSongsInASet: best };
  }).sort((a, b) => b.newSongsInASet - a.newSongsInASet).slice(0, 5);

  const mostOpenCloseVariation = repeatArtists.map(a => ({
    artist: a.artist,
    timesSeen: a.timesSeen,
    openCloseVariationPct: Math.round(100 * ((a.openers.size + a.closers.size) / (2 * a.timesSeen)) * 10) / 10,
  })).sort((a, b) => b.openCloseVariationPct - a.openCloseVariationPct).slice(0, 5);

  const mostSongsInSet = (await pool.query(`
    SELECT sh.date, sa.artist, count(*) AS song_count
    FROM shows sh JOIN show_artists sa ON sa.show_id = sh.id JOIN show_songs ss ON ss.show_artist_id = sa.id
    WHERE ${filterClause}
    GROUP BY sh.date, sa.artist, sa.id
    ORDER BY song_count DESC LIMIT 10
  `, [cIds])).rows.map(r => ({ date: r.date, artist: r.artist, songCount: Number(r.song_count) }));

  res.json({ bandsSeenMost, mostUniqueSongsRepeat, mostOpenCloseVariation, mostSongsInSet });
});

// Drilldown detail behind each superlatives row.
app.get('/api/superlatives/drilldown/bands-seen/:artist', requireAuth, async (req, res) => {
  const rows = (await pool.query(`
    SELECT sh.date, sh.venue, sh.city, sh.state, count(ss.id) AS song_count
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id
    WHERE sa.artist=$1 GROUP BY sh.id, sh.date, sh.venue, sh.city, sh.state ORDER BY sh.date
  `, [req.params.artist])).rows;
  res.json(rows);
});

app.get('/api/superlatives/drilldown/set/:date/:artist', requireAuth, async (req, res) => {
  const rows = (await pool.query(`
    SELECT s.title, ss.play_order, ss.status, ss.known
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id JOIN songs s ON s.id=ss.song_id
    WHERE sh.date=$1 AND sa.artist=$2 ORDER BY ss.play_order
  `, [req.params.date, req.params.artist])).rows;
  res.json(rows);
});

app.get('/api/superlatives/drilldown/open-close/:artist', requireAuth, async (req, res) => {
  const rows = (await pool.query(`
    SELECT sh.date, sh.venue,
      (array_agg(s.title ORDER BY ss.play_order ASC))[1] AS opener,
      (array_agg(s.title ORDER BY ss.play_order DESC))[1] AS closer
    FROM shows sh JOIN show_artists sa ON sa.show_id=sh.id JOIN show_songs ss ON ss.show_artist_id=sa.id JOIN songs s ON s.id=ss.song_id
    WHERE sa.artist=$1 GROUP BY sh.id, sh.date, sh.venue ORDER BY sh.date
  `, [req.params.artist])).rows;
  res.json(rows);
});

// The side-by-side comparison: finds the specific consecutive pair of shows
// that produced this artist's "most new songs" number, and returns both
// setlists lined up — overlapping songs first (matched row to row), then
// each show's songs that didn't appear in the other.
app.get('/api/superlatives/drilldown/repeat-compare/:artist', requireAuth, async (req, res) => {
  const artist = req.params.artist;
  const shows = (await pool.query(`
    SELECT sh.id, sh.date, sh.venue, array_agg(DISTINCT ss.song_id) AS song_ids
    FROM show_artists sa JOIN shows sh ON sh.id=sa.show_id JOIN show_songs ss ON ss.show_artist_id=sa.id
    WHERE sa.artist=$1 GROUP BY sh.id, sh.date, sh.venue ORDER BY sh.date
  `, [artist])).rows;

  let best = null;
  for (let i = 1; i < shows.length; i++) {
    const prevSet = new Set(shows[i - 1].song_ids.map(Number));
    const newCount = shows[i].song_ids.map(Number).filter(id => !prevSet.has(id)).length;
    if (!best || newCount > best.newCount) best = { prev: shows[i - 1], curr: shows[i], newCount };
  }
  if (!best) return res.json(null);

  async function songsFor(showId) {
    return (await pool.query(`
      SELECT s.title, s.id AS song_id, ss.play_order
      FROM show_artists sa JOIN show_songs ss ON ss.show_artist_id=sa.id JOIN songs s ON s.id=ss.song_id
      WHERE sa.show_id=$1 AND sa.artist=$2 ORDER BY ss.play_order
    `, [showId, artist])).rows;
  }
  const prevSongs = await songsFor(best.prev.id);
  const currSongs = await songsFor(best.curr.id);
  const prevIds = new Set(prevSongs.map(s => s.song_id));
  const currIds = new Set(currSongs.map(s => s.song_id));

  const overlap = currSongs.filter(s => prevIds.has(s.song_id)).map(s => s.title);
  const prevOnly = prevSongs.filter(s => !currIds.has(s.song_id)).map(s => s.title);
  const currOnly = currSongs.filter(s => !prevIds.has(s.song_id)).map(s => s.title);

  res.json({
    prevShow: { date: best.prev.date, venue: best.prev.venue },
    currShow: { date: best.curr.date, venue: best.curr.venue },
    overlap, prevOnly, currOnly,
  });
});

app.get('/api/report/journey', requireAuth, async (req, res) => {
  const cIds = companionIdsParam(req);
  const filterClause = `($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))`;

  const firstIds = (await pool.query(
    `SELECT id FROM shows sh WHERE ${filterClause} ORDER BY date ASC, id ASC LIMIT 3`, [cIds]
  )).rows.map(r => r.id);
  const lastIds = (await pool.query(
    `SELECT id FROM shows sh WHERE ${filterClause} ORDER BY date DESC, id DESC LIMIT 3`, [cIds]
  )).rows.map(r => r.id);

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
    SELECT s.artist, s.title, bool_or(${REGRET_SQL}) AS regret,
      (array_agg(sh.date ORDER BY sh.date ASC))[1] AS date,
      (array_agg(sh.venue ORDER BY sh.date ASC))[1] AS venue
    FROM show_songs ss JOIN show_artists sa ON sa.id = ss.show_artist_id JOIN songs s ON s.id=ss.song_id JOIN shows sh ON sh.id = sa.show_id
    WHERE NOT ss.known AND ${filterClause}
      AND NOT EXISTS (SELECT 1 FROM show_songs ss2 WHERE ss2.song_id = ss.song_id AND ss2.known = true)
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
        AND ss.status = 'seen'
        AND ($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))
      UNION
      SELECT s.artist, s.title
      FROM show_songs ss
      JOIN show_artists sa ON sa.id = ss.show_artist_id
      JOIN shows sh ON sh.id = sa.show_id
      JOIN songs s ON s.id = ss.song_id
      WHERE sh.setlistfm_event_id IS NOT NULL
        AND s.spotify_status = 'excluded'
        AND ss.status = 'seen'
        AND ($1::int[] IS NULL OR sh.id IN (SELECT show_id FROM show_companions WHERE companion_id = ANY($1::int[])))
    ) gaps
    ORDER BY artist ASC, title ASC
  `, [cIds])).rows;
  res.json({ songs: rows });
});

// Re-searches every gap song on Spotify, and where a match now exists,
// checks it against what's ACTUALLY in each of the three real playlists
// (not just this app's own added_to_* bookkeeping) before deciding what to
// do: if it's already sitting in a playlist, that just means the app's
// records were stale — mark it as added and move on, no Spotify write. If
// it's genuinely missing, surface it for you to approve on the Sync page.
// Missed/chose-not-to-see songs are excluded from the base gaps query
// already, so they never reach this check either.
app.get('/api/spotify/gap-check', requireAuth, async (req, res) => {
  const cfg = (await pool.query('SELECT * FROM config WHERE id=1')).rows[0];
  const targetDefs = [
    { key: 'seen', playlistId: cfg.seen_playlist_id },
    { key: 'wes', playlistId: cfg.wes_playlist_id },
    { key: 'dad', playlistId: cfg.dad_playlist_id },
  ];
  const playlistIdSets = {};
  for (const t of targetDefs) {
    try { playlistIdSets[t.key] = await spotify.getPlaylistTrackIds(t.playlistId); }
    catch (e) { playlistIdSets[t.key] = new Set(); }
  }

  const gapSongs = (await pool.query(`
    SELECT DISTINCT s.id, s.artist, s.title
    FROM show_songs ss
    JOIN show_artists sa ON sa.id = ss.show_artist_id
    JOIN shows sh ON sh.id = sa.show_id
    JOIN songs s ON s.id = ss.song_id
    WHERE ss.status = 'seen'
      AND ((sh.setlistfm_event_id IS NULL AND ss.already_on_spotify = false) OR s.spotify_status = 'excluded')
  `)).rows;

  let autoMarked = 0;
  const needsAddition = [];

  for (const song of gapSongs) {
    // Which playlists does this song actually belong in, across every show it appears at?
    const companionRows = (await pool.query(`
      SELECT DISTINCT c.name FROM show_songs ss
      JOIN show_artists sa ON sa.id = ss.show_artist_id
      JOIN show_companions sc ON sc.show_id = sa.show_id
      JOIN companions c ON c.id = sc.companion_id
      WHERE ss.song_id = $1
    `, [song.id])).rows.map(r => r.name);
    const applicableTargets = targetDefs.filter(t => t.key === 'seen' || (t.key === 'wes' && companionRows.includes('Wes')) || (t.key === 'dad' && companionRows.includes('Jeff')));

    let candidates = [];
    try { candidates = await spotify.searchTrack(song.title, song.artist); } catch (e) { continue; }
    const best = candidates[0];
    if (!best) continue;

    const missingFrom = applicableTargets.filter(t => !playlistIdSets[t.key].has(best.id));
    const alreadyIn = applicableTargets.filter(t => playlistIdSets[t.key].has(best.id));

    if (alreadyIn.length) {
      // The playlist already has it — the dataset was just out of date.
      await pool.query(
        `UPDATE songs SET spotify_status='matched', spotify_track_id=$1, spotify_track_name=$2, spotify_album_name=$3, spotify_album_art_url=$4 WHERE id=$5`,
        [best.id, best.name, best.albumName, best.albumArtUrl, song.id]
      );
      for (const t of alreadyIn) {
        await pool.query(`UPDATE show_songs SET already_on_spotify=true, added_to_${t.key}=true WHERE song_id=$1`, [song.id]);
      }
      autoMarked++;
    }
    if (missingFrom.length) {
      needsAddition.push({
        songId: song.id, artist: song.artist, title: song.title, track: best,
        targets: missingFrom.map(t => t.key),
      });
    }
  }

  res.json({ autoMarked, needsAddition });
});

app.post('/api/spotify/gap-check/apply', requireAuth, async (req, res) => {
  const { additions } = req.body; // [{songId, track, targets: ['seen','wes','dad']}]
  const cfg = (await pool.query('SELECT * FROM config WHERE id=1')).rows[0];
  const playlistIds = { seen: cfg.seen_playlist_id, wes: cfg.wes_playlist_id, dad: cfg.dad_playlist_id };

  const byTarget = { seen: [], wes: [], dad: [] };
  for (const a of additions || []) {
    await pool.query(
      `UPDATE songs SET spotify_status='matched', spotify_track_id=$1, spotify_track_name=$2, spotify_album_name=$3, spotify_album_art_url=$4 WHERE id=$5`,
      [a.track.id, a.track.name, a.track.albumName, a.track.albumArtUrl, a.songId]
    );
    for (const key of a.targets) byTarget[key].push(a);
  }
  let added = 0;
  for (const key of ['seen', 'wes', 'dad']) {
    const items = byTarget[key];
    if (!items.length) continue;
    await spotify.addTracksToPlaylist(playlistIds[key], items.map(a => `spotify:track:${a.track.id}`));
    for (const a of items) {
      await pool.query(`UPDATE show_songs SET already_on_spotify=true, added_to_${key}=true WHERE song_id=$1`, [a.songId]);
    }
    added += items.length;
  }
  res.json({ ok: true, added });
});

// One-off maintenance: retries geocoding/driving-distance for any show
// still missing miles/minutes. Falls back to the default home address when
// a show has no origin_address of its own set yet, and reports exactly why
// any show is still failing instead of a silent count.
app.post('/api/admin/backfill-travel', requireAuth, async (req, res) => {
  const cfg = (await pool.query('SELECT default_origin_address FROM config WHERE id=1')).rows[0];
  const missing = (await pool.query(
    `SELECT id, origin_address, venue, city, state, venue_lat, venue_lng FROM shows WHERE distance_miles IS NULL OR duration_minutes IS NULL`
  )).rows;
  let fixed = 0;
  const failures = [];
  for (const sh of missing) {
    const originAddress = sh.origin_address || cfg.default_origin_address;
    if (!originAddress) {
      failures.push({ id: sh.id, venue: sh.venue, reason: 'No origin address on this show, and no default home address set in Settings.' });
      continue;
    }
    try {
      let venueCoord = (sh.venue_lat && sh.venue_lng) ? { lat: sh.venue_lat, lng: sh.venue_lng } : null;
      if (!venueCoord) {
        venueCoord = await ors.geocode(`${sh.venue}, ${sh.city}, ${sh.state || ''}`);
        if (!venueCoord) {
          // The specific venue name wasn't found — fall back to the city
          // itself so travel distance is at least approximately right,
          // rather than leaving it blank entirely.
          venueCoord = await ors.geocode(`${sh.city}, ${sh.state || ''}`);
        }
        if (venueCoord) await pool.query('UPDATE shows SET venue_lat=$1, venue_lng=$2 WHERE id=$3', [venueCoord.lat, venueCoord.lng, sh.id]);
      }
      if (!venueCoord) {
        failures.push({ id: sh.id, venue: sh.venue, reason: `The maps service couldn't find "${sh.venue}" or even the city "${sh.city}, ${sh.state || ''}".` });
        continue;
      }
      const originCoord = await ors.geocode(originAddress);
      if (!originCoord) {
        failures.push({ id: sh.id, venue: sh.venue, reason: `The maps service couldn't find the starting address "${originAddress}".` });
        continue;
      }
      const distance = await ors.drivingDistance(originCoord, venueCoord);
      await pool.query(
        'UPDATE shows SET origin_address=$1, origin_lat=$2, origin_lng=$3, distance_miles=$4, duration_minutes=$5 WHERE id=$6',
        [originAddress, originCoord.lat, originCoord.lng, distance.miles, distance.minutes, sh.id]
      );
      fixed++;
    } catch (e) {
      failures.push({ id: sh.id, venue: sh.venue, reason: e.message });
    }
  }
  res.json({ ok: true, fixed, checked: missing.length, stillMissing: failures.length, failures });
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => app.listen(PORT, () => console.log(`Concert tracker running on port ${PORT}`)))
  .catch(err => { console.error('Failed to init schema', err); process.exit(1); });
