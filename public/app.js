let hostPw = sessionStorage.getItem('ct_pw') || null;
let activeTab = 'sync';
let wizardShowId = null;
let wizardStage = null; // 'tag' | 'spotify' | 'playlist'

let dashboardSubtab = 'overview'; // overview | trends | travel | superlatives | journey | unknowns
let selectedCompanionIds = new Set(); // empty == "All"
let allCompanions = [];

// Track candidates get referenced by key instead of embedding their JSON
// directly in HTML attributes — any apostrophe in an artist/album/track name
// (extremely common: "Guns N' Roses", "Don't...", etc.) breaks a
// single-quoted HTML attribute, so this sidesteps that whole class of bug.
let candidateStore = {};
let candidateKeyCounter = 0;
function stashCandidate(candidate) {
  const key = `c${candidateKeyCounter++}`;
  candidateStore[key] = candidate;
  return key;
}
function fmt(n) {
  if (n === null || n === undefined) return '0';
  return Number(n).toLocaleString('en-US');
}

const DASHBOARD_SUBTABS = [
  ['overview', 'Overview'],
  ['trends', 'Trends'],
  ['travel', 'Travel'],
  ['superlatives', 'Superlatives'],
  ['journey', 'Journey'],
  ['unknowns', 'Unknowns'],
  ['spotifygaps', 'Spotify Gaps'],
];

function companionsQuery() {
  return selectedCompanionIds.size ? `?companions=${[...selectedCompanionIds].join(',')}` : '';
}

function showModal(message, { title = '', okLabel = 'Okay' } = {}) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      ${title ? `<h2>${title}</h2>` : ''}
      <p>${message}</p>
      <button class="btn" id="modal-ok-btn">${okLabel}</button>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#modal-ok-btn').onclick = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

const app = document.getElementById('app');
const nav = document.getElementById('nav');

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (hostPw) headers['x-host-password'] = hostPw;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

nav.addEventListener('click', e => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  wizardShowId = null;
  renderTab();
});

async function loadCompanionsForFilter() {
  allCompanions = await api('/api/companions');
}

function renderAttendeeFilterBar() {
  const allActive = selectedCompanionIds.size === 0;
  return `
    <div class="card filter-bar">
      <div class="row" style="align-items:center;">
        <span class="muted" style="text-transform:uppercase;font-size:11px;">Attendee:</span>
        <span class="pill ${allActive ? 'on' : ''}" data-attendee="all">All</span>
        ${allCompanions.map(c => `<span class="pill ${selectedCompanionIds.has(c.id) ? 'on' : ''}" data-attendee="${c.id}">${c.name}</span>`).join('')}
      </div>
    </div>
  `;
}

function wireAttendeeFilterBar(onChange) {
  app.querySelectorAll('[data-attendee]').forEach(p => {
    p.onclick = () => {
      if (p.dataset.attendee === 'all') {
        selectedCompanionIds.clear();
      } else {
        const id = Number(p.dataset.attendee);
        if (selectedCompanionIds.has(id)) selectedCompanionIds.delete(id);
        else selectedCompanionIds.add(id);
      }
      onChange();
    };
  });
}

function renderDashboardSubnav() {
  return `
    <div class="row subnav">
      ${DASHBOARD_SUBTABS.map(([key, label]) => `<button class="btn secondary sub-tab-btn ${dashboardSubtab === key ? 'active' : ''}" data-subtab="${key}">${label}</button>`).join('')}
    </div>
  `;
}

function wireDashboardSubnav() {
  app.querySelectorAll('[data-subtab]').forEach(btn => {
    btn.onclick = () => { dashboardSubtab = btn.dataset.subtab; renderDashboard(); };
  });
}

async function renderDashboard() {
  if (!allCompanions.length) await loadCompanionsForFilter();
  const renderers = {
    overview: renderOverview,
    trends: renderTrends,
    travel: renderTravel,
    superlatives: renderSuperlatives,
    journey: renderJourney,
    unknowns: renderUnknowns,
    spotifygaps: renderSpotifyGaps,
  };
  app.innerHTML = `<div id="dash-subnav-slot"></div><div id="dash-filter-slot"></div><div id="dash-body-slot"></div>`;
  document.getElementById('dash-subnav-slot').innerHTML = renderDashboardSubnav();
  document.getElementById('dash-filter-slot').innerHTML = renderAttendeeFilterBar();
  wireDashboardSubnav();
  wireAttendeeFilterBar(renderDashboard);
  await renderers[dashboardSubtab]();
}

function setNavActive() {
  [...nav.querySelectorAll('button')].forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
}

async function boot() {
  if (!hostPw) { renderLoginGate(); return; }
  try { await api('/api/login', { method: 'POST' }); }
  catch (e) { hostPw = null; sessionStorage.removeItem('ct_pw'); renderLoginGate(); return; }
  nav.classList.remove('hidden');
  renderTab();
}

function renderLoginGate() {
  nav.classList.add('hidden');
  app.innerHTML = `
    <div class="card" style="max-width:380px;margin:60px auto;">
      <h1>Concert Tracker</h1>
      <div class="field"><label>Password</label><input id="pw" type="password" /></div>
      <button class="btn" id="login-btn">Unlock</button>
      <div class="error" id="login-err"></div>
    </div>`;
  document.getElementById('login-btn').onclick = async () => {
    hostPw = document.getElementById('pw').value;
    try {
      await api('/api/login', { method: 'POST' });
      sessionStorage.setItem('ct_pw', hostPw);
      nav.classList.remove('hidden');
      renderTab();
    } catch (e) { document.getElementById('login-err').textContent = e.message; }
  };
}

function renderTab() {
  setNavActive();
  candidateStore = {};
  if (wizardShowId) return renderWizard();
  if (activeTab === 'sync') return renderSync();
  if (activeTab === 'dashboard') return renderDashboard();
  if (activeTab === 'settings') return renderSettings();
}

function dashBody() { return document.getElementById('dash-body-slot'); }

