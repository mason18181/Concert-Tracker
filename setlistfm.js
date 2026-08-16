const BASE = 'https://api.setlist.fm/rest/1.0';

function headers() {
  const apiKey = process.env.SETLISTFM_API_KEY;
  if (!apiKey) throw new Error('SETLISTFM_API_KEY is not set');
  return { 'x-api-key': apiKey, Accept: 'application/json' };
}

async function sfmFetch(path) {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`setlist.fm error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Pulls every setlist the given setlist.fm username has marked "I was there",
// paginating until fewer than a full page comes back.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getAttendedShows(username) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await sfmFetch(`/user/${encodeURIComponent(username)}/attended?p=${page}`);
    if (!data) {
      if (page === 1) throw new Error(`setlist.fm user "${username}" not found — check the username in Settings for typos/casing.`);
      break; // ran past the last page, not an error
    }
    if (!data.setlist || !data.setlist.length) break;
    all.push(...data.setlist);
    if (data.setlist.length < (data.itemsPerPage || 20)) break;
    page += 1;
    await sleep(300);
  }
  return all;
}

async function getSetlist(setlistId) {
  return sfmFetch(`/setlist/${setlistId}`);
}

// For the "fill gaps" tool — other setlists from the same tour/artist to pull
// missing songs from, ordered so the caller can pick the closest date to
// their own show.
async function searchSetlistsByArtist(artistName, page = 1) {
  const data = await sfmFetch(`/search/setlists?artistName=${encodeURIComponent(artistName)}&p=${page}`);
  return data && data.setlist ? data.setlist : [];
}

// Flattens a setlist.fm setlist response into an ordered song list, skipping
// tape/intro-only entries. Marks whether each song is tagged as a cover.
function flattenSetlistSongs(setlist) {
  const out = [];
  if (!setlist || !setlist.sets || !setlist.sets.set) return out;
  for (const set of setlist.sets.set) {
    if (!set.song) continue;
    for (const song of set.song) {
      if (song.tape) continue;
      out.push({
        name: song.name,
        isCover: !!song.cover,
        coverOfArtist: song.cover ? song.cover.name : null,
      });
    }
  }
  return out;
}

// For matching a specific historical show to its real setlist.fm entry —
// date is narrowed to that exact day (setlist.fm wants dd-MM-yyyy), so this
// comes back with very few candidates, usually exactly one.
async function searchSetlistsByArtistAndDate(artistName, isoDate) {
  const [y, m, d] = isoDate.split('-');
  const sfmDate = `${d}-${m}-${y}`;
  const data = await sfmFetch(`/search/setlists?artistName=${encodeURIComponent(artistName)}&date=${sfmDate}`);
  return data && data.setlist ? data.setlist : [];
}

module.exports = { getAttendedShows, getSetlist, searchSetlistsByArtist, searchSetlistsByArtistAndDate, flattenSetlistSongs, sleep };
