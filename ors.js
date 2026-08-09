const BASE = 'https://api.openrouteservice.org';

function apiKey() {
  const key = process.env.ORS_API_KEY;
  if (!key) throw new Error('ORS_API_KEY is not set');
  return key;
}

// Resolves a free-text address or venue name to coordinates. Returns null
// (rather than throwing) when nothing matches, so callers can fall back to
// a manual pick instead of failing the whole sync. focusLat/focusLon bias
// results toward a known-good area — important for venue names that
// collide with other places (see geocodeVenue below).
async function geocode(text, focus) {
  let url = `${BASE}/geocode/search?api_key=${apiKey()}&text=${encodeURIComponent(text)}&size=1`;
  if (focus) url += `&focus.point.lat=${focus.lat}&focus.point.lon=${focus.lng}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ORS geocode failed: ${await res.text()}`);
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) return null;
  const [lng, lat] = feature.geometry.coordinates;
  return { lat, lng, label: feature.properties.label, region: feature.properties.region || null, locality: feature.properties.locality || null };
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

// Loose match: handles "Georgia" vs "GA", extra whitespace, casing.
function looseMatch(a, b) {
  if (!a || !b) return false;
  const na = String(a).toLowerCase().trim();
  const nb = String(b).toLowerCase().trim();
  return na === nb || na.includes(nb) || nb.includes(na);
}

function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Geocodes a venue reliably even when its name collides with an unrelated
// place elsewhere (e.g. "Avondale Brewing Company, Birmingham, Alabama"
// silently matching Avondale, Arizona instead — a real failure this hit).
// Strategy: geocode the city first as a trustworthy anchor, then search for
// the venue biased toward that anchor point, and reject the venue result if
// either its state doesn't match what we expected OR it lands implausibly
// far from the city it's supposed to be in (catches a same-state-wrong-city
// mismatch, which a region check alone would miss) — falling back to the
// city-level anchor (right city, not exact address) rather than accepting
// a confidently-wrong match.
async function geocodeVenue(venue, city, state) {
  let anchor = null;
  if (city) {
    try { anchor = await geocode(`${city}, ${state || ''}`); } catch (e) { anchor = null; }
    await sleep(200);
  }

  let venueCoord = null;
  try { venueCoord = await geocode(`${venue}, ${city || ''}, ${state || ''}`, anchor); } catch (e) { venueCoord = null; }

  const regionOk = venueCoord && (!state || !venueCoord.region || looseMatch(venueCoord.region, state));
  const distanceOk = venueCoord && (!anchor || haversineMiles(venueCoord, anchor) <= 40);

  if (regionOk && distanceOk) return venueCoord;

  // Venue result was missing, wrong-state, or implausibly far from its own
  // city — the city anchor itself is still a valid, verified point, so use
  // that instead of a confidently-wrong address.
  return anchor;
}

module.exports = { geocode, drivingDistance, geocodeVenue, sleep };