// ---------------- Settings ----------------
async function renderSettings() {
  const s = await api('/api/settings');
  app.innerHTML = `
    <div class="card">
      <h2>setlist.fm</h2>
      <div class="field"><label>Username</label><input id="sfm-user" value="${s.setlistfmUsername || ''}" /></div>
      <button class="btn secondary" id="sfm-debug-btn" style="margin-top:8px;">Test attendance check</button>
      <div class="row" style="margin-top:8px;">
        <input id="sfm-debug-artist" placeholder="Look up a specific artist (e.g. Lynyrd Skynyrd)" style="max-width:260px;" />
        <button class="btn secondary" id="sfm-debug-lookup-btn">Look up</button>
      </div>
      <div id="sfm-debug-result" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <h2>Spotify</h2>
      <p class="${s.spotifyConnected ? 'success' : 'muted'}">${s.spotifyConnected ? 'Connected' : 'Not connected yet'}</p>
      <button class="btn secondary" id="spotify-connect-btn">Connect Spotify</button>
      <div class="field" style="margin-top:14px;"><label>Seen In Concert playlist ID</label><input id="pl-seen" value="${s.seenPlaylistId || ''}" /></div>
      <div class="field"><label>Wes Concerts playlist ID</label><input id="pl-wes" value="${s.wesPlaylistId || ''}" /></div>
      <div class="field"><label>Concerts with Dad playlist ID</label><input id="pl-dad" value="${s.dadPlaylistId || ''}" /></div>
      <p class="muted">Playlist ID is the string after /playlist/ in a Spotify playlist's share link.</p>
    </div>
    <div class="card">
      <h2>Default travel origin</h2>
      <div class="field"><label>Home address</label><input id="origin" value="${s.defaultOriginAddress || ''}" /></div>
    </div>
    <button class="btn" id="save-settings-btn">Save settings</button>
    <div class="success" id="settings-ok"></div>
    <div class="card" style="margin-top:20px;">
      <h2>Historical import</h2>
      <p class="muted">Loads your 59 historical shows into the database. Safe to click more than once — already-imported shows are skipped for songs/companions, but this also retries travel geocoding for any of them still missing miles/time, so it doubles as the fix for a straggler like a venue that failed to geocode the first time.</p>
      <button class="btn secondary" id="import-btn">Run historical import</button>
      <div class="muted" id="import-status" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <h2>Match historical shows to setlist.fm</h2>
      <p class="muted">Finds the real setlist.fm entry for each historical show (by artist + exact date) and fills in the tour name. This reads public setlist.fm data only — it can't mark "I Was There" on your account, since that's a website-only action with no API equivalent. Safe to click more than once.</p>
      <button class="btn secondary" id="match-sfm-btn">Match to setlist.fm</button>
      <div class="muted" id="match-sfm-status" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <h2>Session</h2>
      <button class="btn danger" id="lock-btn">Lock app</button>
      <p class="muted" style="margin-top:8px;">Requires re-entering the host password to unlock.</p>
    </div>
  `;
  document.getElementById('sfm-debug-btn').onclick = async () => {
    const el = document.getElementById('sfm-debug-result');
    el.innerHTML = '<p class="muted">Checking...</p>';
    try {
      const d = await api('/api/setlistfm/attended-debug');
      if (d.error) { el.innerHTML = `<p class="error">${d.error}</p>`; return; }
      const matchedIds = new Set(d.matchedShows.map(m => m.setlistfm_id));
      const overlap = d.attendedSample.filter(a => matchedIds.has(a.id));
      el.innerHTML = `
        <p class="muted">Username used: <b>${d.username}</b> &middot; attended shows fetched: <b>${fmt(d.attendedCount)}</b> &middot; shows matched in your dataset: <b>${fmt(d.matchedShows.length)}</b></p>
        <p class="muted">First few attended (raw from setlist.fm):</p>
        ${d.attendedSample.map(a => `<div class="muted" style="font-size:12px;">${a.date} — ${a.artist} @ ${a.venue} <span style="font-family:monospace;">(id: ${a.id})</span></div>`).join('')}
        <p class="muted" style="margin-top:8px;">Your dataset's matched show IDs (first 10):</p>
        ${d.matchedShows.slice(0, 10).map(m => `<div class="muted" style="font-size:12px;">${m.artist} <span style="font-family:monospace;">(id: ${m.setlistfm_id})</span></div>`).join('')}
        <p style="margin-top:8px;" class="${overlap.length ? 'success' : 'error'}">Overlap found in this sample: ${overlap.length}</p>
      `;
    } catch (e) { el.innerHTML = `<p class="error">${e.message}</p>`; }
  };
  document.getElementById('sfm-debug-lookup-btn').onclick = async () => {
    const el = document.getElementById('sfm-debug-result');
    const artist = document.getElementById('sfm-debug-artist').value.trim();
    if (!artist) return;
    el.innerHTML = '<p class="muted">Checking...</p>';
    try {
      const d = await api(`/api/setlistfm/attended-debug?artist=${encodeURIComponent(artist)}`);
      if (d.error) { el.innerHTML = `<p class="error">${d.error}</p>`; return; }
      if (!d.artistLookup.length) { el.innerHTML = '<p class="muted">No show_artists rows match that name.</p>'; return; }
      el.innerHTML = d.artistLookup.map(r => `
        <div style="border-bottom:1px solid var(--line);padding:6px 0;font-size:12px;">
          <div>${r.artist} — ${new Date(r.date).toLocaleDateString()}, ${r.venue}</div>
          <div class="muted">checked: ${r.setlistfm_checked} &middot; setlistfm_id: ${r.setlistfm_id || 'none'} &middot; url: ${r.setlistfm_url ? 'yes' : 'none'} &middot; marked_attended (override flag): ${r.marked_attended}</div>
        </div>
      `).join('');
    } catch (e) { el.innerHTML = `<p class="error">${e.message}</p>`; }
  };
  document.getElementById('import-btn').onclick = async () => {
    const statusEl = document.getElementById('import-status');
    statusEl.textContent = 'Running — this can take a minute or two...';
    try {
      const r = await api('/api/import/historical', { method: 'POST' });
      statusEl.innerHTML = `Imported ${r.imported} new show(s). ${r.skipped} already existed, of which ${r.geoFilled} had missing travel data filled in and ${r.artistsAdded} had a new artist added.` +
        (r.geoFailures.length ? `<div style="margin-top:8px;">${r.geoFailures.map(f => `<div class="error">${f.venue} (${new Date(f.date).toLocaleDateString()}): ${f.reason}</div>`).join('')}</div>` : '');
    } catch (e) { statusEl.textContent = e.message; }
  };
  document.getElementById('match-sfm-btn').onclick = async () => {
    const statusEl = document.getElementById('match-sfm-status');
    statusEl.textContent = 'Starting...';
    let totalMatched = 0, totalNoMatch = 0, allUnmatched = [];
    try {
      while (true) {
        const r = await api('/api/setlistfm/match-historical', { method: 'POST' });
        totalMatched += r.matched;
        totalNoMatch += r.noMatch;
        allUnmatched = allUnmatched.concat(r.unmatched);
        statusEl.textContent = `Matched ${fmt(totalMatched)}, no match for ${fmt(totalNoMatch)}. ${fmt(r.remaining)} remaining...`;
        if (r.done) break;
      }
      statusEl.innerHTML = `Done — matched ${fmt(totalMatched)} show(s), no automatic match for ${fmt(totalNoMatch)}. Usually an opener whose setlist was never logged separately, or a name that doesn't exactly match setlist.fm's listing — search manually below.`;
      renderUnmatchedList(allUnmatched);
    } catch (e) { statusEl.textContent = e.message; }
  };
  document.getElementById('spotify-connect-btn').onclick = async () => {
    const { url } = await api('/api/spotify/connect');
    window.open(url, '_blank');
  };
  document.getElementById('save-settings-btn').onclick = async () => {
    await api('/api/settings', { method: 'POST', body: {
      setlistfmUsername: document.getElementById('sfm-user').value,
      seenPlaylistId: document.getElementById('pl-seen').value,
      wesPlaylistId: document.getElementById('pl-wes').value,
      dadPlaylistId: document.getElementById('pl-dad').value,
      defaultOriginAddress: document.getElementById('origin').value,
    }});
    document.getElementById('settings-ok').textContent = 'Saved.';
  };
  document.getElementById('lock-btn').onclick = () => {
    hostPw = null;
    sessionStorage.removeItem('ct_pw');
    renderLoginGate();
  };
}

function renderUnmatchedList(unmatched) {
  const container = document.createElement('div');
  container.id = 'sfm-unmatched-list';
  container.style.marginTop = '10px';
  document.getElementById('match-sfm-status').after(container);
  container.innerHTML = unmatched.map(u => `
    <div style="border-bottom:1px solid var(--line);padding:8px 0;" data-unmatched-row="${u.id}">
      <div class="row" style="justify-content:space-between;">
        <span>${u.artist} — ${new Date(u.date).toLocaleDateString()}, ${u.venue}</span>
      </div>
      <div class="row" style="margin-top:4px;">
        <input class="sfm-manual-name" value="${u.artist}" style="max-width:200px;" />
        <input class="sfm-manual-date" type="date" value="${new Date(u.date).toISOString().slice(0,10)}" style="max-width:150px;" title="Clear this to search without a date filter" />
        <button class="btn secondary" data-manual-search-btn="${u.id}">Search setlist.fm</button>
      </div>
      <div id="sfm-manual-results-${u.id}"></div>
    </div>
  `).join('');
  container.querySelectorAll('[data-manual-search-btn]').forEach(btn => btn.onclick = async () => {
    const row = btn.closest('[data-unmatched-row]');
    const name = row.querySelector('.sfm-manual-name').value.trim();
    const dateVal = row.querySelector('.sfm-manual-date').value; // may be cleared on purpose
    const resultsEl = document.getElementById(`sfm-manual-results-${btn.dataset.manualSearchBtn}`);
    resultsEl.innerHTML = '<p class="muted">Searching...</p>';
    try {
      const candidates = await api('/api/setlistfm/search', { method: 'POST', body: { artistName: name, date: dateVal || null } });
      if (!candidates.length) { resultsEl.innerHTML = '<p class="muted">No results — try clearing the date, or double-check the spelling matches setlist.fm exactly.</p>'; return; }
      resultsEl.innerHTML = candidates.map(c => `
        <div class="row" style="justify-content:space-between;padding:4px 0;">
          <span class="muted">${c.date} — ${c.venue}, ${c.city}${c.tour ? ` (${c.tour})` : ''}</span>
          <button class="btn secondary" data-pick-setlist="${c.id}">Use this</button>
        </div>
      `).join('');
      resultsEl.querySelectorAll('[data-pick-setlist]').forEach(pickBtn => pickBtn.onclick = async () => {
        pickBtn.disabled = true;
        pickBtn.textContent = 'Saving...';
        try {
          await api('/api/setlistfm/manual-match/apply', { method: 'POST', body: { showArtistId: Number(btn.dataset.manualSearchBtn), setlistId: pickBtn.dataset.pickSetlist } });
          row.innerHTML = `<span class="success">Saved — this show is now matched.</span>`;
        } catch (e) { showModal(e.message, { title: 'Error' }); pickBtn.disabled = false; pickBtn.textContent = 'Use this'; }
      });
    } catch (e) { resultsEl.innerHTML = `<p class="error">${e.message}</p>`; }
  });
}

// ---------------- Sync ----------------
async function renderSync() {
  const pending = await api('/api/shows/pending');
  app.innerHTML = `
    <div class="card">
      <h2>Sync</h2>
      <button class="btn" id="sync-btn">Check for new shows</button>
      <div class="muted" id="sync-status" style="margin-top:8px;"></div>
      <div id="pending-list" style="margin-top:12px;">
        ${pending.length ? pending.map(s => `
          <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0;">
            <div><b>${new Date(s.date).toLocaleDateString()}</b> — ${s.venue}${s.headliner ? ` (${s.headliner})` : ''} <span class="muted">(${s.stage})</span></div>
            <button class="btn secondary" data-show="${s.id}" data-stage="${s.stage === 'new' ? 'tag' : s.stage === 'tagged' ? 'spotify' : 'playlist'}">Continue</button>
          </div>
        `).join('') : '<p class="muted">Nothing pending.</p>'}
      </div>
    </div>
    <div class="card">
      <h2>Spotify gaps check</h2>
      <p class="muted" style="margin-bottom:10px;">Ties every song in your dataset to a real Spotify track, including historical songs your spreadsheet marked as already added (those were never actually searched for until now). Anything that turns out to already be in the right playlist gets marked as such automatically — anything genuinely missing shows up below for you to approve. The first run will cover ~1,400 songs, so it can take several minutes; after that it's just the occasional new one.</p>
      <button class="btn secondary" id="gapcheck-btn">Run gaps check</button>
      <div id="gapcheck-results" style="margin-top:12px;"></div>
    </div>
    <div class="card">
      <h2>All shows (edit)</h2>
      <p class="muted" style="margin-bottom:10px;">Fix a mistake on any show, complete or not — reopens tagging, then Spotify review, then playlists, same as normal.</p>
      <input id="all-shows-filter" placeholder="Filter by date or venue..." style="margin-bottom:10px;" />
      <div id="all-shows-list"></div>
    </div>
  `;
  document.getElementById('sync-btn').onclick = async () => {
    const statusEl = document.getElementById('sync-status');
    statusEl.textContent = 'Syncing...';
    try {
      const r = await api('/api/sync', { method: 'POST' });
      await renderSync(); // refresh the list first — grabbing a fresh status element after, since the old one just got replaced
      const freshStatusEl = document.getElementById('sync-status');
      if (r.newShows === 0) {
        showModal('No new shows detected.');
      } else {
        freshStatusEl.textContent = `Found ${r.newShows} new show(s).`;
      }
    } catch (e) { statusEl.textContent = e.message; }
  };
  app.querySelectorAll('[data-show]').forEach(btn => {
    btn.onclick = () => { wizardShowId = Number(btn.dataset.show); wizardStage = btn.dataset.stage; renderWizard(); };
  });
  document.getElementById('gapcheck-btn').onclick = async (e) => {
    e.target.disabled = true;
    try { await runGapCheck(); } finally { e.target.disabled = false; }
  };
  wireAllShowsBrowser();
}

