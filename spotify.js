const { pool } = require('./db');
const { normalizeTitle } = require('./normalize');

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

function getAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative',
    state,
    // Without this, Spotify may silently redirect a user who's already
    // approved the app once, without ever showing them the new scope —
    // meaning a scope change (like adding playlist-read-private) could
    // look like it reconnected successfully while the token underneath
    // still lacks the new permission. Force the consent screen every time.
    show_dialog: 'true',
  });
  return `${ACCOUNTS_BASE}/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code, redirectUri) {
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${await res.text()}`);
  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    `UPDATE config SET spotify_access_token=$1, spotify_refresh_token=$2, spotify_token_expires_at=$3 WHERE id=1`,
    [data.access_token, data.refresh_token, expiresAt]
  );
  return data;
}

async function getAccessToken() {
  const cfg = (await pool.query('SELECT * FROM config WHERE id=1')).rows[0];
  if (!cfg.spotify_refresh_token) throw new Error('Spotify is not connected yet — visit Settings to connect it.');
  const stillValid = cfg.spotify_token_expires_at && new Date(cfg.spotify_token_expires_at).getTime() > Date.now() + 30000;
  if (stillValid) return cfg.spotify_access_token;

  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.spotify_refresh_token }),
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${await res.text()}`);
  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await pool.query(
    `UPDATE config SET spotify_access_token=$1, spotify_token_expires_at=$2 WHERE id=1`,
    [data.access_token, expiresAt]
  );
  return data.access_token;
}

function isLiveAlbum(albumName) {
  return /\b(live|unplugged|concert|in concert)\b/i.test(albumName);
}

// Scores a candidate track for how well it matches the intended studio
// version: exact title match matters most; live/compilation/remaster/single
// releases are penalized, but only among otherwise-equal candidates — so a
// title that itself specifies a version (e.g. "Gone Away 2020") still wins
// on the exact-match tier even though "2020" alone might look remaster-ish.
function scoreCandidate(track, queryTitleNormalized) {
  const trackTitleNormalized = normalizeTitle(track.name);
  let score = trackTitleNormalized === queryTitleNormalized ? 100
    : trackTitleNormalized.includes(queryTitleNormalized) ? 50
    : 0;
  if (track.album.album_type === 'compilation') score -= 30;
  if (track.album.album_type === 'single') score -= 15;
  if (isLiveAlbum(track.album.name)) score -= 50;
  if (/remaster|anniversary|deluxe/i.test(track.album.name)) score -= 10;
  if (track.album.album_type === 'album') score += 5;
  return score;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Spotify's API expects well-behaved clients to back off and retry when
// rate-limited, using the Retry-After header it sends back — failing
// immediately on a 429 (which is what happened before) means one burst of
// requests (e.g. paginating a large playlist) can permanently block an
// entire run instead of just pausing briefly.
async function fetchSpotify(url, options, attempt = 1) {
  const res = await fetch(url, options);
  if (res.status === 429) {
    // QUOTA_EXCEEDED specifically means the day's allotment is gone — no
    // amount of retrying fixes that, and blindly retrying across many
    // paginated requests (e.g. reading a 1,200-track playlist) is exactly
    // what made a "quick" fetch hang for several minutes before failing
    // anyway. Read the body once to tell the two cases apart.
    const bodyText = await res.text();
    if (/QUOTA_EXCEEDED/i.test(bodyText)) {
      const quotaErr = new Error(`Spotify request failed: ${bodyText}`);
      quotaErr.isQuotaExceeded = true;
      throw quotaErr;
    }
    if (attempt <= 2) {
      await sleep(3000);
      return fetchSpotify(url, options, attempt + 1);
    }
    const err = new Error(`Spotify request failed: ${bodyText}`);
    err._preReadBody = bodyText;
    throw err;
  }
  return res;
}

async function searchTrack(title, artist) {
  const token = await getAccessToken();
  const q = artist ? `track:"${title}" artist:"${artist}"` : `track:"${title}"`;
  const res = await fetchSpotify(`${API_BASE}/search?type=track&limit=10&q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify search failed: ${await res.text()}`);
  const data = await res.json();
  const items = (data.tracks && data.tracks.items) || [];
  const queryNorm = normalizeTitle(title);
  const scored = items
    .map(t => ({ track: t, score: scoreCandidate(t, queryNorm) }))
    .sort((a, b) => b.score - a.score);
  return scored.map(s => ({
    id: s.track.id,
    uri: s.track.uri,
    name: s.track.name,
    artist: s.track.artists.map(a => a.name).join(', '),
    albumName: s.track.album.name,
    albumArtUrl: s.track.album.images && s.track.album.images[1] ? s.track.album.images[1].url : (s.track.album.images[0] && s.track.album.images[0].url),
    albumType: s.track.album.album_type,
    score: s.score,
  }));
}

async function addTracksToPlaylist(playlistId, trackUris) {
  if (!playlistId || !trackUris.length) return;
  const token = await getAccessToken();
  // Spotify caps adds at 100 URIs per call.
  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    const res = await fetchSpotify(`${API_BASE}/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: batch }),
    });
    if (!res.ok) throw new Error(`Spotify add-to-playlist failed: ${await res.text()}`);
  }
}

async function getPlaylistTrackIds(playlistId) {
  if (!playlistId) return new Set();
  const token = await getAccessToken();
  const ids = new Set();
  let url = `${API_BASE}/playlists/${playlistId}/tracks?fields=next,items(track(id))&limit=100`;
  while (url) {
    const res = await fetchSpotify(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Spotify playlist read failed: ${await res.text()}`);
    const data = await res.json();
    for (const item of data.items || []) {
      if (item.track && item.track.id) ids.add(item.track.id);
    }
    url = data.next;
    if (url) await sleep(80); // small pacing between pages of a large playlist
  }
  return ids;
}

// Full track details (not just IDs) for every song in a playlist — one
// cheap paginated read regardless of playlist size, versus one Spotify
// catalog search per song. This is what makes local title/artist matching
// possible without burning API quota per song.
async function getPlaylistTracksFull(playlistId) {
  if (!playlistId) return [];
  const token = await getAccessToken();
  const tracks = [];
  let url = `${API_BASE}/playlists/${playlistId}/tracks?fields=next,items(track(id,name,artists(name),album(name,images)))&limit=100`;
  while (url) {
    const res = await fetchSpotify(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Spotify playlist read failed: ${await res.text()}`);
    const data = await res.json();
    for (const item of data.items || []) {
      if (!item.track) continue;
      tracks.push({
        id: item.track.id,
        name: item.track.name,
        artists: (item.track.artists || []).map(a => a.name),
        albumName: item.track.album ? item.track.album.name : null,
        albumArtUrl: item.track.album && item.track.album.images && item.track.album.images[1] ? item.track.album.images[1].url : (item.track.album && item.track.album.images && item.track.album.images[0] ? item.track.album.images[0].url : null),
      });
    }
    url = data.next;
    if (url) await sleep(80);
  }
  return tracks;
}

async function removeTracksFromPlaylist(playlistId, trackUris) {
  if (!playlistId || !trackUris.length) return;
  const token = await getAccessToken();
  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    const res = await fetchSpotify(`${API_BASE}/playlists/${playlistId}/tracks`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: batch.map(uri => ({ uri })) }),
    });
    if (!res.ok) throw new Error(`Spotify remove-from-playlist failed: ${await res.text()}`);
  }
}

module.exports = { getAuthUrl, exchangeCodeForToken, getAccessToken, searchTrack, addTracksToPlaylist, getPlaylistTrackIds, getPlaylistTracksFull, removeTracksFromPlaylist };
