let hostPw = sessionStorage.getItem('ct_pw') || null;
let activeTab = 'sync';
let wizardShowId = null;
let wizardStage = null; // 'tag' | 'spotify' | 'playlist'

let dashboardSubtab = 'overview'; // overview | trends | travel | superlatives | journey | unknowns
let selectedCompanionIds = new Set(); // empty == "All"
let allCompanions = [];

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
    <div class="card">
      <h2>Historical import</h2>
      <p class="muted">One-time: loads your 59 historical shows into the database. Safe to click more than once — already-imported shows are skipped.</p>
      <button class="btn secondary" id="import-btn">Run historical import</button>
      <div class="muted" id="import-status" style="margin-top:8px;"></div>
    </div>
    <button class="btn" id="save-settings-btn">Save settings</button>
    <div class="success" id="settings-ok"></div>
    <div class="card">
      <h2>Session</h2>
      <button class="btn danger" id="lock-btn">Lock app</button>
      <p class="muted" style="margin-top:8px;">Requires re-entering the host password to unlock.</p>
    </div>
  `;
  document.getElementById('import-btn').onclick = async () => {
    const statusEl = document.getElementById('import-status');
    statusEl.textContent = 'Importing — this can take a minute or two...';
    try {
      const r = await api('/api/import/historical', { method: 'POST' });
      statusEl.textContent = `Imported ${r.imported} shows (${r.skipped} already existed).`;
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

// ---------------- Sync ----------------
async function renderSync() {
  const [pending, needsPlaylistUpdate] = await Promise.all([
    api('/api/shows/pending'),
    api('/api/shows/needs-playlist-update'),
  ]);
  app.innerHTML = `
    <div class="card">
      <h2>Sync</h2>
      <button class="btn" id="sync-btn">Check for new shows</button>
      <div class="muted" id="sync-status" style="margin-top:8px;"></div>
    </div>
    <div class="card">
      <h2>Needs attention (${pending.length})</h2>
      ${pending.length ? pending.map(s => `
        <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0;">
          <div><b>${new Date(s.date).toLocaleDateString()}</b> — ${s.venue} <span class="muted">(${s.stage})</span></div>
          <button class="btn secondary" data-show="${s.id}" data-stage="${s.stage === 'new' ? 'tag' : s.stage === 'tagged' ? 'spotify' : 'playlist'}">Continue</button>
        </div>
      `).join('') : '<p class="muted">Nothing pending.</p>'}
    </div>
    <div class="card">
      <h2>Playlist updates needed (${needsPlaylistUpdate.length})</h2>
      <p class="muted" style="margin-bottom:10px;">Songs that are now matched on Spotify but haven't made it into their playlist(s) yet — usually because a match was found after the show was already marked complete.</p>
      ${needsPlaylistUpdate.length ? needsPlaylistUpdate.map(s => `
        <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0;">
          <div><b>${new Date(s.date).toLocaleDateString()}</b> — ${s.venue}</div>
          <button class="btn secondary" data-show="${s.id}" data-stage="playlist">Add to playlists</button>
        </div>
      `).join('') : '<p class="muted">Nothing pending.</p>'}
    </div>
    <div class="card">
      <h2>Recheck Spotify for excluded songs</h2>
      <p class="muted" style="margin-bottom:10px;">If a band releases an official version of a song after you saw it live, run this to see if it's findable now.</p>
      <button class="btn secondary" id="recheck-btn">Recheck excluded songs</button>
      <div id="recheck-results" style="margin-top:12px;"></div>
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
      if (r.newShows === 0) {
        statusEl.textContent = '';
        showModal('No new shows detected.');
      } else {
        statusEl.textContent = `Found ${r.newShows} new show(s).`;
      }
      renderSync();
    } catch (e) { statusEl.textContent = e.message; }
  };
  app.querySelectorAll('[data-show]').forEach(btn => {
    btn.onclick = () => { wizardShowId = Number(btn.dataset.show); wizardStage = btn.dataset.stage; renderWizard(); };
  });
  document.getElementById('recheck-btn').onclick = () => runSpotifyRecheck();
  wireAllShowsBrowser();
}