async function runGapCheck() {
  const resultsEl = document.getElementById('gapcheck-results');
  resultsEl.innerHTML = '<p class="muted">Starting...</p>';
  let excludeIds = [];
  let totalAutoMarked = 0;
  let allAdditions = [];
  let totalNoCandidates = 0;
  try {
    while (true) {
      const r = await api(`/api/spotify/gap-check?excludeIds=${excludeIds.join(',')}`);
      totalAutoMarked += r.autoMarked;
      allAdditions = allAdditions.concat(r.needsAddition);
      totalNoCandidates += r.noCandidates;
      excludeIds = excludeIds.concat(r.attemptedIds);
      if (r.stoppedEarly) {
        const isQuota = /QUOTA_EXCEEDED/i.test(r.searchErrorMessage || '');
        const guidance = isQuota
          ? "Spotify's daily usage limit for this app has been used up — this isn't something reconnecting fixes. It resets on its own; try again in a few hours or tomorrow."
          : 'This usually means the Spotify connection needs to be redone (Settings → Connect Spotify).';
        resultsEl.innerHTML = `<p class="error">Stopped — Spotify search is failing repeatedly: ${r.searchErrorMessage || 'unknown error'}. ${guidance} Checked ${fmt(r.processed)} songs before stopping; ${fmt(totalAutoMarked)} matched, ${fmt(totalNoCandidates)} had no Spotify match.</p>`;
        return;
      }
      resultsEl.innerHTML = `<p class="muted">Checked ${fmt(r.processed)} of ${fmt(r.total)} songs...</p>`;
      if (r.done) break;
    }
  } catch (e) { resultsEl.innerHTML = `<p class="error">${e.message}</p>`; return; }

  const parts = [];
  if (totalAutoMarked) parts.push(`<p class="success">${fmt(totalAutoMarked)} song(s) were already in the right playlist — dataset updated, nothing to add.</p>`);
  if (!allAdditions.length) {
    if (!totalAutoMarked) parts.push(`<p class="muted">Nothing missing (${fmt(totalNoCandidates)} songs had no Spotify match at all — check these manually if that seems wrong).</p>`);
    resultsEl.innerHTML = parts.join('');
    return;
  }
  parts.push(`<div id="gap-additions">${allAdditions.map(a => `
    <div class="song-row" data-gap-song="${a.songId}">
      <img class="art" src="${a.track.albumArtUrl || ''}" />
      <div style="flex:1;min-width:0;">
        <div>${a.title} — ${a.artist}</div>
        <div class="muted">${a.track.albumName} &middot; will add to: ${a.targets.join(', ')}</div>
      </div>
      <button class="btn danger" data-gap-drop="${a.songId}">Skip</button>
    </div>
  `).join('')}</div>
  <button class="btn" id="apply-gap-additions-btn" style="margin-top:10px;">Add ${fmt(allAdditions.length)} song(s) to playlists</button>`);
  resultsEl.innerHTML = parts.join('');

  const skipped = new Set();
  resultsEl.querySelectorAll('[data-gap-drop]').forEach(btn => btn.onclick = () => {
    skipped.add(Number(btn.dataset.gapDrop));
    btn.closest('.song-row').style.opacity = '0.3';
    btn.disabled = true;
  });
  document.getElementById('apply-gap-additions-btn').onclick = async () => {
    const additions = allAdditions.filter(a => !skipped.has(a.songId));
    try {
      const applied = await api('/api/spotify/gap-check/apply', { method: 'POST', body: { additions } });
      resultsEl.innerHTML = `<p class="success">Added ${applied.added} song(s).</p>`;
      renderSync();
    } catch (e) { showModal(e.message, { title: 'Error' }); }
  };
}



