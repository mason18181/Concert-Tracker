let hostPw = sessionStorage.getItem('ct_pw') || null;
let activeTab = 'sync';
let wizardShowId = null;
let wizardStage = null; // 'tag' | 'spotify' | 'playlist'

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
  if (activeTab === 'overview') return renderOverview();
  if (activeTab === 'yearly') return renderYearly();
  if (activeTab === 'trends') return renderTrends();
  if (activeTab === 'travel') return renderTravel();
  if (activeTab === 'superlatives') return renderSuperlatives();
  if (activeTab === 'songstatus') return renderSongStatus();
  if (activeTab === 'settings') return renderSettings();
}

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
}

// ---------------- Sync ----------------
async function renderSync() {
  const pending = await api('/api/shows/pending');
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
  `;
  document.getElementById('sync-btn').onclick = async () => {
    const statusEl = document.getElementById('sync-status');
    statusEl.textContent = 'Syncing...';
    try {
      const r = await api('/api/sync', { method: 'POST' });
      statusEl.textContent = `Found ${r.newShows} new show(s).`;
      renderSync();
    } catch (e) { statusEl.textContent = e.message; }
  };
  app.querySelectorAll('[data-show]').forEach(btn => {
    btn.onclick = () => { wizardShowId = Number(btn.dataset.show); wizardStage = btn.dataset.stage; renderWizard(); };
  });
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
            <tr><th>#</th><th>Song</th><th>Known</th><th>Status</th><th>Regret-eligible</th></tr>
            ${a.songs.map(s => `
              <tr data-song-row="${s.id}">
                <td>${s.play_order}</td><td>${s.title}</td>
                <td><span class="pill known-pill ${s.known ? 'on' : ''}" data-toggle="known">${s.known ? 'Yes' : 'No'}</span></td>
                <td>
                  <select class="status-select">
                    <option value="seen" ${s.status === 'seen' || !s.status ? 'selected' : ''}>Seen</option>
                    <option value="missed" ${s.status === 'missed' ? 'selected' : ''}>Missed</option>
                    <option value="skipped" ${s.status === 'skipped' ? 'selected' : ''}>Chose not to see</option>
                  </select>
                </td>
                <td><span class="pill liked-pill ${s.liked_now ? 'on' : ''}" data-toggle="liked">${s.liked_now ? 'Yes' : 'No'}</span></td>
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
  });

  document.getElementById('continue-playlist-btn').onclick = async () => {
    const decisions = [];
    review.forEach(r => {
      const rowEl = document.getElementById(`match-${r.songId}`);
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
        </div>
      ` : `<div class="muted" style="margin-left:50px;">${r.status === 'excluded' ? 'Excluded' : 'Already resolved'} <button class="btn secondary" data-manual-search style="margin-left:8px;">Change</button></div>`}
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

// ---------------- Reports ----------------
async function renderOverview() {
  const data = await api('/api/report/overview');
  const t = data.totals;
  app.innerHTML = `
    <div class="card">
      <h2>Overview</h2>
      <div class="stat-grid" style="margin-bottom:20px;">
        <div class="stat-tile"><div class="num">${t.shows}</div><div class="label">Shows</div></div>
        <div class="stat-tile"><div class="num">${t.artists}</div><div class="label">Artists</div></div>
        <div class="stat-tile"><div class="num">${t.songs}</div><div class="label">Unique songs</div></div>
        <div class="stat-tile"><div class="num">${t.pct_known || 0}%</div><div class="label">Known</div></div>
      </div>
      <table>
        <tr><th>Date</th><th>Artist</th><th>Billing</th><th>Songs</th><th>Known</th><th>Opener</th><th>Closer</th></tr>
        ${data.showLog.map(r => `<tr><td>${new Date(r.date).toLocaleDateString()}</td><td>${r.artist}</td><td>${r.billing_order || '—'}</td><td>${r.song_count}</td><td>${r.pct_known || 0}%</td><td>${r.opener}</td><td>${r.closer}</td></tr>`).join('')}
      </table>
    </div>
  `;
}

async function renderYearly() {
  const rows = await api('/api/report/yearly');
  const max = Math.max(...rows.map(r => r.shows), 1);
  app.innerHTML = `
    <div class="card">
      <h2>Shows by year</h2>
      <div class="row" style="align-items:flex-end;height:120px;">
        ${rows.map(r => `<div style="flex:1;text-align:center;"><div style="background:var(--violet);height:${(r.shows / max) * 100}px;border-radius:4px 4px 0 0;"></div><div class="muted" style="margin-top:4px;">${r.year}</div></div>`).join('')}
      </div>
    </div>
  `;
}

async function renderTrends() {
  const data = await api('/api/report/trends');
  const wk = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  app.innerHTML = `
    <div class="card"><h2>By season</h2><div class="row">${data.bySeason.map(s => `<span class="pill">${s.season}: ${s.shows}</span>`).join('')}</div></div>
    <div class="card"><h2>By month</h2><div class="row">${data.byMonth.map(m => `<span class="pill">M${m.month}: ${m.shows}</span>`).join('')}</div></div>
    <div class="card"><h2>By weekday</h2><div class="row">${data.byWeekday.map(w => `<span class="pill">${wk[w.weekday]}: ${w.shows}</span>`).join('')}</div></div>
  `;
}

async function renderTravel() {
  const data = await api('/api/report/travel');
  app.innerHTML = `
    <div class="card">
      <h2>Travel</h2>
      <div class="stat-grid" style="margin-bottom:16px;">
        <div class="stat-tile"><div class="num">${Math.round(data.totals.miles || 0)}</div><div class="label">Total miles</div></div>
        <div class="stat-tile"><div class="num">${Math.round((data.totals.hours || 0) * 10) / 10}</div><div class="label">Total hours</div></div>
      </div>
      <table>
        <tr><th>Date</th><th>Venue</th><th>City, state</th><th>Miles</th><th>Minutes</th></tr>
        ${data.shows.map(s => `<tr><td>${new Date(s.date).toLocaleDateString()}</td><td>${s.venue}</td><td>${s.city}, ${s.state}</td><td>${s.distance_miles ?? '—'}</td><td>${s.duration_minutes ?? '—'}</td></tr>`).join('')}
      </table>
    </div>
  `;
}

async function renderSuperlatives() {
  const data = await api('/api/report/superlatives');
  app.innerHTML = `
    <div class="card"><h2>Most songs at a show</h2><table>${data.mostSongsAtShow.map(r => `<tr><td>${new Date(r.date).toLocaleDateString()}</td><td>${r.artist}</td><td>${r.song_count}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Most regret songs by artist</h2><table>${data.mostRegretByArtist.map(r => `<tr><td>${r.artist}</td><td>${r.regret_count}</td></tr>`).join('')}</table></div>
    <div class="card"><h2>Most missed in a set</h2><table>${data.mostMissedInSet.map(r => `<tr><td>${r.artist}</td><td>${new Date(r.date).toLocaleDateString()}</td><td>${r.missed_count}</td></tr>`).join('')}</table></div>
  `;
}

async function renderSongStatus() {
  const data = await api('/api/report/song-status');
  const t = data.totals;
  app.innerHTML = `
    <div class="card">
      <h2>Song status</h2>
      <div class="stat-grid" style="margin-bottom:16px;">
        <div class="stat-tile"><div class="num">${t.pct_known || 0}%</div><div class="label">Known</div></div>
        <div class="stat-tile"><div class="num">${t.pct_missed || 0}%</div><div class="label">Missed</div></div>
        <div class="stat-tile"><div class="num">${t.pct_skipped || 0}%</div><div class="label">Skipped</div></div>
        <div class="stat-tile"><div class="num">${t.regret_count || 0}</div><div class="label">Regret</div></div>
      </div>
      <div class="row" style="align-items:flex-start;gap:30px;">
        <div style="flex:1;"><h2>Not known</h2>${data.notKnown.map(s => `<div class="muted">${s.title} — ${s.artist}</div>`).join('')}</div>
        <div style="flex:1;"><h2>Regret</h2>${data.regret.map(s => `<div class="muted">${s.title} — ${s.artist}</div>`).join('')}</div>
      </div>
    </div>
  `;
}

boot();