async function runSpotifyRecheck() {
  const resultsEl = document.getElementById('recheck-results');
  resultsEl.innerHTML = '<p class="muted">Searching Spotify for previously-excluded songs...</p>';
  try {
    const results = await api('/api/spotify/recheck-excluded');
    if (!results.length) { resultsEl.innerHTML = '<p class="muted">No new matches found.</p>'; return; }
    resultsEl.innerHTML = results.map(r => `
      <div id="recheck-${r.songId}" style="margin-bottom:10px;">
        <div class="muted" style="margin-bottom:4px;">${r.title} — ${r.artist}</div>
        <div class="row">
          ${r.candidates.map(c => `<button class="btn secondary" data-recheck-pick='${JSON.stringify({ songId: r.songId, track: c })}'>${c.albumName}</button>`).join('')}
          <button class="btn danger" data-recheck-skip="${r.songId}">Still not it</button>
        </div>
      </div>
    `).join('');
    resultsEl.querySelectorAll('[data-recheck-pick]').forEach(btn => btn.onclick = async () => {
      const { songId, track } = JSON.parse(btn.dataset.recheckPick);
      await api('/api/spotify/recheck-excluded/apply', { method: 'POST', body: { songId, track } });
      document.getElementById(`recheck-${songId}`).innerHTML = '<p class="success">Matched — check "Playlist updates needed" above.</p>';
      renderSync();
    });
    resultsEl.querySelectorAll('[data-recheck-skip]').forEach(btn => btn.onclick = () => {
      document.getElementById(`recheck-${btn.dataset.recheckSkip}`).remove();
    });
  } catch (e) { resultsEl.innerHTML = `<p class="error">${e.message}</p>`; }
}

async function wireAllShowsBrowser() {
  const listEl = document.getElementById('all-shows-list');
  const filterEl = document.getElementById('all-shows-filter');
  const shows = await api('/api/shows/all');
  function draw(filterText) {
    const q = (filterText || '').toLowerCase();
    const rows = shows.filter(s => !q || s.venue.toLowerCase().includes(q) || new Date(s.date).toLocaleDateString().includes(q));
    listEl.innerHTML = rows.slice(0, 100).map(s => `
      <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0;">
        <div>${new Date(s.date).toLocaleDateString()} — ${s.venue} <span class="muted">(${s.stage})</span></div>
        <button class="btn secondary" data-edit-show="${s.id}">Edit</button>
      </div>
    `).join('') || '<p class="muted">No matches.</p>';
    listEl.querySelectorAll('[data-edit-show]').forEach(btn => btn.onclick = () => {
      wizardShowId = Number(btn.dataset.editShow); wizardStage = 'tag'; renderWizard();
    });
  }
  draw('');
  filterEl.oninput = () => draw(filterEl.value);
}

// ---------------- Wizard: tag -> spotify review -> playlist submit ----------------
async function renderWizard() {
  const show = await api(`/api/shows/${wizardShowId}`);
  if (wizardStage === 'tag') return renderTagStage(show);
  if (wizardStage === 'spotify') return renderSpotifyStage(show);
  if (wizardStage === 'playlist') return renderPlaylistStage(show);
}

function exitWizard() { wizardShowId = null; wizardStage = null; activeTab = 'sync'; renderTab(); }

