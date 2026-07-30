# Concert Tracker

Tracks concerts, setlists, and travel; syncs from setlist.fm; matches songs to
Spotify and keeps three playlists (Seen In Concert, Wes Concerts, Concerts
with Dad) in sync; reports on all of it in-app.

## Deploying to Railway

1. **Push this folder to a new GitHub repo** (same process as the fantasy
   app — create a repo, upload all these files so `package.json` sits at
   the true repo root, not nested in a subfolder).
2. **Railway → New Project → Deploy from GitHub repo** → pick the repo.
3. **Add a Postgres database**: `+ New` → Database → Add PostgreSQL. This
   wires up `DATABASE_URL` automatically.
4. **Set environment variables** on the app service (Variables tab):
   - `SETLISTFM_API_KEY`
   - `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`
   - `ORS_API_KEY`
   - `HOST_PASSWORD` — pick your own private password
5. **Generate a domain**: Settings → Networking → Generate Domain.
6. **Update your Spotify app's Redirect URI**: go back to
   developer.spotify.com/dashboard → your app → Settings, and change the
   Redirect URI from the placeholder to
   `https://your-actual-domain.up.railway.app/api/spotify/callback`, then
   Save. This has to match exactly or Spotify will reject the connection.
7. **Run the historical import once**, from your own machine (this needs
   your local Node + the `DATABASE_URL` Railway gave you, and also needs
   your `ORS_API_KEY` since it geocodes each historical show):
   ```
   npm install
   DATABASE_URL="<paste from Railway>" ORS_API_KEY="<yours>" npm run import
   ```
   This loads all 59 historical shows from `seed/historical_seed.json`
   (already generated from your two spreadsheets) — songs, flags,
   companions, and travel distance/time for each.
8. **Open the app**, log in with your `HOST_PASSWORD`, go to **Settings**:
   - Enter your setlist.fm username
   - Click **Connect Spotify** and approve access
   - Paste in the three playlist IDs (the string after `/playlist/` in
     each playlist's share link)
   - Set your current default home address
9. **Go to Sync** and click **Check for new shows** whenever you've marked
   a new show as attended on setlist.fm.

## What still needs your attention after import

The historical import brings in all your song flags, companions, and
travel data — but it does **not** run Spotify matching (that needs your
Spotify login, which only exists once deployed). Songs your sheet already
flagged as added to Spotify are marked `assumed_added` and skipped; the
rest sit as `pending` and will show up for matching the first time you
open a show's Spotify review step — which right now only exists in the
new-show sync flow. If you want a bulk "review all pending historical
songs at once" screen instead of walking through 59 old shows one by one,
let me know and I'll add it — that's the one piece of the original plan
not yet wired up in this version.

## Known gaps in this first build

- **Bulk historical Spotify review** — not yet built (see above).
- **Manual Spotify search box** in the review screen is a placeholder —
  swapping a match currently works via the auto-suggested candidates only,
  not a fully free-text Spotify search. Flag this if it matters before
  your first real sync.
- **First/Last Shows** and a **Companion filter** page from our earlier
  mockups aren't built yet — Overview, Yearly, Trends, Travel,
  Superlatives, and Song Status are.
