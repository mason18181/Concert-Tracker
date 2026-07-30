// Normalizes a song title so near-duplicates (curly vs straight apostrophes,
// stray punctuation, casing) resolve to the same master song entry.
function normalizeTitle(str) {
  return String(str)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9' ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normalizeTitle };