async function renderTagStage(show) {
  const companions = await api('/api/companions');
  const allSongs = show.artists.flatMap(a => a.songs.map(s => ({ ...s, artistName: a.artist })));
  const companionIds = new Set(show.companions.map(c => c.id));

  app.innerHTML = `
    <button class="btn secondary" id="back-btn" style="margin-bottom:14px;">&larr; Back to Sync</button>
    <div class="card">
      <h2>Tag songs — ${new Date(show.date).toLocaleDateString()} · ${show.venue}</h2>
      ${show.artists.map(a => `
        <div style="margin-bottom:14px;">
          <div style="font-weight:500;margin-bottom:6px;">${a.artist}</div>
          <div class="row" style="margin-bottom:8px;"><button class="btn secondary" data-fillgap="${a.id}" data-artist="${a.artist}">Fill gap from another show</button></div>
          <table>
            <tr><th>#</th><th>Song</th><th>Cover</th><th>Known</th><th>Status</th><th>Regret-eligible</th><th></th></tr>
            ${a.songs.map(s => `
              <tr data-song-row="${s.id}">
                <td>${s.play_order}</td><td>${s.title}</td>
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
  app.querySelectorAll('.pill[data-toggle]').forEach(p => p.onclick = () => p.classList.toggle('on'));
  app.querySelectorAll('.pill[data-companion]').forEach(p => p.onclick = () => p.classList.toggle('on'));
  app.querySelectorAll('[data-fillgap]').forEach(btn => btn.onclick = () => openFillGap(btn.dataset.fillgap, btn.dataset.artist));
  app.querySelectorAll('[data-remove-song]').forEach(btn => btn.onclick = async () => {
    if (!confirm('Remove this song from the dataset? This can\'t be undone.')) return;
    try {
      await api(`/api/show-songs/${btn.dataset.removeSong}/remove`, { method: 'POST' });
      btn.closest('tr').remove();
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
  const results = await api(`/api/shows/${wizardShowId}/fill-gap/search`, { method: 'POST', body: { artistName } });
  const list = results.slice(0, 8).map(r => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
    <span>${r.date} — ${r.venue}, ${r.city} (${r.songCount} songs)</span>
    <button class="btn secondary" data-apply-setlist="${r.id}">Use this</button>
  </div>`).join('');
  const modal = document.createElement('div');
  modal.className = 'card';
  modal.style = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:50;max-width:500px;width:90%;';
  modal.innerHTML = `<h2>Other ${artistName} setlists</h2>${list || '<p class="muted">No results.</p>'}<button class="btn secondary" id="close-fillgap">Close</button>`;
  document.body.appendChild(modal);
  modal.querySelector('#close-fillgap').onclick = () => modal.remove();
  modal.querySelectorAll('[data-apply-setlist]').forEach(btn => btn.onclick = async () => {
    await api(`/api/shows/${wizardShowId}/fill-gap/apply`, { method: 'POST', body: { setlistId: btn.dataset.applySetlist, showArtistId: Number(showArtistId), artistName } });
    modal.remove();
    renderWizard();
  });
}

async function renderSpotifyStage(show) {
  const review = await api(`/api/shows/${show.id}/spotify-review`);
  app.innerHTML = `
    <button class="btn secondary" id="back-btn" style="margin-bottom:14px;">&larr; Back to Sync</button>
    <div class="card">
      <h2>Review Spotify matches</h2>
      ${review.map(r => renderMatchRow(r)).join('')}
      <button class="btn" id="continue-playlist-btn" style="margin-top:14px;">Continue to playlists</button>
      <div class="error" id="spotify-err"></div>
    </div>
  `;
  document.getElementById('back-btn').onclick = exitWizard;

  review.forEach(r => {
    const rowEl = document.getElementById(`match-${r.songId}`);
    if (!rowEl) return;
    rowEl.querySelectorAll('[data-select-track]').forEach(b => b.onclick = () => {
      rowEl.dataset.decision = JSON.stringify({ action: 'select', track: JSON.parse(b.dataset.selectTrack) });
      rowEl.querySelectorAll('.song-row').forEach(sr => sr.style.outline = '');
      b.closest('.song-row').style.outline = `2px solid var(--violet)`;
    });
    const excludeBtn = rowEl.querySelector('[data-exclude]');
    if (excludeBtn) excludeBtn.onclick = () => { rowEl.dataset.decision = JSON.stringify({ action: 'exclude' }); };
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
  return `
    <div id="match-${r.songId}" style="margin-bottom:12px;">
      <div class="song-row">
        <img class="art" src="${(current && current.albumArtUrl) || (r.suggested && r.suggested.albumArtUrl) || ''}" />
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;">${r.title}</div>
          <div class="muted">${r.artist} ${current ? `&middot; ${current.albumName || ''}` : r.suggested ? `&middot; ${r.suggested.albumName}` : '&middot; no match found'}</div>
        </div>
        <span class="pill">search</span>
      </div>
      ${r.status === 'pending' ? `
        <div class="row" style="margin:6px 0 0 50px;">
          ${candidates.slice(0, 3).map(c => `<button class="btn secondary" data-select-track='${JSON.stringify(c)}'>${c.albumName}</button>`).join('')}
          <button class="btn danger" data-exclude>Exclude</button>
          <button class="btn secondary" data-manual-search>Search Spotify</button>
          <button class="btn danger" data-remove-from-dataset>Remove from dataset</button>
        </div>
      ` : `<div class="muted" style="margin-left:50px;">${r.status === 'excluded' ? 'Excluded' : 'Already resolved'} <button class="btn secondary" data-manual-search style="margin-left:8px;">Change</button> <button class="btn danger" data-remove-from-dataset style="margin-left:8px;">Remove from dataset</button></div>`}
      <div id="manual-search-${r.songId}"></div>
    </div>
  `;
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
          <button class="btn secondary" data-manual-pick='${JSON.stringify(c)}'>Use this</button>
        </div>
      `).join('');
      resultsEl.querySelectorAll('[data-manual-pick]').forEach(btn => btn.onclick = () => {
        const track = JSON.parse(btn.dataset.manualPick);
        rowEl.dataset.decision = JSON.stringify({ action: 'select', track });
        resultsEl.innerHTML = `<p class="success">Selected: ${track.name} — ${track.albumName}</p>`;
      });
    } catch (e) { resultsEl.innerHTML = `<p class="error">${e.message}</p>`; }
  };
}

async function renderPlaylistStage(show) {
  const preview = await api(`/api/shows/${show.id}/playlist-preview`);
  app.innerHTML = `
    <button class="btn secondary" id="back-btn" style="margin-bottom:14px;">&larr; Back to Sync</button>
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
      <button class="btn" id="submit-playlists-btn">Add to playlists</button>
      <div class="success" id="playlist-ok"></div>
      <div class="error" id="playlist-err"></div>
    </div>
  `;
  document.getElementById('back-btn').onclick = exitWizard;
  const drops = new Set();
  app.querySelectorAll('[data-drop]').forEach(btn => btn.onclick = () => {
    drops.add(btn.dataset.drop);
    btn.closest('.song-row').style.opacity = '0.3';
    btn.disabled = true;
  });
  document.getElementById('submit-playlists-btn').onclick = async () => {
    try {
      const r = await api(`/api/shows/${show.id}/playlist-submit`, { method: 'POST', body: { drops: [...drops], swaps: {} } });
      document.getElementById('playlist-ok').textContent = `Added ${r.added} songs. Show complete.`;
      setTimeout(exitWizard, 1200);
    } catch (e) { document.getElementById('playlist-err').textContent = e.message; }
  };
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
        <div class="stat-tile"><div class="num">${t.shows}</div><div class="label">Shows</div></div>
        <div class="stat-tile"><div class="num">${t.unique_artists}</div><div class="label">Unique Artists</div></div>
        <div class="stat-tile"><div class="num">${t.unique_songs}</div><div class="label">Unique songs</div></div>
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
        <div class="stat-tile"><div class="num">${Math.round(data.totals.miles || 0)}</div><div class="label">Total miles</div></div>
        <div class="stat-tile"><div class="num">${hours}</div><div class="label">Total travel time (hrs)</div></div>
      </div>
      <button class="btn secondary" id="backfill-btn">Backfill missing travel data</button>
      <div class="muted" id="backfill-status" style="margin-top:8px;"></div>
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
          ${data.travel.map(s => `<tr><td>${s.venue}</td><td>${s.city || '—'}</td><td>${s.state || '—'}</td><td>${s.distance_miles ?? '—'}</td><td>${s.duration_minutes != null ? (Math.round((s.duration_minutes / 60) * 10) / 10) + ' hrs' : '—'}</td><td>${s.bands || '—'}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}
        </table>
      </div>
    </div>
  `;
  document.getElementById('backfill-btn').onclick = async () => {
    const statusEl = document.getElementById('backfill-status');
    statusEl.textContent = 'Retrying geocoding for shows missing travel data...';
    try {
      const r = await api('/api/admin/backfill-travel', { method: 'POST' });
      statusEl.textContent = `Fixed ${r.fixed} of ${r.checked} shows (${r.stillMissing} still missing).`;
      renderTravel();
    } catch (e) { statusEl.textContent = e.message; }
  };
}

async function renderSuperlatives() {
  const data = await api(`/api/report/superlatives${companionsQuery()}`);
  dashBody().innerHTML = `
    <div class="card">
      <h2>Bands seen the most</h2>
      <table>
        <tr><th>Artist</th><th>Times seen</th><th>Song count</th><th>Headline %</th><th>Setlist variation %</th><th>Opener/closer variation %</th></tr>
        ${data.bandsSeenMost.map(r => `<tr><td>${r.artist}</td><td>${r.timesSeen}</td><td>${r.songCount}</td><td>${r.pctHeadline}%</td><td>${r.setlistVariationPct}%</td><td>${r.openCloseVariationPct}%</td></tr>`).join('')}
      </table>
    </div>
    <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap;">
      <div class="card" style="flex:1;min-width:280px;">
        <h2>Most unique songs by a repeat artist</h2>
        <table>
          <tr><th>Artist</th><th>Times seen</th><th>Unique songs</th></tr>
          ${data.mostUniqueSongsRepeat.map(r => `<tr><td>${r.artist}</td><td>${r.timesSeen}</td><td>${r.uniqueSongs}</td></tr>`).join('') || '<tr><td class="muted">Not enough repeat artists yet</td></tr>'}
        </table>
      </div>
      <div class="card" style="flex:1;min-width:280px;">
        <h2>Most opener/closer variation</h2>
        <table>
          <tr><th>Artist</th><th>Times seen</th><th>Variation %</th></tr>
          ${data.mostOpenCloseVariation.map(r => `<tr><td>${r.artist}</td><td>${r.timesSeen}</td><td>${r.openCloseVariationPct}%</td></tr>`).join('') || '<tr><td class="muted">Not enough repeat artists yet</td></tr>'}
        </table>
      </div>
    </div>
  `;
}

async function renderJourney() {
  const data = await api(`/api/report/journey${companionsQuery()}`);
  dashBody().innerHTML = `
    <div class="row" style="align-items:flex-start;gap:20px;flex-wrap:wrap;">
      <div class="card" style="flex:1;min-width:300px;">
        <h2>First 3 shows</h2>
        ${data.first.map(journeyShowCard).join('') || '<p class="muted">No shows yet.</p>'}
      </div>
      <div class="card" style="flex:1;min-width:300px;">
        <h2>Latest 3 shows</h2>
        ${data.latest.map(journeyShowCard).join('') || '<p class="muted">No shows yet.</p>'}
      </div>
    </div>
  `;
}

function journeyShowCard(sh) {
  return `
    <div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line);">
      <div style="font-weight:600;">${new Date(sh.date).toLocaleDateString()} — ${sh.venue}</div>
      <div class="muted" style="margin-bottom:6px;">${[sh.city, sh.state].filter(Boolean).join(', ')}</div>
      ${sh.artists.map(a => `<div class="muted">${a.orderLabel}: <span style="color:var(--text);">${a.artist}</span> — Opener: ${a.opener || '—'} · Closer: ${a.closer || '—'}</div>`).join('')}
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
        <div class="stat-tile"><div class="num">${t.regret_count || 0}</div><div class="label">Regret</div></div>
      </div>
      <table>
        <tr><th>Artist</th><th>Song</th><th>Regret</th></tr>
        ${data.songs.map(s => `<tr><td>${s.artist}</td><td>${s.title}</td><td>${s.regret ? 'Yes' : 'No'}</td></tr>`).join('') || '<tr><td class="muted">None.</td></tr>'}
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
