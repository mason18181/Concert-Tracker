const BASE = 'https://api.openrouteservice.org';

function apiKey() {
  const key = process.env.ORS_API_KEY;
  if (!key) throw new Error('ORS_API_KEY is not set');
  return key;
}

// Resolves a free-text address or venue name to coordinates. Returns null
// (rather than throwing) when nothing matches, so callers can fall back to
// a manual pick instead of failing the whole sync.
async function geocode(text) {
  const url = `${BASE}/geocode/search?api_key=${apiKey()}&text=${encodeURIComponent(text)}&size=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ORS geocode failed: ${await res.text()}`);
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) return null;
  const [lng, lat] = feature.geometry.coordinates;
  return { lat, lng, label: feature.properties.label };
}

// origin/dest are {lat, lng}. Returns real driving distance/time.
async function drivingDistance(origin, dest) {
  const url = `${BASE}/v2/directions/driving-car?api_key=${apiKey()}&start=${origin.lng},${origin.lat}&end=${dest.lng},${dest.lat}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ORS directions failed: ${await res.text()}`);
  const data = await res.json();
  const seg = data.features[0].properties.segments[0];
  return {
    miles: Math.round((seg.distance / 1609.34) * 10) / 10,
    minutes: Math.round(seg.duration / 60),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Tries the specific venue first; if that's not found — or the call itself
// fails, e.g. a rate limit during a bulk import — falls back to the city
// itself so travel distance is at least approximately right instead of
// blank. The earlier version only handled "no results," not "the call
// threw," so a single rate-limited request could skip the fallback
// entirely — this catches both.
async function geocodeVenue(venue, city, state) {
  let coord = null;
  try { coord = await geocode(`${venue}, ${city || ''}, ${state || ''}`); } catch (e) { coord = null; }
  if (!coord && city) {
    await sleep(250);
    try { coord = await geocode(`${city}, ${state || ''}`); } catch (e) { coord = null; }
  }
  return coord;
}

module.exports = { geocode, drivingDistance, geocodeVenue, sleep };