async function wireAllShowsBrowser() {
  const listEl = document.getElementById('all-shows-list');
  const filterEl = document.getElementById('all-shows-filter');
  let shows = await api('/api/shows/all');
  let attendedSet = new Set();
  let attendedError = null;
  async function loadAttended(force) {
    try {
      const r = await api(`/api/setlistfm/attended-ids${force ? '?force=true' : ''}`);
      attendedSet = new Set(r.ids);
      attendedError = r.error;
    } catch (e) { attendedError = e.message; }
  }
  await loadAttended(false);

  function artistBadge(a) {
    if (!a.setlistfm_url) {
      return `
        <div style="margin:4px 0;">
          <span class="muted" style="font-size:12px;">${a.artist}:</span>
          <button class="btn secondary" data-search-inline="${a.id}" data-search-date="" data-search-artist="${a.artist}" style="font-size:11px;padding:2px 8px;">search setlist.fm</button>
          <div id="inline-search-${a.id}"></div>
        </div>`;
    }
    // Real check first — this is the source of truth. The local flag only
    // matters as a fallback for a case the real check somehow misses.
    const reallyMarked = a.setlistfm_id && attendedSet.has(a.setlistfm_id);
    if (reallyMarked || a.marked_attended) {
      return `<div style="margin:4px 0;"><span class="muted" style="font-size:12px;">${a.artist}:</span> <span class="pill win" style="font-size:11px;">&check; I Was There</span> <button class="btn secondary" data-undo-marked="${a.id}" style="font-size:10px;padding:2px 6px;">Undo</button></div>`;
    }
    return `
      <div style="margin:4px 0;">
        <span class="muted" style="font-size:12px;">${a.artist}:</span>
        <a href="${a.setlistfm_url}" target="_blank" class="pill" style="font-size:11px;">Setlist Attendance</a>
        <button class="btn secondary" data-recheck-attended style="font-size:10px;padding:2px 6px;">Refresh Setlist Attendance</button>
        <button class="btn secondary" data-confirm-marked="${a.id}" style="font-size:10px;padding:2px 6px;" title="Only use this if the check above genuinely isn't picking it up">Mark as Attended (Override)</button>
      </div>`;
  }

  function draw(filterText) {
    const q = (filterText || '').toLowerCase();
    const rows = shows.filter(s => !q || s.venue.toLowerCase().includes(q) || new Date(s.date).toLocaleDateString().includes(q));
    listEl.innerHTML = (attendedError ? `<p class="error" style="font-size:12px;">setlist.fm check: ${attendedError}</p>` : '') + (rows.slice(0, 100).map(s => `
      <div style="border-bottom:1px solid var(--line);padding:8px 0;" data-show-block="${s.id}">
        <div>${new Date(s.date).toLocaleDateString()} — ${s.venue}${s.headliner ? ` (${s.headliner})` : ''} <span class="muted">(${s.stage})</span></div>
        ${s.artists.map(artistBadge).join('')}
        <button class="btn secondary" data-edit-show="${s.id}" style="margin-top:4px;">Edit</button>
        <button class="btn danger" data-delete-show="${s.id}" style="margin-top:4px;">Delete</button>
      </div>
    `).join('') || '<p class="muted">No matches.</p>');

    listEl.querySelectorAll('[data-edit-show]').forEach(btn => btn.onclick = () => {
      wizardShowId = Number(btn.dataset.editShow); wizardStage = 'tag'; renderWizard();
    });

    listEl.querySelectorAll('[data-delete-show]').forEach(btn => btn.onclick = async () => {
      const show = shows.find(s => s.id === Number(btn.dataset.deleteShow));
      const label = show ? `${new Date(show.date).toLocaleDateString()} — ${show.venue}${show.headliner ? ` (${show.headliner})` : ''}` : 'this show';
      if (!confirm(`Permanently delete ${label}? This removes all its songs, artists, and companion data. This can't be undone.`)) return;
      try {
        await api(`/api/shows/${btn.dataset.deleteShow}`, { method: 'DELETE' });
        shows = await api('/api/shows/all');
        draw(filterEl.value);
      } catch (e) { showModal(e.message, { title: 'Error' }); }
    });

    listEl.querySelectorAll('[data-recheck-attended]').forEach(btn => btn.onclick = async () => {
      btn.textContent = 'checking...';
      await loadAttended(true);
      draw(filterEl.value);
    });

    listEl.querySelectorAll('[data-confirm-marked]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/show-artists/${btn.dataset.confirmMarked}/mark-attended`, { method: 'POST' });
        shows = await api('/api/shows/all');
        draw(filterEl.value);
      } catch (e) { showModal(e.message, { title: 'Error' }); btn.disabled = false; }
    });

    listEl.querySelectorAll('[data-undo-marked]').forEach(btn => btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/show-artists/${btn.dataset.undoMarked}/unmark-attended`, { method: 'POST' });
        shows = await api('/api/shows/all');
        draw(filterEl.value);
      } catch (e) { showModal(e.message, { title: 'Error' }); btn.disabled = false; }
    });

    listEl.querySelectorAll('[data-search-inline]').forEach(btn => btn.onclick = () => {
      const showArtistId = btn.dataset.searchInline;
      const box = document.getElementById(`inline-search-${showArtistId}`);
      box.innerHTML = `
        <div class="row" style="padding:6px 0;">
          <input class="inline-sfm-name" value="${btn.dataset.searchArtist}" style="max-width:180px;" />
          <input class="inline-sfm-date" type="date" value="${btn.dataset.searchDate}" style="max-width:150px;" title="Clear this to search without a date filter" />
          <button class="btn secondary" data-run-inline-search="${showArtistId}">Search</button>
        </div>
        <div id="inline-results-${showArtistId}"></div>
      `;
      box.querySelector('[data-run-inline-search]').onclick = async () => {
        const name = box.querySelector('.inline-sfm-name').value.trim();
        const dateVal = box.querySelector('.inline-sfm-date').value; // may be empty — that's the point
        const resultsEl = document.getElementById(`inline-results-${showArtistId}`);
        resultsEl.innerHTML = '<p class="muted">Searching...</p>';
        try {
          const candidates = await api('/api/setlistfm/search', { method: 'POST', body: { artistName: name, date: dateVal || null } });
          if (!candidates.length) { resultsEl.innerHTML = '<p class="muted">No results. Try clearing the date, or check the spelling matches setlist.fm exactly.</p>'; return; }
          resultsEl.innerHTML = candidates.map(c => `
            <div class="row" style="justify-content:space-between;padding:3px 0;">
              <span class="muted" style="font-size:12px;">${c.date} — ${c.venue}, ${c.city}${c.tour ? ` (${c.tour})` : ''}</span>
              <button class="btn secondary" data-pick-inline="${c.id}" style="font-size:11px;padding:2px 8px;">Use this</button>
            </div>
          `).join('');
          resultsEl.querySelectorAll('[data-pick-inline]').forEach(pickBtn => pickBtn.onclick = async () => {
            pickBtn.disabled = true;
            pickBtn.textContent = 'Saving...';
            try {
              await api('/api/setlistfm/manual-match/apply', { method: 'POST', body: { showArtistId: Number(showArtistId), setlistId: pickBtn.dataset.pickInline } });
              resultsEl.innerHTML = '<p class="success">Saved — updating list...</p>';
              shows = await api('/api/shows/all');
              draw(filterEl.value);
            } catch (e) { showModal(e.message, { title: 'Error' }); pickBtn.disabled = false; pickBtn.textContent = 'Use this'; }
          });
        } catch (e) { resultsEl.innerHTML = `<p class="error">${e.message}</p>`; }
      };
    });
  }
  draw('');
  filterEl.oninput = () => draw(filterEl.value);
}

// ---------------- Wizard: tag -> spotify review -> playlist submit ----------------
let wizardOriginalStage = null;

async function renderWizard() {
  const show = await api(`/api/shows/${wizardShowId}`);
  if (wizardOriginalStage === null) wizardOriginalStage = show.stage;
  if (wizardStage === 'tag') return renderTagStage(show);
  if (wizardStage === 'spotify') return renderSpotifyStage(show);
  if (wizardStage === 'playlist') return renderPlaylistStage(show);
}

function exitWizard() { wizardShowId = null; wizardStage = null; wizardOriginalStage = null; activeTab = 'sync'; renderTab(); }

function toggleYesNoPill(p) {
  const nowOn = !p.classList.contains('on');
  p.classList.toggle('on', nowOn);
  p.textContent = nowOn ? 'Yes' : 'No';
}

function refreshRowControls(table) {
  const rows = [...table.querySelectorAll('tr[data-song-row]')];
  rows.forEach((tr, i) => {
    tr.querySelector('.order-num').textContent = i + 1;
    tr.querySelector('[data-move-up]').disabled = i === 0;
    tr.querySelector('[data-move-down]').disabled = i === rows.length - 1;
  });
}
async function persistOrder(table) {
  const orderedShowSongIds = [...table.querySelectorAll('tr[data-song-row]')].map(tr => Number(tr.dataset.songRow));
  const artistId = table.dataset.artistTable;
  try { await api(`/api/show-artists/${artistId}/reorder`, { method: 'POST', body: { orderedShowSongIds } }); }
  catch (e) { showModal(e.message, { title: 'Error' }); }
}
// Plain global functions invoked via each button's own inline onclick
// attribute — deliberately not relying on any addEventListener wiring step
// or event-delegation/closest() timing, so there's nothing that can go
// stale or fail to attach. window.moveSongUp/Down exist the instant the
// script loads, and the button's onclick="" references them directly.
window.moveSongUp = function (id) {
  const tr = document.querySelector(`tr[data-song-row="${id}"]`);
  if (!tr) return;
  const table = tr.closest('table[data-artist-table]');
  const prev = tr.previousElementSibling;
  if (table && prev && prev.dataset && prev.dataset.songRow) {
    tr.parentNode.insertBefore(tr, prev);
    refreshRowControls(table);
    persistOrder(table);
  }
};
window.moveSongDown = function (id) {
  const tr = document.querySelector(`tr[data-song-row="${id}"]`);
  if (!tr) return;
  const table = tr.closest('table[data-artist-table]');
  const next = tr.nextElementSibling;
  if (table && next && next.dataset && next.dataset.songRow) {
    tr.parentNode.insertBefore(next, tr);
    refreshRowControls(table);
    persistOrder(table);
  }
};

async function renderTagStage(show) {
  const companions = await api('/api/companions');
  const allSongs = show.artists.flatMap(a => a.songs.map(s => ({ ...s, artistName: a.artist })));
  const companionIds = new Set(show.companions.map(c => c.id));

  app.innerHTML = `
    <button class="btn secondary" id="back-btn" style="margin-bottom:14px;">&larr; Back to Sync</button> <button class="btn danger" id="cancel-review-btn" style="margin-bottom:14px;">${wizardOriginalStage === 'complete' ? 'Cancel (restore to complete)' : 'Cancel review'}</button>
    <div class="card">
      <h2>Tag songs — ${new Date(show.date).toLocaleDateString()} · ${show.venue}</h2>
      ${show.artists.map(a => `
        <div style="margin-bottom:14px;">
          <div style="font-weight:500;margin-bottom:6px;">${a.artist}</div>
          ${a.setlist_source && a.setlist_source !== 'setlist.fm' ? `<p class="muted" style="margin-bottom:6px;">Source: ${a.setlist_source}</p>` : ''}
          ${a.diff && a.diff.hasChanges ? `
            <div class="muted" style="margin-bottom:8px;padding:8px 10px;background:var(--surface-2);border-radius:6px;">
              Changed from the original pull:
              ${a.diff.added.length ? ` added ${a.diff.added.join(', ')}.` : ''}
              ${a.diff.removed.length ? ` removed ${a.diff.removed.join(', ')}.` : ''}
              ${a.diff.reordered ? ` song order changed.` : ''}
            </div>
          ` : ''}
          <div class="row" style="margin-bottom:8px;">
            <button class="btn secondary" data-fillgap="${a.id}" data-artist="${a.artist}">Replace set from another show</button>
            <input id="new-song-${a.id}" placeholder="Song title..." style="max-width:220px;" />
            <button class="btn secondary" data-add-song="${a.id}">Add song</button>
          </div>
          <table data-artist-table="${a.id}">
            <tr><th>#</th><th>Song</th><th>Cover</th><th>Known</th><th>Status</th><th>Regret-eligible</th><th></th></tr>
            ${a.songs.map((s, i) => `
              <tr data-song-row="${s.id}">
                <td style="white-space:nowrap;">
                  <button class="btn secondary" data-move-up onclick="moveSongUp(${s.id})" style="padding:2px 6px;font-size:11px;" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
                  <button class="btn secondary" data-move-down onclick="moveSongDown(${s.id})" style="padding:2px 6px;font-size:11px;" ${i === a.songs.length - 1 ? 'disabled' : ''}>&darr;</button>
                  <span class="order-num">${s.play_order}</span>
                </td>
                <td>${s.title}</td>
                <td>${s.is_cover ? '<span class="pill">cover</span>' : ''}</td>
                <td><span class="pill known-pill ${s.known ? 'on' : ''}" data-toggle="known">${s.known ? 'Yes' : 'No'}</span></td>
                <td>
                  <select class="status-select">
                    <option value="seen" ${s.status === 'seen' || !s.status ? 'selected' : ''}>Seen</option>
                    <option value="missed" ${s.status === 'missed' ? 'selected' : ''}>Missed</option>
                    <option value="skipped" ${s.status === 'skipped' ? 'selected' : ''}>Chose not to see</option>
                  </select>
                </td>
                <td><span class="pill liked-pill ${s.liked_now ? 'on' : ''}" data-toggle="liked">${s.liked_now ? 'Yes' : 'No'}</span></td>
                <td><button class="btn danger" data-remove-song="${s.id}" style="padding:4px 8px;font-size:11px;">Remove</button></td>
              </tr>
            `).join('')}
          </table>
        </div>
      `).join('')}
    </div>
    <div class="card">
      <h2>Who came with you</h2>
      <div class="row" id="companion-pills">
        ${companions.map(c => `<span class="pill ${companionIds.has(c.id) ? 'on' : ''}" data-companion="${c.id}">${c.name}</span>`).join('')}
        <input id="new-companion" placeholder="Add someone new + Enter" style="width:180px;" />
      </div>
    </div>
    <div class="card">
      <h2>Traveled from</h2>
      <input id="origin-input" value="${show.origin_address || ''}" />
    </div>
    <button class="btn" id="save-tag-btn">Save and continue to Spotify review</button>
    <div class="error" id="tag-err"></div>
  `;

  document.getElementById('back-btn').onclick = exitWizard;
  document.getElementById('cancel-review-btn').onclick = async () => {
    const restoreMsg = wizardOriginalStage === 'complete' ? "This show was already complete before you started editing — cancel and restore it to complete (any edits you made this session are kept, but it won't sit \"in progress\" anymore)?" : "Cancel and put this show back where it was before you started this session? Anything already saved stays as-is.";
    if (!confirm(restoreMsg)) return;
    try {
      await api(`/api/shows/${wizardShowId}/reset-stage`, { method: 'POST', body: { stage: wizardOriginalStage } });
      exitWizard();
    } catch (e) { showModal(e.message, { title: 'Error' }); }
  };
  app.querySelectorAll('.pill[data-toggle]').forEach(p => p.onclick = () => toggleYesNoPill(p));
  app.querySelectorAll('.pill[data-companion]').forEach(p => p.onclick = () => p.classList.toggle('on'));
  app.querySelectorAll('[data-fillgap]').forEach(btn => btn.onclick = () => openFillGap(btn.dataset.fillgap, btn.dataset.artist));

  app.querySelectorAll('[data-add-song]').forEach(btn => btn.onclick = async () => {
    const input = document.getElementById(`new-song-${btn.dataset.addSong}`);
    const title = input.value.trim();
    if (!title) return;
    btn.disabled = true;
    try {
      const r = await api(`/api/show-artists/${btn.dataset.addSong}/add-song`, { method: 'POST', body: { title } });
      const table = document.querySelector(`table[data-artist-table="${btn.dataset.addSong}"]`);
      const tr = document.createElement('tr');
      tr.dataset.songRow = r.showSongId;
      tr.innerHTML = `
        <td style="white-space:nowrap;">
          <button class="btn secondary" data-move-up onclick="moveSongUp(${r.showSongId})" style="padding:2px 6px;font-size:11px;">&uarr;</button>
          <button class="btn secondary" data-move-down onclick="moveSongDown(${r.showSongId})" style="padding:2px 6px;font-size:11px;" disabled>&darr;</button>
          <span class="order-num">${r.playOrder}</span>
        </td>
        <td>${r.title}</td><td></td>
        <td><span class="pill known-pill" data-toggle="known">No</span></td>
        <td><select class="status-select"><option value="seen" selected>Seen</option><option value="missed">Missed</option><option value="skipped">Chose not to see</option></select></td>
        <td><span class="pill liked-pill" data-toggle="liked">No</span></td>
        <td><button class="btn danger" data-remove-song="${r.showSongId}" style="padding:4px 8px;font-size:11px;">Remove</button></td>
      `;
      table.appendChild(tr);
      refreshRowControls(table);
      tr.querySelectorAll('.pill[data-toggle]').forEach(p => p.onclick = () => toggleYesNoPill(p));
      tr.querySelector('[data-remove-song]').onclick = async () => {
        if (!confirm('Remove this song from the dataset? This can\'t be undone.')) return;
        try { await api(`/api/show-songs/${r.showSongId}/remove`, { method: 'POST' }); tr.remove(); refreshRowControls(table); }
        catch (e) { alert(e.message); }
      };
      input.value = '';
    } catch (e) { showModal(e.message, { title: 'Error' }); }
    btn.disabled = false;
  });
  app.querySelectorAll('[data-remove-song]').forEach(btn => btn.onclick = async () => {
    if (!confirm('Remove this song from the dataset? This can\'t be undone.')) return;
    try {
      await api(`/api/show-songs/${btn.dataset.removeSong}/remove`, { method: 'POST' });
      const table = btn.closest('table');
      btn.closest('tr').remove();
      refreshRowControls(table);
    } catch (e) { alert(e.message); }
  });

  const newCompanionInput = document.getElementById('new-companion');
  const pendingNewCompanions = [];
  newCompanionInput.onkeydown = e => {
    if (e.key === 'Enter' && newCompanionInput.value.trim()) {
      const name = newCompanionInput.value.trim();
      pendingNewCompanions.push(name);
      const pill = document.createElement('span');
      pill.className = 'pill on';
      pill.textContent = name;
      document.getElementById('companion-pills').insertBefore(pill, newCompanionInput);
      newCompanionInput.value = '';
    }
  };

  document.getElementById('save-tag-btn').onclick = async () => {
    const songs = [...app.querySelectorAll('[data-song-row]')].map(row => ({
      showSongId: Number(row.dataset.songRow),
      known: row.querySelector('.known-pill').classList.contains('on'),
      status: row.querySelector('.status-select').value,
      likedNow: row.querySelector('.liked-pill').classList.contains('on'),
    }));
    const companionIdsChecked = [...app.querySelectorAll('.pill[data-companion].on')].map(p => Number(p.dataset.companion));
    try {
      await api(`/api/shows/${show.id}/tag`, { method: 'POST', body: {
        songs, companionIds: companionIdsChecked, newCompanionNames: pendingNewCompanions,
        originAddress: document.getElementById('origin-input').value,
      }});
      wizardStage = 'spotify';
      renderWizard();
    } catch (e) { document.getElementById('tag-err').textContent = e.message; }
  };
}

async function openFillGap(showArtistId, artistName) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:520px;text-align:left;max-height:80vh;overflow-y:auto;">
      <h2>Replace ${artistName}'s set with another show's</h2>
      <p class="muted" style="margin-top:-8px;">This fully replaces the current set — any known/status/regret flags already set on it will be lost.</p>
      <div id="fillgap-list"><p class="muted">Searching setlist.fm...</p></div>
      <button class="btn danger" id="close-fillgap" style="margin-top:14px;">Cancel</button>
    </div>
  `;
  document.body.appendChild(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('#close-fillgap').onclick = closeModal;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  let results = [];
  try {
    results = await api(`/api/shows/${wizardShowId}/fill-gap/search`, { method: 'POST', body: { artistName } });
  } catch (e) {
    modal.querySelector('#fillgap-list').innerHTML = `<p class="error">${e.message}</p>`;
    return;
  }
  const listEl = modal.querySelector('#fillgap-list');
  listEl.innerHTML = results.slice(0, 8).map(r => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
    <span>${r.date} — ${r.venue}, ${r.city} (${r.songCount} songs)</span>
    <button class="btn secondary" data-apply-setlist="${r.id}">Use this</button>
  </div>`).join('') || '<p class="muted">No results.</p>';
  listEl.querySelectorAll('[data-apply-setlist]').forEach(btn => btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Applying...';
    try {
      await api(`/api/shows/${wizardShowId}/fill-gap/apply`, { method: 'POST', body: { setlistId: btn.dataset.applySetlist, showArtistId: Number(showArtistId), artistName } });
      closeModal();
      renderWizard();
    } catch (e) { showModal(e.message, { title: 'Error' }); btn.disabled = false; btn.textContent = 'Use this'; }
  });
}

async function renderSpotifyStage(show) {
  const review = await api(`/api/shows/${show.id}/spotify-review`);
  app.innerHTML = `
    <button class="btn secondary" id="back-btn" style="margin-bottom:14px;">&larr; Back to Sync</button> <button class="btn danger" id="cancel-review-btn" style="margin-bottom:14px;">${wizardOriginalStage === 'complete' ? 'Cancel (restore to complete)' : 'Cancel review'}</button>
    <div class="card">
      <h2>Review Spotify matches</h2>
      ${review.map(r => renderMatchRow(r)).join('')}
      <button class="btn" id="continue-playlist-btn" style="margin-top:14px;">Continue to playlists</button>
      <div class="error" id="spotify-err"></div>
    </div>
  `;
  document.getElementById('back-btn').onclick = exitWizard;
  document.getElementById('cancel-review-btn').onclick = async () => {
    const restoreMsg = wizardOriginalStage === 'complete' ? "This show was already complete before you started editing — cancel and restore it to complete (any edits you made this session are kept, but it won't sit \"in progress\" anymore)?" : "Cancel and put this show back where it was before you started this session? Anything already saved stays as-is.";
    if (!confirm(restoreMsg)) return;
    try {
      await api(`/api/shows/${wizardShowId}/reset-stage`, { method: 'POST', body: { stage: wizardOriginalStage } });
      exitWizard();
    } catch (e) { showModal(e.message, { title: 'Error' }); }
  };

  review.forEach(r => {
    const rowEl = document.getElementById(`match-${r.songId}`);
    if (!rowEl) return;
    rowEl.querySelectorAll('[data-select-track]').forEach(b => b.onclick = () => {
      const candidate = candidateStore[b.dataset.candidateKey];
      rowEl.dataset.decision = JSON.stringify({ action: 'select', track: candidate });
      applyRowSelection(r.songId, candidate);
    });
    const excludeBtn = rowEl.querySelector('[data-exclude]');
    if (excludeBtn) excludeBtn.onclick = () => {
      rowEl.dataset.decision = JSON.stringify({ action: 'exclude' });
      document.getElementById(`meta-${r.songId}`).innerHTML = `${r.artist} &middot; excluded`;
      document.getElementById(`actions-${r.songId}`).innerHTML = `<div class="muted" style="margin-left:50px;">Excluded <button class="btn secondary" data-manual-search style="margin-left:8px;">Change</button></div>`;
      document.getElementById(`actions-${r.songId}`).querySelector('[data-manual-search]').onclick = () => openManualSpotifySearch(r, rowEl);
    };
    const searchBtn = rowEl.querySelector('[data-manual-search]');
    if (searchBtn) searchBtn.onclick = () => openManualSpotifySearch(r, rowEl);
    const removeBtn = rowEl.querySelector('[data-remove-from-dataset]');
    if (removeBtn) removeBtn.onclick = async () => {
      if (!confirm(`Remove "${r.title}" from this show's dataset? This can't be undone.`)) return;
      try {
        for (const id of (r.showSongIds || [])) {
          await api(`/api/show-songs/${id}/remove`, { method: 'POST' });
        }
        rowEl.remove();
      } catch (e) { alert(e.message); }
    };
  });

  document.getElementById('continue-playlist-btn').onclick = async () => {
    const decisions = [];
    review.forEach(r => {
      const rowEl = document.getElementById(`match-${r.songId}`);
      if (!rowEl) return; // removed from the dataset above — nothing to decide on
      const raw = rowEl.dataset.decision;
      if (raw) decisions.push({ songId: r.songId, ...JSON.parse(raw) });
      else if (r.status === 'pending' && r.suggested) decisions.push({ songId: r.songId, action: 'approve', track: r.suggested });
    });
    try {
      await api(`/api/shows/${show.id}/spotify-review`, { method: 'POST', body: { decisions } });
      wizardStage = 'playlist';
      renderWizard();
    } catch (e) { document.getElementById('spotify-err').textContent = e.message; }
  };
}

function renderMatchRow(r) {
  const candidates = r.status === 'pending' ? (r.candidates || []) : [];
  const current = r.current;
  const noMatchText = r.searchError ? `search failed: ${r.searchError}` : (r.status === 'assumed_added' ? 'not yet tied to a Spotify track — run "Spotify gaps check" on the Sync page' : 'no match found');
  const statusLabel = r.status === 'excluded' ? 'Excluded'
    : r.status === 'assumed_added' && !current ? 'Marked as already on Spotify, but not yet resolved'
    : 'Already resolved';
  return `
    <div id="match-${r.songId}" style="margin-bottom:12px;">
      <div class="song-row">
        <img class="art" id="art-${r.songId}" src="${(current && current.albumArtUrl) || (r.suggested && r.suggested.albumArtUrl) || ''}" />
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;">${r.title}</div>
          <div class="muted" id="meta-${r.songId}">${r.artist} ${current ? `&middot; ${current.albumName || ''}` : r.suggested ? `&middot; ${r.suggested.albumName}` : `&middot; ${noMatchText}`}</div>
        </div>
      </div>
      <div id="actions-${r.songId}">
        ${r.status === 'pending' ? `
          <div class="row" style="margin:6px 0 0 50px;">
            ${candidates.slice(0, 3).map(c => `<button class="btn secondary" data-candidate-key="${stashCandidate(c)}" data-select-track>${c.albumName}</button>`).join('')}
            <button class="btn danger" data-exclude>Exclude</button>
            <button class="btn secondary" data-manual-search>Search Spotify</button>
            <button class="btn danger" data-remove-from-dataset>Remove from dataset</button>
          </div>
        ` : `<div class="muted" style="margin-left:50px;">${statusLabel} <button class="btn secondary" data-manual-search style="margin-left:8px;">Change</button> <button class="btn danger" data-remove-from-dataset style="margin-left:8px;">Remove from dataset</button></div>`}
      </div>
      <div id="manual-search-${r.songId}"></div>
    </div>
  `;
}

// Updates a match row's art/text in place and collapses its action area to
// a simple "Selected — Change" state, so picking a track actually looks
// like something happened instead of just a green confirmation line.
function applyRowSelection(songId, track) {
  document.getElementById(`art-${songId}`).src = track.albumArtUrl || '';
  document.getElementById(`meta-${songId}`).innerHTML = `${track.artist} &middot; ${track.albumName}`;
  document.getElementById(`manual-search-${songId}`).innerHTML = '';
  document.getElementById(`actions-${songId}`).innerHTML = `<div class="muted" style="margin-left:50px;">Selected: ${track.name} <button class="btn secondary" data-manual-search style="margin-left:8px;">Change</button></div>`;
  document.getElementById(`actions-${songId}`).querySelector('[data-manual-search]').onclick = () => openManualSpotifySearch({ songId, title: track.name, artist: track.artist }, document.getElementById(`match-${songId}`));
}

async function openManualSpotifySearch(r, rowEl) {
  const box = document.getElementById(`manual-search-${r.songId}`);
  box.innerHTML = `
    <div class="row" style="margin:8px 0 0 50px;">
      <input id="ms-title-${r.songId}" placeholder="Song title" value="${r.title}" style="max-width:220px;" />
      <input id="ms-artist-${r.songId}" placeholder="Artist (optional)" value="${r.artist}" style="max-width:180px;" />
      <button class="btn secondary" id="ms-go-${r.songId}">Search Spotify</button>
    </div>
    <div id="ms-results-${r.songId}" style="margin-left:50px;"></div>
  `;
  document.getElementById(`ms-go-${r.songId}`).onclick = async () => {
    const resultsEl = document.getElementById(`ms-results-${r.songId}`);
    resultsEl.innerHTML = '<p class="muted">Searching...</p>';
    const query = document.getElementById(`ms-title-${r.songId}`).value;
    const artist = document.getElementById(`ms-artist-${r.songId}`).value;
    try {
      const results = await api('/api/spotify/search', { method: 'POST', body: { query, artist } });
      if (!results.length) { resultsEl.innerHTML = '<p class="muted">No results.</p>'; return; }
      resultsEl.innerHTML = results.slice(0, 8).map(c => `
        <div class="song-row" style="margin-top:6px;">
          <img class="art" src="${c.albumArtUrl || ''}" />
          <div style="flex:1;min-width:0;">
            <div>${c.name}</div>
            <div class="muted">${c.artist} &middot; ${c.albumName} ${c.albumType === 'live' || /live/i.test(c.albumName) ? '(live)' : ''}</div>
          </div>
          <button class="btn secondary" data-candidate-key="${stashCandidate(c)}" data-manual-pick>Use this</button>
        </div>
      `).join('');
      resultsEl.querySelectorAll('[data-manual-pick]').forEach(btn => btn.onclick = () => {
        const track = candidateStore[btn.dataset.candidateKey];
        rowEl.dataset.decision = JSON.stringify({ action: 'select', track });
        applyRowSelection(r.songId, track);
      });
    } catch (e) { resultsEl.innerHTML = `<p class="error">${e.message}</p>`; }
  };
}

async function renderPlaylistStage(show) {
  const preview = await api(`/api/shows/${show.id}/playlist-preview`);
  app.innerHTML = `
    <button class="btn secondary" id="back-btn" style="margin-bottom:14px;">&larr; Back to Sync</button> <button class="btn danger" id="cancel-review-btn" style="margin-bottom:14px;">${wizardOriginalStage === 'complete' ? 'Cancel (restore to complete)' : 'Cancel review'}</button>
    <div class="card">
      <h2>Ready to add to playlists</h2>
      ${preview.targets.map(t => `
        <div style="margin-bottom:14px;">
          <div style="font-weight:500;margin-bottom:6px;">${t.label}</div>
          ${preview.songs.map(s => `
            <div class="song-row" data-song="${s.show_song_id}">
              <img class="art" src="${s.spotify_album_art_url || ''}" />
              <div style="flex:1;">${s.title} — ${s.artist}</div>
              <button class="btn danger" data-drop="${s.show_song_id}">Drop</button>
            </div>
          `).join('')}
        </div>
      `).join('')}
      <div class="row" style="margin-top:14px;">
        <button class="btn" id="submit-playlists-btn">Add to playlists</button>
        <button class="btn secondary" id="skip-sync-btn">Save changes only, don't sync to Spotify</button>
      </div>
      <p class="muted" style="margin-top:6px;">The second option saves your dataset edits but leaves Spotify untouched — anything that ends up out of sync will show up under "Playlist updates needed" on the Sync page.</p>
      <div class="success" id="playlist-ok"></div>
      <div class="error" id="playlist-err"></div>
    </div>
  `;
  document.getElementById('back-btn').onclick = exitWizard;
  document.getElementById('cancel-review-btn').onclick = async () => {
    const restoreMsg = wizardOriginalStage === 'complete' ? "This show was already complete before you started editing — cancel and restore it to complete (any edits you made this session are kept, but it won't sit \"in progress\" anymore)?" : "Cancel and put this show back where it was before you started this session? Anything already saved stays as-is.";
    if (!confirm(restoreMsg)) return;
    try {
      await api(`/api/shows/${wizardShowId}/reset-stage`, { method: 'POST', body: { stage: wizardOriginalStage } });
      exitWizard();
    } catch (e) { showModal(e.message, { title: 'Error' }); }
  };
  const drops = new Set();
  app.querySelectorAll('[data-drop]').forEach(btn => btn.onclick = () => {
    drops.add(btn.dataset.drop);
    btn.closest('.song-row').style.opacity = '0.3';
    btn.disabled = true;
  });
  async function submit(skipSync) {
    try {
      const r = await api(`/api/shows/${show.id}/playlist-submit`, { method: 'POST', body: { drops: [...drops], skipSync } });
      document.getElementById('playlist-ok').textContent = skipSync ? 'Saved. Show complete — nothing was sent to Spotify.' : `Added ${r.added} songs. Show complete.`;
      setTimeout(exitWizard, 1200);
    } catch (e) { document.getElementById('playlist-err').textContent = e.message; }
  }
  document.getElementById('submit-playlists-btn').onclick = () => submit(false);
  document.getElementById('skip-sync-btn').onclick = () => submit(true);
}

// ---------------- Reports (Dashboard subtabs) ----------------

let chartTooltipEl = null;
function ensureTooltipEl() {
  if (!chartTooltipEl) {
    chartTooltipEl = document.createElement('div');
    chartTooltipEl.className = 'chart-tooltip';
    document.body.appendChild(chartTooltipEl);
  }
  return chartTooltipEl;
}

function barChartHtml(id, rows, labelFn) {
  const counts = rows.map(r => Number(r.shows));
  const max = Math.max(...counts, 1);
  return `
    <div class="bar-chart" id="${id}">
      ${rows.map(r => `
        <div class="bar-col" data-shows="${r.shows}" data-artists="${r.artists}" data-songs="${r.songs}" data-venues="${r.venues}" data-label="${labelFn(r.bucket)}">
          <div class="bar-datalabel">${r.shows}</div>
          <div class="bar" style="height:${Math.max(4, (Number(r.shows) / max) * 140)}px;"></div>
          <div class="bar-axislabel">${labelFn(r.bucket)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function wireBarChart(id) {
  const tip = ensureTooltipEl();
  document.querySelectorAll(`#${id} .bar-col`).forEach(col => {
    col.addEventListener('mouseenter', () => {
      tip.innerHTML = `<b>${col.dataset.label}</b><br>${col.dataset.shows} shows<br>${col.dataset.artists} unique artists<br>${col.dataset.songs} unique songs<br>${col.dataset.venues} unique venues`;
      tip.style.display = 'block';
    });
    col.addEventListener('mousemove', e => {
      tip.style.left = (e.pageX + 14) + 'px';
      tip.style.top = (e.pageY - 10) + 'px';
    });
    col.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

async function renderOverview() {
  const data = await api(`/api/report/overview${companionsQuery()}`);
  const t = data.totals;
  dashBody().innerHTML = `
    <div class="card">
      <h2>Overview</h2>
      <div class="stat-grid" style="margin-bottom:20px;">
        <div class="stat-tile"><div class="num">${fmt(t.shows)}</div><div class="label">Shows</div></div>
        <div class="stat-tile"><div class="num">${fmt(t.unique_artists)}</div><div class="label">Unique Artists</div></div>
        <div class="stat-tile"><div class="num">${fmt(t.unique_songs)}</div><div class="label">Unique songs</div></div>
        <div class="stat-tile"><div class="num">${t.pct_known || 0}%</div><div class="label">Known</div></div>
      </div>
      <div class="row" style="margin-bottom:12px;">
        <button class="btn secondary" id="expand-all-btn">⇊ Expand all</button>
        <button class="btn secondary" id="collapse-all-btn">⇈ Collapse all</button>
      </div>
      <table>
        <tr><th></th><th>Date</th><th>Headliner</th><th>Location</th><th>Traveled from</th></tr>
        ${data.shows.map(renderShowRow).join('')}
      </table>
    </div>
  `;
  wireExpanders();
  document.getElementById('expand-all-btn').onclick = () => {
    dashBody().querySelectorAll('.nested-block').forEach(b => b.classList.remove('hidden'));
    dashBody().querySelectorAll('[data-expand]').forEach(icon => icon.textContent = '−');
    updateExpandCollapseButtons();
  };
  document.getElementById('collapse-all-btn').onclick = () => {
    dashBody().querySelectorAll('.nested-block').forEach(b => b.classList.add('hidden'));
    dashBody().querySelectorAll('[data-expand]').forEach(icon => icon.textContent = '+');
    updateExpandCollapseButtons();
  };
  updateExpandCollapseButtons();
}

function updateExpandCollapseButtons() {
  const blocks = [...dashBody().querySelectorAll('.nested-block')];
  const expandBtn = document.getElementById('expand-all-btn');
  const collapseBtn = document.getElementById('collapse-all-btn');
  if (expandBtn) expandBtn.disabled = !blocks.some(b => b.classList.contains('hidden'));
  if (collapseBtn) collapseBtn.disabled = !blocks.some(b => !b.classList.contains('hidden'));
}

function renderShowRow(sh) {
  return `
    <tr class="show-row">
      <td><span class="expand-icon" data-expand="show-${sh.id}">+</span></td>
      <td>${new Date(sh.date).toLocaleDateString()}</td>
      <td>${sh.headliner}</td>
      <td>${sh.location}</td>
      <td>${sh.traveledFrom || '—'}</td>
    </tr>
    <tr class="nested-block hidden" id="block-show-${sh.id}"><td colspan="5">
      <table>
        <tr><th></th><th>Artist</th><th>Order</th><th>Songs</th><th>Known</th><th>Opener</th><th>Closer</th></tr>
        ${sh.artists.map(renderArtistRow).join('')}
      </table>
    </td></tr>
  `;
}

function renderArtistRow(a) {
  return `
    <tr class="artist-row">
      <td><span class="expand-icon" data-expand="artist-${a.showArtistId}">+</span></td>
      <td>${a.artist}</td>
      <td>${a.orderLabel}</td>
      <td>${a.songCount}</td>
      <td>${a.pctKnown}%</td>
      <td>${a.opener || '—'}</td>
      <td>${a.closer || '—'}</td>
    </tr>
    <tr class="nested-block hidden" id="block-artist-${a.showArtistId}"><td colspan="7">
      <table>
        <tr><th>Song</th><th>Known</th><th>Missed</th><th>Regret</th></tr>
        ${a.songs.map(s => `<tr><td>${s.title}</td><td>${s.known ? 'Yes' : 'No'}</td><td>${s.missed ? 'Yes' : 'No'}</td><td>${s.regret ? 'Yes' : 'No'}</td></tr>`).join('')}
      </table>
    </td></tr>
  `;
}

function wireExpanders() {
  app.querySelectorAll('[data-expand]').forEach(icon => {
    icon.onclick = () => {
      const block = document.getElementById(`block-${icon.dataset.expand}`);
      if (!block) return;
      const wasHidden = block.classList.contains('hidden');
      block.classList.toggle('hidden');
      icon.textContent = wasHidden ? '−' : '+';
      updateExpandCollapseButtons();
    };
  });
}

async function renderTrends() {
  const data = await api(`/api/report/trends${companionsQuery()}`);
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const wk = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  dashBody().innerHTML = `
    <div class="card"><h2>Shows by year</h2>${barChartHtml('chart-year', data.byYear, b => b)}</div>
    <div class="card"><h2>Shows by month</h2>${barChartHtml('chart-month', data.byMonth, b => monthNames[b - 1])}</div>
    <div class="card"><h2>Shows by season</h2>${barChartHtml('chart-season', data.bySeason, b => b)}</div>
    <div class="card"><h2>Shows by weekday</h2>${barChartHtml('chart-weekday', data.byWeekday, b => wk[b])}</div>
  `;
  ['chart-year', 'chart-month', 'chart-season', 'chart-weekday'].forEach(wireBarChart);
}

async function renderTravel() {
  const data = await api(`/api/report/travel${companionsQuery()}`);
  const hours = Math.round((data.totals.hours || 0) * 10) / 10;
  dashBody().innerHTML = `
    <div class="card">
      <h2>Travel</h2>
      <div class="stat-grid" style="margin-bottom:16px;">
        <div class="stat-tile"><div class="num">${fmt(Math.round(data.totals.miles || 0))}</div><div class="label">Total miles</div></div>
        <div class="stat-tile"><div class="num">${fmt(hours)}</div><div class="label">Total travel time (hrs)</div></div>
      </div>
    </div>
    <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap;">
      <div class="card" style="flex:1;min-width:280px;">
        <h2>Local shows (Georgia)</h2>
        <table>
          <tr><th>Venue</th><th>Shows seen</th></tr>
          ${data.local.map(v => `<tr><td>${v.venue}</td><td>${v.show_count}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}
        </table>
      </div>
      <div class="card" style="flex:1;min-width:280px;">
        <h2>Travel shows</h2>
        <table>
          <tr><th>Venue</th><th>City</th><th>State</th><th>Miles</th><th>Travel time</th><th>Bands</th></tr>
          ${data.travel.map(s => `<tr><td>${s.venue}</td><td>${s.city || '—'}</td><td>${s.state || '—'}</td><td>${s.distance_miles != null ? fmt(s.distance_miles) : '—'}</td><td>${s.duration_minutes != null ? (Math.round((s.duration_minutes / 60) * 10) / 10) + ' hrs' : '—'}</td><td>${s.bands || '—'}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}
        </table>
      </div>
    </div>
  `;
}

async function renderSuperlatives() {
  const data = await api(`/api/report/superlatives${companionsQuery()}`);
  dashBody().innerHTML = `
    <div class="card">
      <h2>Bands seen the most</h2>
      <table>
        <tr><th>Artist</th><th>Times seen</th><th>Song count</th><th>Headline %</th><th>Setlist variation %</th><th>Opener/closer variation %</th><th></th></tr>
        ${data.bandsSeenMost.map(r => `<tr><td>${r.artist}</td><td>${r.timesSeen}</td><td>${r.songCount}</td><td>${r.pctHeadline}%</td><td>${r.setlistVariationPct}%</td><td>${r.openCloseVariationPct}%</td><td><button class="btn secondary" data-drill="bands-seen" data-artist="${r.artist}" style="padding:2px 8px;">&rsaquo;</button></td></tr>`).join('')}
      </table>
    </div>
    <div class="card">
      <h2>Most songs played in a set</h2>
      <table>
        <tr><th>Date</th><th>Artist</th><th>Songs</th><th></th></tr>
        ${data.mostSongsInSet.map(r => `<tr><td>${new Date(r.date).toLocaleDateString()}</td><td>${r.artist}</td><td>${r.songCount}</td><td><button class="btn secondary" data-drill="set" data-date="${new Date(r.date).toISOString().slice(0,10)}" data-artist="${r.artist}" style="padding:2px 8px;">&rsaquo;</button></td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}
      </table>
    </div>
    <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap;">
      <div class="card" style="flex:1;min-width:280px;">
        <h2>Most new songs vs. the show before (repeat artists)</h2>
        <p class="muted" style="margin-bottom:8px;">Compares each show to that same artist's immediately preceding show — the biggest jump in new songs from one time to the next.</p>
        <table>
          <tr><th>Artist</th><th>Times seen</th><th>New songs in a set</th><th></th></tr>
          ${data.mostUniqueSongsRepeat.map(r => `<tr><td>${r.artist}</td><td>${r.timesSeen}</td><td>${r.newSongsInASet}</td><td><button class="btn secondary" data-drill="repeat-compare" data-artist="${r.artist}" style="padding:2px 8px;">&rsaquo;</button></td></tr>`).join('') || '<tr><td class="muted">Not enough repeat artists yet</td></tr>'}
        </table>
      </div>
      <div class="card" style="flex:1;min-width:280px;">
        <h2>Most opener/closer variation</h2>
        <p class="muted" style="margin-bottom:8px;">Limited to artists you've seen more than once.</p>
        <table>
          <tr><th>Artist</th><th>Times seen</th><th>Variation %</th><th></th></tr>
          ${data.mostOpenCloseVariation.map(r => `<tr><td>${r.artist}</td><td>${r.timesSeen}</td><td>${r.openCloseVariationPct}%</td><td><button class="btn secondary" data-drill="open-close" data-artist="${r.artist}" style="padding:2px 8px;">&rsaquo;</button></td></tr>`).join('') || '<tr><td class="muted">Not enough repeat artists yet</td></tr>'}
        </table>
      </div>
    </div>
  `;
  dashBody().querySelectorAll('[data-drill]').forEach(btn => btn.onclick = () => openSuperlativeDrilldown(btn.dataset.drill, btn.dataset.artist, btn.dataset.date));
}

function openDrilldownModal(title, bodyHtml) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width:600px;text-align:left;max-height:80vh;overflow-y:auto;">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h2 style="margin:0;">${title}</h2>
        <button class="btn secondary" id="close-drilldown" style="padding:4px 10px;">&times;</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#close-drilldown').onclick = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function openSuperlativeDrilldown(type, artist, date) {
  try {
    if (type === 'bands-seen') {
      const rows = await api(`/api/superlatives/drilldown/bands-seen/${encodeURIComponent(artist)}`);
      openDrilldownModal(`Every time you've seen ${artist}`, `<table><tr><th>Date</th><th>Venue</th><th>Headliner</th><th>Songs</th><th>Opener</th><th>Closer</th><th>Tour</th><th></th></tr>${rows.map(r => `<tr><td>${new Date(r.date).toLocaleDateString()}</td><td>${r.venue}, ${r.city}</td><td>${r.headliner || '—'}</td><td>${r.song_count}</td><td>${r.opener || '—'}</td><td>${r.closer || '—'}</td><td>${r.tour_name || '—'}</td><td>${r.setlistfm_url ? `<a href="${r.setlistfm_url}" target="_blank" style="color:var(--violet);">view</a>` : '—'}</td></tr>`).join('')}</table>`);
    } else if (type === 'set') {
      const rows = await api(`/api/superlatives/drilldown/set/${date}/${encodeURIComponent(artist)}`);
      openDrilldownModal(`${artist} — ${new Date(date).toLocaleDateString()}`, `<table><tr><th>#</th><th>Song</th><th>Known</th></tr>${rows.map(r => `<tr><td>${r.play_order}</td><td>${r.title}</td><td>${r.known ? 'Yes' : 'No'}</td></tr>`).join('')}</table>`);
    } else if (type === 'open-close') {
      const rows = await api(`/api/superlatives/drilldown/open-close/${encodeURIComponent(artist)}`);
      openDrilldownModal(`${artist} — openers &amp; closers`, `<table><tr><th>Date</th><th>Venue</th><th>Opener</th><th>Closer</th></tr>${rows.map(r => `<tr><td>${new Date(r.date).toLocaleDateString()}</td><td>${r.venue}</td><td>${r.opener}</td><td>${r.closer}</td></tr>`).join('')}</table>`);
    } else if (type === 'repeat-compare') {
      const d = await api(`/api/superlatives/drilldown/repeat-compare/${encodeURIComponent(artist)}`);
      if (!d) { openDrilldownModal(artist, '<p class="muted">Not enough data.</p>'); return; }
      const maxLen = Math.max(d.overlap.length, d.prevOnly.length, d.currOnly.length);
      const rows = [];
      for (let i = 0; i < maxLen; i++) {
        rows.push(`<tr><td>${d.overlap[i] || ''}</td><td>${i < d.overlap.length ? '' : (d.prevOnly[i - d.overlap.length] || '')}</td><td>${i < d.overlap.length ? '' : (d.currOnly[i - d.overlap.length] || '')}</td></tr>`);
      }
      openDrilldownModal(`${artist} — ${new Date(d.prevShow.date).toLocaleDateString()} vs ${new Date(d.currShow.date).toLocaleDateString()}`, `
        <p class="muted">Overlapping songs first, then each show's songs the other didn't have.</p>
        <table>
          <tr><th>Played both times</th><th>${d.prevShow.venue} only</th><th>${d.currShow.venue} only</th></tr>
          ${rows.join('')}
        </table>
      `);
    }
  } catch (e) { showModal(e.message, { title: 'Error' }); }
}

async function renderJourney() {
  const data = await api(`/api/report/journey${companionsQuery()}`);
  dashBody().innerHTML = `
    <div class="card">
      <h2>First 3 shows</h2>
      ${data.first.map(journeyShowCard).join('') || '<p class="muted">No shows yet.</p>'}
    </div>
    <div class="card">
      <h2>Latest 3 shows</h2>
      ${data.latest.map(journeyShowCard).join('') || '<p class="muted">No shows yet.</p>'}
    </div>
  `;
}

function journeyShowCard(sh) {
  return `
    <div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line);">
      <div style="font-weight:600;">${new Date(sh.date).toLocaleDateString()} — ${sh.venue}</div>
      <div class="muted" style="margin-bottom:6px;">${[sh.city, sh.state].filter(Boolean).join(', ')}</div>
      ${sh.artists.map(a => `<div class="muted" style="white-space:nowrap;overflow-x:auto;">${a.orderLabel}: <span style="color:var(--text);">${a.artist}</span> — Opener: ${a.opener || '—'} · Closer: ${a.closer || '—'}</div>`).join('')}
    </div>
  `;
}

async function renderUnknowns() {
  const data = await api(`/api/report/unknowns${companionsQuery()}`);
  const t = data.totals;
  dashBody().innerHTML = `
    <div class="card">
      <h2>Unknowns</h2>
      <div class="stat-grid" style="margin-bottom:16px;">
        <div class="stat-tile"><div class="num">${t.pct_known || 0}%</div><div class="label">Known</div></div>
        <div class="stat-tile"><div class="num">${t.pct_missed || 0}%</div><div class="label">Missed</div></div>
        <div class="stat-tile"><div class="num">${t.pct_skipped || 0}%</div><div class="label">Skipped</div></div>
        <div class="stat-tile"><div class="num">${fmt(t.regret_count || 0)}</div><div class="label">Regret</div></div>
      </div>
      <table>
        <tr><th>Date</th><th>Venue</th><th>Artist</th><th>Song</th><th>Regret</th></tr>
        ${data.songs.map(s => `<tr><td>${new Date(s.date).toLocaleDateString()}</td><td>${s.venue}</td><td>${s.artist}</td><td>${s.title}</td><td>${s.regret ? 'Yes' : 'No'}</td></tr>`).join('') || '<tr><td class="muted">None.</td></tr>'}
      </table>
    </div>
  `;
}

async function renderSpotifyGaps() {
  const data = await api(`/api/report/spotify-gaps${companionsQuery()}`);
  dashBody().innerHTML = `
    <div class="card">
      <h2>Spotify Gaps</h2>
      <p class="muted" style="margin-bottom:14px;">Songs you've seen live that never made it into a Spotify playlist — either from before the app (marked as not-on-Spotify in the historical import) or synced shows where no valid Spotify match was ever found (covers excluded).</p>
      <table>
        <tr><th>Artist</th><th>Song</th></tr>
        ${data.songs.map(s => `<tr><td>${s.artist}</td><td>${s.title}</td></tr>`).join('') || '<tr><td class="muted">None — everything made it in.</td></tr>'}
      </table>
    </div>
  `;
}

boot();
