(() => {
  const state = {
    view: 'tracks',
    filters: { artist: '', album: '', year: '', genre: '', q: '', favorite: false },
    sort: { field: 'artist', dir: 'asc' },
    page: 1,
    pageSize: 50,
    currentArtist: null,
    playingTrackId: null,
    currentPlaylistId: null,
    selectedTrackIds: new Set(),
    shuffle: false,
  };

  const el = (id) => document.getElementById(id);

  // ---------- Generic modal (prompt / confirm / select) — no window.alert/confirm/prompt ----------
  // withInput: a free-text prompt, resolves to the trimmed string or null.
  // withSelect + selectOptions ([{value, label}]): a dropdown prompt, resolves to the chosen
  // value or null if cancelled. Plain confirm (neither flag) resolves to true/false.
  function showModal({ title, message = '', withInput = false, defaultValue = '', withSelect = false, selectOptions = [], okLabel = 'OK', hideCancel = false }) {
    return new Promise((resolve) => {
      el('modalTitle').textContent = title;
      const messageEl = el('modalMessage');
      messageEl.textContent = message;
      messageEl.hidden = !message;
      const input = el('modalInput');
      input.hidden = !withInput;
      input.value = defaultValue;

      const select = el('modalSelect');
      select.hidden = !withSelect;
      if (withSelect) {
        select.innerHTML = selectOptions
          .map((opt) => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`)
          .join('');
      }

      el('modalOk').textContent = okLabel;
      el('modalCancel').hidden = hideCancel;
      el('modalOverlay').hidden = false;
      if (withInput) {
        input.focus();
        input.select();
      }
      const okBtn = el('modalOk');
      const cancelBtn = el('modalCancel');

      function cleanup(result) {
        el('modalOverlay').hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKeydown);
        resolve(result);
      }
      function onOk() {
        if (withInput) return cleanup(input.value.trim() || null);
        if (withSelect) return cleanup(select.value);
        return cleanup(true);
      }
      function onCancel() { cleanup(withInput || withSelect ? null : false); }
      function onKeydown(e) {
        if (e.key === 'Enter') onOk();
        if (e.key === 'Escape') onCancel();
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (withInput) input.addEventListener('keydown', onKeydown);
    });
  }

  // ---------- Auth ----------
  async function checkAuth() {
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
      if (!data.authenticated) window.location.href = '/login.html';
    } catch {
      // If the request itself fails, let the user retry rather than bouncing them.
    }
  }

  el('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  // ---------- About ----------
  el('aboutBtn').addEventListener('click', async () => {
    const content = el('aboutContent');
    content.innerHTML = `<p class="muted">Loading…</p>`;
    el('aboutModal').hidden = false;

    let about = {};
    let stats = {};
    try {
      [about, stats] = await Promise.all([
        fetch('/api/about').then((r) => r.json()),
        fetch('/api/stats').then((r) => r.json()),
      ]);
    } catch {
      // fall through with whatever we got — the template below handles missing fields
    }

    content.innerHTML = `
      <div class="about-name">🎵 ${escapeHtml(about.name || 'MP3 Library')}</div>
      <div class="about-version">Version ${escapeHtml(about.version || '—')}</div>
      <div class="about-description">${escapeHtml(about.description || 'A self-hosted, searchable database for your MP3 collection.')}</div>
      <div class="about-stats">
        ${stats.tracks ?? '—'} track${stats.tracks === 1 ? '' : 's'} ·
        ${stats.artists ?? '—'} artist${stats.artists === 1 ? '' : 's'} ·
        ${stats.albums ?? '—'} album${stats.albums === 1 ? '' : 's'}
      </div>
      <div class="about-credit">Created by
        <a href="http://jason4bury.org" target="_blank" rel="noopener">Jason</a> &amp;
        <a href="https://claude.ai" target="_blank" rel="noopener">Claude</a>
      </div>
    `;
  });

  el('aboutCloseBtn').addEventListener('click', () => { el('aboutModal').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('aboutModal').hidden) el('aboutModal').hidden = true;
  });

  // ---------- Settings (Last.fm scrobbling + crossfade) ----------
  // crossfadeSettings is read by the playback engine further down (see "Gapless crossfade
  // (optional)" in the Player section) — it's just plain state here, off by default, persisted
  // to localStorage the same way the volume preference is.
  let crossfadeSettings = { enabled: false, seconds: 5 };
  (function initCrossfadeSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem('mp3lib_crossfade') || 'null');
      if (stored && typeof stored === 'object') {
        crossfadeSettings.enabled = !!stored.enabled;
        crossfadeSettings.seconds = Math.min(12, Math.max(1, parseInt(stored.seconds, 10) || 5));
      }
    } catch {
      // Storage blocked — just start with crossfade off, same fallback as elsewhere.
    }
    el('crossfadeEnabled').checked = crossfadeSettings.enabled;
    el('crossfadeDuration').value = crossfadeSettings.seconds;
    el('crossfadeDurationLabel').textContent = `${crossfadeSettings.seconds}s`;
    el('crossfadeDurationRow').classList.toggle('disabled', !crossfadeSettings.enabled);
  })();

  function saveCrossfadeSettings() {
    try { localStorage.setItem('mp3lib_crossfade', JSON.stringify(crossfadeSettings)); } catch {}
  }

  el('crossfadeEnabled').addEventListener('change', () => {
    crossfadeSettings.enabled = el('crossfadeEnabled').checked;
    el('crossfadeDurationRow').classList.toggle('disabled', !crossfadeSettings.enabled);
    saveCrossfadeSettings();
  });

  el('crossfadeDuration').addEventListener('input', () => {
    crossfadeSettings.seconds = parseInt(el('crossfadeDuration').value, 10) || 5;
    el('crossfadeDurationLabel').textContent = `${crossfadeSettings.seconds}s`;
    saveCrossfadeSettings();
  });

  async function loadLastfmScrobbleStatus() {
    const statusEl = el('lastfmScrobbleStatus');
    const actionsEl = el('lastfmScrobbleActions');
    statusEl.textContent = 'Loading…';
    actionsEl.innerHTML = '';
    let data;
    try {
      data = await fetch('/api/lastfm/status').then((r) => r.json());
    } catch {
      statusEl.textContent = 'Could not check Last.fm status right now.';
      return;
    }

    if (!data.configured) {
      statusEl.innerHTML = `Not set up — add <code>LASTFM_API_KEY</code> and <code>LASTFM_API_SECRET</code> to your <code>.env</code> to enable scrobbling (see the README). Free, from the same Last.fm account used for the artist/album info elsewhere in the app.`;
      return;
    }

    if (data.connected) {
      statusEl.innerHTML = `Connected as <strong>${escapeHtml(data.username)}</strong> — your plays are being scrobbled.`;
      actionsEl.innerHTML = `<button id="lastfmDisconnectBtn" class="btn-ghost">Disconnect</button>`;
      el('lastfmDisconnectBtn').addEventListener('click', async () => {
        await fetch('/api/lastfm/auth/disconnect', { method: 'POST' });
        loadLastfmScrobbleStatus();
      });
    } else {
      statusEl.textContent = 'Not connected.';
      actionsEl.innerHTML = `<button id="lastfmConnectBtn" class="btn-primary">Connect Last.fm</button>`;
      el('lastfmConnectBtn').addEventListener('click', startLastfmAuth);
    }
  }

  // Two-step connect flow: last.fm doesn't call back into a self-hosted app (there's no fixed
  // public URL to register), so step 2 is the user confirming back here once they've approved
  // access on the last.fm tab that opened.
  async function startLastfmAuth() {
    const statusEl = el('lastfmScrobbleStatus');
    const actionsEl = el('lastfmScrobbleActions');
    let data;
    try {
      data = await fetch('/api/lastfm/auth/start', { method: 'POST' }).then((r) => r.json());
    } catch {
      statusEl.textContent = 'Could not start the Last.fm connection.';
      return;
    }
    if (data.error) {
      statusEl.textContent = `Couldn't connect: ${data.error}`;
      return;
    }
    window.open(data.authUrl, '_blank', 'noopener');
    actionsEl.innerHTML = `
      <span class="muted">Approve access on the last.fm tab that just opened, then:</span>
      <button id="lastfmFinishBtn" class="btn-primary">I've approved it — finish connecting</button>
    `;
    el('lastfmFinishBtn').addEventListener('click', async () => {
      statusEl.textContent = 'Finishing up…';
      try {
        const res = await fetch('/api/lastfm/auth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: data.token }),
        }).then((r) => r.json());
        if (res.error) throw new Error(res.error);
        loadLastfmScrobbleStatus();
      } catch (err) {
        statusEl.textContent = `Couldn't finish connecting: ${err.message}`;
      }
    });
  }

  el('settingsBtn').addEventListener('click', () => {
    el('settingsModal').hidden = false;
    loadLastfmScrobbleStatus();
  });
  el('settingsCloseBtn').addEventListener('click', () => { el('settingsModal').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('settingsModal').hidden) el('settingsModal').hidden = true;
  });

  // ---------- Tabs ----------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    el('filtersBar').style.display = view === 'tracks' ? 'flex' : 'none';

    if (view === 'tracks') {
      el('tracksView').classList.add('active');
      loadTracks();
    } else if (view === 'artists') {
      el('artistsView').classList.add('active');
      loadArtists();
    } else if (view === 'artistDetail') {
      el('artistDetailView').classList.add('active');
    } else if (view === 'albums') {
      el('albumsView').classList.add('active');
      loadAlbums();
    } else if (view === 'albumDetail') {
      el('albumDetailView').classList.add('active');
    } else if (view === 'playlists') {
      el('playlistsView').classList.add('active');
      loadPlaylists();
    } else if (view === 'playlistDetail') {
      el('playlistDetailView').classList.add('active');
    } else if (view === 'health') {
      el('healthView').classList.add('active');
      loadHealth();
    } else if (view === 'stats') {
      el('statsView').classList.add('active');
      loadStats();
    } else if (view === 'history') {
      el('historyView').classList.add('active');
      loadRecap();
      loadHistory(1);
    }
  }

  // ---------- Filters ----------
  let searchDebounce;
  el('searchInput').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const value = el('searchInput').value.trim();
    searchDebounce = setTimeout(() => {
      state.filters.q = value;
      state.page = 1;
      loadTracks();
      loadSearchSuggestions(value);
    }, 300);
  });

  // ---------- Search-as-you-type suggestions ----------
  // A lightweight dropdown of top artist/album/track matches under the topbar search box, fed
  // by GET /api/quick-search. It rides on the same debounce as the live Tracks-tab filtering
  // above, so it never fires more requests than that already does. Per the app's standing
  // "never auto-play on click" rule, clicking a track suggestion applies it as a filter and
  // switches to the Tracks tab rather than starting playback.
  async function loadSearchSuggestions(q) {
    const box = el('searchSuggestions');
    if (!q || q.length < 2) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    let data;
    try {
      data = await fetch(`/api/quick-search?q=${encodeURIComponent(q)}`).then((r) => r.json());
    } catch {
      return;
    }
    // The input may have changed (or been cleared) while this request was in flight.
    if (el('searchInput').value.trim() !== q) return;

    const hasAny = data.artists.length || data.albums.length || data.tracks.length;
    if (!hasAny) {
      box.innerHTML = `<div class="sg-empty">No matches for "${escapeHtml(q)}"</div>`;
      box.hidden = false;
      return;
    }

    const section = (label, items, render) =>
      items.length
        ? `<div class="sg-group-label">${label}</div>${items.map(render).join('')}`
        : '';

    box.innerHTML =
      section('Artists', data.artists, (a) => `
        <div class="sg-item" data-kind="artist" data-artist="${escapeAttr(a.artist)}">
          <span>${escapeHtml(a.artist)}</span>
          <span class="sg-sub">${a.track_count} track${a.track_count === 1 ? '' : 's'}</span>
        </div>`) +
      section('Albums', data.albums, (a) => `
        <div class="sg-item" data-kind="album" data-album-key="${escapeAttr(a.album_key || '')}">
          <span>${escapeHtml(a.album)}</span>
          <span class="sg-sub">${escapeHtml(a.artist || '')}</span>
        </div>`) +
      section('Tracks', data.tracks, (t) => `
        <div class="sg-item" data-kind="track" data-title="${escapeAttr(t.title || '')}">
          <span>${escapeHtml(t.title || '—')}</span>
          <span class="sg-sub">${escapeHtml(t.artist || '')}</span>
        </div>`);
    box.hidden = false;

    box.querySelectorAll('.sg-item').forEach((item) => {
      item.addEventListener('click', () => {
        box.hidden = true;
        const kind = item.dataset.kind;
        if (kind === 'artist') {
          openArtistDetail(item.dataset.artist);
        } else if (kind === 'album') {
          if (item.dataset.albumKey) openAlbumDetail(item.dataset.albumKey);
        } else if (kind === 'track') {
          el('searchInput').value = item.dataset.title;
          state.filters.q = item.dataset.title;
          state.page = 1;
          switchView('tracks');
        }
      });
    });
  }

  el('searchInput').addEventListener('focus', () => {
    if (el('searchSuggestions').innerHTML) el('searchSuggestions').hidden = false;
  });

  document.addEventListener('click', (e) => {
    if (!el('searchSuggestions').hidden && !e.target.closest('.search-wrap')) {
      el('searchSuggestions').hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('searchSuggestions').hidden) el('searchSuggestions').hidden = true;
  });

  ['filterArtist', 'filterAlbum', 'filterYear', 'filterGenre'].forEach((id) => {
    el(id).addEventListener('change', () => {
      state.filters.artist = el('filterArtist').value;
      state.filters.album = el('filterAlbum').value;
      state.filters.year = el('filterYear').value;
      state.filters.genre = el('filterGenre').value;
      state.page = 1;
      if (id === 'filterArtist') loadAlbumOptions(state.filters.artist);
      loadTracks();
    });
  });

  el('clearFiltersBtn').addEventListener('click', () => {
    state.filters = { artist: '', album: '', year: '', genre: '', q: '', favorite: false };
    el('searchInput').value = '';
    el('searchSuggestions').hidden = true;
    el('filterArtist').value = '';
    el('filterAlbum').value = '';
    el('filterYear').value = '';
    el('filterGenre').value = '';
    el('filterFavoriteBtn').classList.remove('active');
    el('filterFavoriteBtn').textContent = '♡ Favorites';
    state.page = 1;
    loadAlbumOptions('');
    loadTracks();
  });

  el('filterFavoriteBtn').addEventListener('click', () => {
    state.filters.favorite = !state.filters.favorite;
    el('filterFavoriteBtn').classList.toggle('active', state.filters.favorite);
    el('filterFavoriteBtn').textContent = state.filters.favorite ? '♥ Favorites' : '♡ Favorites';
    state.page = 1;
    loadTracks();
  });

  // ---------- Smart playlists ----------
  el('saveSmartPlaylistBtn').addEventListener('click', async () => {
    const name = await showModal({ title: 'Smart playlist name', withInput: true });
    if (!name) return;
    const created = await fetch('/api/playlists/smart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filters: state.filters }),
    }).then((r) => r.json());
    if (created.error) {
      await showModal({ title: created.error, okLabel: 'OK', hideCancel: true });
      return;
    }
    switchView('playlists');
    openPlaylistDetail(created.id);
  });

  function describeSmartFilters(f) {
    if (!f) return 'all tracks';
    const parts = [];
    if (f.q) parts.push(`matching "${f.q}"`);
    if (f.artist) parts.push(`artist: ${f.artist}`);
    if (f.album) parts.push(`album: ${f.album}`);
    if (f.decade || f.decade === 0) parts.push(`decade: ${f.decade}s`);
    if (f.year) parts.push(`year: ${f.year}`);
    if (f.genre) parts.push(`genre: ${f.genre}`);
    if (f.favorite) parts.push('favorites only');
    const base = parts.length ? parts.join(', ') : 'all tracks';
    if (f.randomCount) return `${base} — ${f.randomCount} random track${f.randomCount === 1 ? '' : 's'}, re-picked every time you open this`;
    return base;
  }

  async function loadFilterOptions() {
    // ?photos=0 — this just needs artist names for the dropdown, not each artist's has_photo
    // lookup, which loadArtists() (the Artists tab itself) already pays for when it's needed.
    const [artistsRes, yearsRes, genresRes] = await Promise.all([
      fetch('/api/artists?photos=0').then((r) => r.json()),
      fetch('/api/years').then((r) => r.json()),
      fetch('/api/genres').then((r) => r.json()),
    ]);
    fillSelect('filterArtist', artistsRes.artists.map((a) => a.artist), 'All artists');
    fillSelect('filterYear', yearsRes.years, 'All years');
    fillSelect('filterGenre', genresRes.genres, 'All genres');
    loadAlbumOptions('');
  }

  async function loadAlbumOptions(artist) {
    const url = artist ? `/api/albums?artist=${encodeURIComponent(artist)}` : '/api/albums';
    const data = await fetch(url).then((r) => r.json());
    fillSelect('filterAlbum', data.albums.map((a) => a.album), 'All albums');
  }

  function fillSelect(id, values, allLabel) {
    const select = el(id);
    const current = select.value;
    select.innerHTML = `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(String(v))}</option>`).join('');
    if (values.includes(current)) select.value = current;
  }

  // ---------- Sorting ----------
  document.querySelectorAll('.track-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sort.field === field) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.field = field;
        state.sort.dir = 'asc';
      }
      loadTracks();
    });
  });

  // ---------- Tracks ----------
  let lastTracks = [];

  async function loadTracks() {
    const params = new URLSearchParams();
    if (state.filters.q) params.set('q', state.filters.q);
    if (state.filters.artist) params.set('artist', state.filters.artist);
    if (state.filters.album) params.set('album', state.filters.album);
    if (state.filters.year) params.set('year', state.filters.year);
    if (state.filters.genre) params.set('genre', state.filters.genre);
    if (state.filters.favorite) params.set('favorite', '1');
    params.set('sort', state.sort.field);
    params.set('dir', state.sort.dir);
    params.set('page', state.page);
    params.set('pageSize', state.pageSize);

    const data = await fetch(`/api/tracks?${params.toString()}`).then((r) => r.json());
    lastTracks = data.tracks;
    renderTracks(data);
  }

  function renderTracks(data) {
    const tbody = el('tracksBody');
    tbody.innerHTML = data.tracks
      .map(
        (t) => `
      <tr class="track-row ${state.playingTrackId === t.id ? 'playing' : ''}" data-id="${t.id}">
        <td class="col-select"><input type="checkbox" class="track-select-cb" data-id="${t.id}" ${state.selectedTrackIds.has(t.id) ? 'checked' : ''}></td>
        <td class="col-cover"><img class="cell-cover-img" loading="lazy" src="/api/cover/track/${t.id}" onerror="this.style.visibility='hidden'"></td>
        <td class="col-play"><button class="play-track-btn" data-id="${t.id}" title="Play">▶</button></td>
        <td>${escapeHtml(t.title || '—')}</td>
        <td>${t.artist ? `<span class="cell-link" data-role="artist-link" data-artist="${escapeAttr(t.artist)}">${escapeHtml(t.artist)}</span>` : '—'}</td>
        <td>${t.album && t.album_key ? `<span class="cell-link" data-role="album-link" data-album-key="${escapeAttr(t.album_key)}">${escapeHtml(t.album)}</span>` : escapeHtml(t.album || '—')}</td>
        <td>${t.year || ''}</td>
        <td>${escapeHtml(t.genre || '')}</td>
        <td class="col-duration">${formatDuration(t.duration)}</td>
        <td class="col-plays">${t.play_count || 0}</td>
        <td class="col-lastplayed">${formatRelativeTime(t.last_played_at)}</td>
        <td class="col-added">${formatRelativeTime(t.added_at)}</td>
        <td class="col-fav"><button class="fav-btn ${t.favorite ? 'active' : ''}" data-id="${t.id}" title="${t.favorite ? 'Remove from favorites' : 'Add to favorites'}">${t.favorite ? '♥' : '♡'}</button></td>
        <td class="col-add">
          <button class="play-next-btn" data-id="${t.id}" title="Play next">⏭</button>
          <button class="add-to-queue-btn" data-id="${t.id}" title="Add to queue">📃</button>
          <button class="radio-track-btn" data-id="${t.id}" title="Start Radio from this track">📻</button>
          <button class="add-to-playlist-btn" data-id="${t.id}" title="Add to playlist">+</button>
        </td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('.play-track-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = lastTracks.find((t) => t.id === id) || findTrackInArtistDetail(id);
        if (track) playTrack(track, lastTracks, false, { type: 'tracks', name: 'Tracks' });
      });
    });

    tbody.querySelectorAll('.play-next-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = lastTracks.find((t) => t.id === id) || findTrackInArtistDetail(id);
        if (track) playNext(track);
      });
    });

    tbody.querySelectorAll('.add-to-queue-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = lastTracks.find((t) => t.id === id) || findTrackInArtistDetail(id);
        if (track) addToQueue(track);
      });
    });

    tbody.querySelectorAll('.add-to-playlist-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddToPlaylistPopover(parseInt(btn.dataset.id, 10), btn);
      });
    });

    tbody.querySelectorAll('.radio-track-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRadio(parseInt(btn.dataset.id, 10), btn);
      });
    });

    tbody.querySelectorAll('.fav-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(parseInt(btn.dataset.id, 10), btn);
      });
    });

    tbody.querySelectorAll('.track-select-cb').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id, 10);
        if (cb.checked) state.selectedTrackIds.add(id);
        else state.selectedTrackIds.delete(id);
        updateBulkBar();
        updateSelectAllCheckbox();
      });
    });

    tbody.querySelectorAll('[data-role="artist-link"]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        openArtistDetail(link.dataset.artist);
      });
    });

    tbody.querySelectorAll('[data-role="album-link"]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        openAlbumDetail(link.dataset.albumKey);
      });
    });

    el('resultCount').textContent = `${data.total} track${data.total === 1 ? '' : 's'}`;
    renderPagination(data);
    updateSelectAllCheckbox();
    updateBulkBar();
  }

  // ---------- Favorites ----------
  // Used from the Tracks tab, an artist's Albums & Tracks list, and an Album detail page —
  // whichever of those track caches happens to hold this track gets its favorite flag patched
  // too, so switching views afterwards doesn't show stale state.
  async function toggleFavorite(trackId, btn) {
    const result = await fetch(`/api/tracks/${trackId}/favorite`, { method: 'PUT' }).then((r) => r.json());
    if (btn) {
      btn.classList.toggle('active', result.favorite);
      btn.textContent = result.favorite ? '♥' : '♡';
      btn.title = result.favorite ? 'Remove from favorites' : 'Add to favorites';
    }
    [lastTracks, currentArtistDetail && currentArtistDetail.tracks, currentAlbumDetail && currentAlbumDetail.tracks].forEach((list) => {
      const cached = list && list.find((t) => t.id === trackId);
      if (cached) cached.favorite = result.favorite;
    });
  }

  // ---------- Multi-select / bulk add to playlist ----------
  function updateBulkBar() {
    const bar = el('trackBulkBar');
    const n = state.selectedTrackIds.size;
    bar.hidden = n === 0;
    if (n > 0) el('bulkSelectedCount').textContent = `${n} track${n === 1 ? '' : 's'} selected`;
  }

  function updateSelectAllCheckbox() {
    const boxes = [...document.querySelectorAll('.track-select-cb')];
    const allChecked = boxes.length > 0 && boxes.every((cb) => cb.checked);
    const someChecked = boxes.some((cb) => cb.checked);
    const selectAll = el('selectAllTracks');
    selectAll.checked = allChecked;
    selectAll.indeterminate = !allChecked && someChecked;
  }

  el('selectAllTracks').addEventListener('change', () => {
    const checked = el('selectAllTracks').checked;
    document.querySelectorAll('.track-select-cb').forEach((cb) => {
      cb.checked = checked;
      const id = parseInt(cb.dataset.id, 10);
      if (checked) state.selectedTrackIds.add(id);
      else state.selectedTrackIds.delete(id);
    });
    updateBulkBar();
  });

  el('bulkClearSelectionBtn').addEventListener('click', () => {
    state.selectedTrackIds.clear();
    document.querySelectorAll('.track-select-cb').forEach((cb) => { cb.checked = false; });
    updateSelectAllCheckbox();
    updateBulkBar();
  });

  el('bulkAddToPlaylistBtn').addEventListener('click', () => {
    openAddToPlaylistPopover([...state.selectedTrackIds], el('bulkAddToPlaylistBtn'));
  });

  function renderPagination(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const pagination = el('pagination');
    pagination.innerHTML = `
      <button id="prevPage" ${data.page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${data.page} of ${totalPages}</span>
      <button id="nextPage" ${data.page >= totalPages ? 'disabled' : ''}>Next →</button>
    `;
    el('prevPage').addEventListener('click', () => {
      if (state.page > 1) { state.page--; loadTracks(); }
    });
    el('nextPage').addEventListener('click', () => {
      if (state.page < totalPages) { state.page++; loadTracks(); }
    });
  }

  // ---------- Artists ----------
  async function loadArtists() {
    const data = await fetch('/api/artists').then((r) => r.json());
    const grid = el('artistGrid');
    grid.innerHTML = data.artists
      .map(
        (a) => `
      <div class="artist-card" data-artist="${escapeAttr(a.artist)}">
        <img class="artist-photo" loading="lazy"
             src="${a.has_photo ? `/api/artist-photo/${encodeURIComponent(a.artist)}` : placeholderSvg(a.artist)}"
             onerror="this.src='${placeholderSvg(a.artist)}'">
        <div class="name">${escapeHtml(a.artist)}</div>
        <div class="meta">${a.track_count} track${a.track_count === 1 ? '' : 's'} · ${a.album_count} album${a.album_count === 1 ? '' : 's'}</div>
      </div>`
      )
      .join('');

    grid.querySelectorAll('.artist-card').forEach((card) => {
      card.addEventListener('click', () => openArtistDetail(card.dataset.artist));
    });

    grid.querySelectorAll('.artist-photo').forEach((img) => {
      const artist = img.closest('.artist-card').dataset.artist;
      wireCoverPreview(img, () => img.src, () => openArtistDetail(artist));
    });
  }

  let currentArtistDetail = null;

  async function openArtistDetail(artist, opts = {}) {
    const data = await fetch(`/api/artists/${encodeURIComponent(artist)}`).then((r) => r.json());
    currentArtistDetail = data;
    state.view = 'artistDetail';
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    el('artistDetailView').classList.add('active');
    el('filtersBar').style.display = 'none';
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));

    el('artistDetailName').textContent = data.artist;
    el('artistDetailMeta').textContent = `${data.tracks.length} tracks · ${data.albums.length} albums`;
    const photoEl = el('artistDetailPhoto');
    photoEl.src = data.has_photo ? `/api/artist-photo/${encodeURIComponent(data.artist)}` : placeholderSvg(data.artist);
    photoEl.onerror = () => { photoEl.src = placeholderSvg(data.artist); };

    // Defaults to the Artist Info sub-tab each time a (possibly different) artist is opened,
    // unless the caller asked to land straight on Albums & Tracks (e.g. clicking an album
    // name from the Tracks tab).
    switchArtistSubview(opts.subview || 'info');

    loadLastfmInfo(data.artist);

    const infoList = el('artistInfoAlbumList');
    if (!data.albums.length) {
      infoList.innerHTML = `<li class="muted">No albums found for this artist.</li>`;
    } else {
      infoList.innerHTML = data.albums
        .map((album) => {
          const coverUrl = album.album_key ? `/api/cover/album/${encodeURIComponent(album.album_key)}` : placeholderSvg(album.album);
          return `
        <li>
          <span class="ai-album-main">
            <img class="ai-cover-thumb" data-album-key="${escapeAttr(album.album_key || '')}" loading="lazy"
                 src="${coverUrl}" onerror="this.src='${placeholderSvg(album.album)}'">
            <span class="ai-album cell-link" data-role="album-link" data-album-key="${escapeAttr(album.album_key || '')}">${escapeHtml(album.album)}</span>
          </span>
          <span class="ai-meta">${album.year || 'Unknown year'} · ${album.track_count} track${album.track_count === 1 ? '' : 's'}</span>
        </li>`;
        })
        .join('');

      infoList.querySelectorAll('.ai-cover-thumb').forEach((img) => {
        const albumKey = img.dataset.albumKey;
        wireCoverPreview(img, () => img.src, albumKey ? () => openAlbumDetail(albumKey) : null);
      });

      infoList.querySelectorAll('[data-role="album-link"]').forEach((link) => {
        if (!link.dataset.albumKey) return;
        link.addEventListener('click', (e) => {
          e.stopPropagation();
          openAlbumDetail(link.dataset.albumKey);
        });
      });
    }

    const container = el('artistAlbums');
    container.innerHTML = data.albums
      .map((album) => {
        const tracks = data.tracks.filter((t) => t.album === album.album);
        return `
        <div class="album-block" data-album="${escapeAttr(album.album)}">
          <h3>${escapeHtml(album.album)}</h3>
          <div class="year">${album.year || ''} · ${album.track_count} track${album.track_count === 1 ? '' : 's'}</div>
          <ul class="album-track-list" data-album="${escapeAttr(album.album)}">
            ${tracks
              .map(
                (t) => `<li data-id="${t.id}" class="${state.playingTrackId === t.id ? 'playing' : ''}">
                  <button class="play-track-btn" data-id="${t.id}" title="Play">▶</button>
                  <span class="at-title">${t.track_no ? t.track_no + '. ' : ''}${escapeHtml(t.title || '—')}</span>
                  <span class="track-plays" title="${t.play_count || 0} play${t.play_count === 1 ? '' : 's'}${t.last_played_at ? ` · last played ${formatRelativeTime(t.last_played_at)}` : ''}">${t.play_count || 0}×</span>
                  <span class="track-dur">${formatDuration(t.duration)}</span>
                  <button class="fav-btn ${t.favorite ? 'active' : ''}" data-id="${t.id}" title="${t.favorite ? 'Remove from favorites' : 'Add to favorites'}">${t.favorite ? '♥' : '♡'}</button>
                  <button class="play-next-btn" data-id="${t.id}" title="Play next">⏭</button>
                  <button class="add-to-queue-btn" data-id="${t.id}" title="Add to queue">📃</button>
                  <button class="radio-track-btn" data-id="${t.id}" title="Start Radio from this track">📻</button>
                  <button class="add-to-playlist-btn" data-id="${t.id}" title="Add to playlist">+</button>
                </li>`
              )
              .join('')}
          </ul>
        </div>`;
      })
      .join('');

    container.querySelectorAll('.play-track-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = data.tracks.find((t) => t.id === id);
        if (track) {
          playTrack(
            { ...track, artist: data.artist },
            data.tracks.map((t) => ({ ...t, artist: data.artist })),
            false,
            { type: 'artist', name: data.artist }
          );
        }
      });
    });

    container.querySelectorAll('.play-next-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = data.tracks.find((t) => t.id === id);
        if (track) playNext({ ...track, artist: data.artist });
      });
    });

    container.querySelectorAll('.add-to-queue-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = data.tracks.find((t) => t.id === id);
        if (track) addToQueue({ ...track, artist: data.artist });
      });
    });

    container.querySelectorAll('.add-to-playlist-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddToPlaylistPopover(parseInt(btn.dataset.id, 10), btn);
      });
    });

    container.querySelectorAll('.radio-track-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRadio(parseInt(btn.dataset.id, 10), btn);
      });
    });

    container.querySelectorAll('.fav-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(parseInt(btn.dataset.id, 10), btn);
      });
    });

    if (opts.scrollToAlbum) {
      const target = [...container.querySelectorAll('.album-block')].find((b) => b.dataset.album === opts.scrollToAlbum);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.classList.add('flash-highlight');
        setTimeout(() => target.classList.remove('flash-highlight'), 1500);
      }
    }
  }

  // ---------- Albums ----------
  async function loadAlbums() {
    const data = await fetch('/api/albums').then((r) => r.json());
    const grid = el('albumGrid');
    grid.innerHTML = data.albums
      .map((a) => {
        const coverUrl = a.album_key ? `/api/cover/album/${encodeURIComponent(a.album_key)}` : placeholderSvg(a.album);
        return `
      <div class="album-card" data-album-key="${escapeAttr(a.album_key || '')}">
        <img class="album-cover" loading="lazy" src="${coverUrl}" onerror="this.src='${placeholderSvg(a.album)}'">
        <div class="name">${escapeHtml(a.album)}</div>
        <div class="meta">${escapeHtml(a.artist || 'Unknown artist')}${a.year ? ' · ' + a.year : ''}</div>
      </div>`;
      })
      .join('');

    grid.querySelectorAll('.album-card').forEach((card) => {
      if (!card.dataset.albumKey) return;
      card.addEventListener('click', () => openAlbumDetail(card.dataset.albumKey));
    });

    grid.querySelectorAll('.album-cover').forEach((img) => {
      const albumKey = img.closest('.album-card').dataset.albumKey;
      if (!albumKey) return;
      wireCoverPreview(img, () => img.src, () => openAlbumDetail(albumKey));
    });
  }

  let currentAlbumDetail = null;

  async function openAlbumDetail(albumKey) {
    if (!albumKey) return;
    const data = await fetch(`/api/albums/${encodeURIComponent(albumKey)}`).then((r) => r.json());
    if (data.error) return;
    currentAlbumDetail = data;
    state.view = 'albumDetail';
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    el('albumDetailView').classList.add('active');
    el('filtersBar').style.display = 'none';
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));

    el('albumDetailName').textContent = data.album;
    const artistLink = el('albumDetailArtist');
    artistLink.textContent = data.artist || 'Unknown artist';
    artistLink.onclick = data.artist ? () => openArtistDetail(data.artist) : null;
    artistLink.style.cursor = data.artist ? 'pointer' : 'default';

    const totalDuration = data.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    el('albumDetailMeta').textContent =
      `${data.year || 'Unknown year'} · ${data.track_count} track${data.track_count === 1 ? '' : 's'} · ${formatDuration(totalDuration)}`;

    const coverEl = el('albumDetailCover');
    coverEl.src = data.has_cover ? `/api/cover/album/${encodeURIComponent(albumKey)}` : placeholderSvg(data.album);
    coverEl.onerror = () => { coverEl.src = placeholderSvg(data.album); };

    loadAlbumLastfmInfo(albumKey);

    const list = el('albumDetailTrackList');
    list.innerHTML = data.tracks
      .map(
        (t) => `<li data-id="${t.id}" class="${state.playingTrackId === t.id ? 'playing' : ''}">
          <button class="play-track-btn" data-id="${t.id}" title="Play">▶</button>
          <span class="at-title">${t.track_no ? t.track_no + '. ' : ''}${escapeHtml(t.title || '—')}</span>
          <span class="track-plays" title="${t.play_count || 0} play${t.play_count === 1 ? '' : 's'}${t.last_played_at ? ` · last played ${formatRelativeTime(t.last_played_at)}` : ''}">${t.play_count || 0}×</span>
          <span class="track-dur">${formatDuration(t.duration)}</span>
          <button class="fav-btn ${t.favorite ? 'active' : ''}" data-id="${t.id}" title="${t.favorite ? 'Remove from favorites' : 'Add to favorites'}">${t.favorite ? '♥' : '♡'}</button>
          <button class="play-next-btn" data-id="${t.id}" title="Play next">⏭</button>
          <button class="add-to-queue-btn" data-id="${t.id}" title="Add to queue">📃</button>
          <button class="radio-track-btn" data-id="${t.id}" title="Start Radio from this track">📻</button>
          <button class="add-to-playlist-btn" data-id="${t.id}" title="Add to playlist">+</button>
        </li>`
      )
      .join('');

    list.querySelectorAll('.play-track-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = data.tracks.find((t) => t.id === id);
        if (track) playTrack(track, data.tracks, false, { type: 'album', name: data.album });
      });
    });

    list.querySelectorAll('.play-next-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = data.tracks.find((t) => t.id === id);
        if (track) playNext(track);
      });
    });

    list.querySelectorAll('.add-to-queue-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = data.tracks.find((t) => t.id === id);
        if (track) addToQueue(track);
      });
    });

    list.querySelectorAll('.add-to-playlist-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddToPlaylistPopover(parseInt(btn.dataset.id, 10), btn);
      });
    });

    list.querySelectorAll('.radio-track-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRadio(parseInt(btn.dataset.id, 10), btn);
      });
    });

    list.querySelectorAll('.fav-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(parseInt(btn.dataset.id, 10), btn);
      });
    });
  }

  el('backToAlbums').addEventListener('click', () => switchView('albums'));

  // ---------- Last.fm album info ----------
  let lastfmRequestAlbumKey = null; // guards against a slow response landing after the user moved on

  async function loadAlbumLastfmInfo(albumKey, { force = false } = {}) {
    lastfmRequestAlbumKey = albumKey;
    el('albumLastfmSection').innerHTML = `<p class="muted">Loading album info…</p>`;

    let result;
    try {
      const params = force ? '?refresh=1' : '';
      result = await fetch(`/api/albums/${encodeURIComponent(albumKey)}/lastfm${params}`).then((r) => r.json());
    } catch {
      result = { configured: true, status: 'error', message: 'Request failed' };
    }

    if (lastfmRequestAlbumKey !== albumKey) return; // user switched albums while this was in flight
    renderAlbumLastfm(albumKey, result);
  }

  function renderAlbumLastfm(albumKey, result) {
    const section = el('albumLastfmSection');

    if (!result.configured) {
      section.innerHTML = `
        <div class="lastfm-note">
          Album info comes from <a href="https://www.last.fm" target="_blank" rel="noopener">Last.fm</a>,
          but this app doesn't have an API key configured yet. It's free —
          <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">get one here</a>
          and set <code>LASTFM_API_KEY</code> in your <code>.env</code> (see the README).
        </div>`;
      return;
    }

    if (result.status === 'not_found') {
      section.innerHTML = `
        <div class="lastfm-note">
          No Last.fm entry found for this album.
          <button class="lastfm-refresh" id="albumLastfmRetryBtn">Try again</button>
        </div>`;
      el('albumLastfmRetryBtn').addEventListener('click', () => loadAlbumLastfmInfo(albumKey, { force: true }));
      return;
    }

    if (result.status === 'error' || !result.album) {
      section.innerHTML = `
        <div class="lastfm-note">
          Couldn't reach Last.fm right now${result.message ? ` (${escapeHtml(result.message)})` : ''}.
          <button class="lastfm-refresh" id="albumLastfmRetryBtn">Retry</button>
        </div>`;
      el('albumLastfmRetryBtn').addEventListener('click', () => loadAlbumLastfmInfo(albumKey, { force: true }));
      return;
    }

    const a = result.album;
    const bio = a.wiki_summary || '';
    const bioIsLong = bio.length > 320;
    const shortBio = bioIsLong ? bio.slice(0, 320).replace(/\s+\S*$/, '') + '…' : bio;

    const tagsHtml = a.tags.length
      ? `<div class="pill-row"><span class="pill-label">Tags</span>${a.tags
          .map((t) => `<a class="pill" href="${escapeAttr(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a>`)
          .join('')}</div>`
      : '';

    const statsText = a.listeners
      ? `${a.listeners.toLocaleString()} listeners · ${a.playcount.toLocaleString()} plays`
      : '';

    section.innerHTML = `
      <div class="lastfm-header">
        <h3>About this album</h3>
        <span class="lastfm-stats">${statsText}</span>
      </div>
      ${bio ? `<p class="lastfm-bio" id="albumLastfmBioText">${escapeHtml(bioIsLong ? shortBio : bio)}</p>` : ''}
      ${bioIsLong ? `<button class="lastfm-bio-toggle" id="albumLastfmBioToggle">Show more</button>` : ''}
      ${tagsHtml}
      <div class="lastfm-link">
        <a href="${escapeAttr(a.url)}" target="_blank" rel="noopener">View on Last.fm</a>
        · <button class="lastfm-refresh" id="albumLastfmRefreshBtn">Refresh${result.cached ? ' (cached)' : ''}</button>
      </div>
    `;

    if (bioIsLong) {
      let expanded = false;
      el('albumLastfmBioToggle').addEventListener('click', () => {
        expanded = !expanded;
        el('albumLastfmBioText').textContent = expanded ? bio : shortBio;
        el('albumLastfmBioToggle').textContent = expanded ? 'Show less' : 'Show more';
      });
    }
    el('albumLastfmRefreshBtn').addEventListener('click', () => loadAlbumLastfmInfo(albumKey, { force: true }));
  }

  // ---------- Last.fm artist info ----------
  let lastfmRequestArtist = null; // guards against a slow response landing after the user moved on

  async function loadLastfmInfo(artist, { force = false } = {}) {
    lastfmRequestArtist = artist;
    el('lastfmSection').innerHTML = `<p class="muted">Loading artist info…</p>`;

    let result;
    try {
      const params = force ? '?refresh=1' : '';
      result = await fetch(`/api/artists/${encodeURIComponent(artist)}/lastfm${params}`).then((r) => r.json());
    } catch {
      result = { configured: true, status: 'error', message: 'Request failed' };
    }

    if (lastfmRequestArtist !== artist) return; // user switched artists while this was in flight
    renderLastfm(artist, result);
  }

  function renderLastfm(artist, result) {
    const section = el('lastfmSection');

    if (!result.configured) {
      section.innerHTML = `
        <div class="lastfm-note">
          Artist bios, tags, and similar artists come from <a href="https://www.last.fm" target="_blank" rel="noopener">Last.fm</a>,
          but this app doesn't have an API key configured yet. It's free —
          <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">get one here</a>
          and set <code>LASTFM_API_KEY</code> in your <code>.env</code> (see the README).
        </div>`;
      return;
    }

    if (result.status === 'not_found') {
      section.innerHTML = `
        <div class="lastfm-note">
          No Last.fm entry found for "${escapeHtml(artist)}".
          <button class="lastfm-refresh" id="lastfmRetryBtn">Try again</button>
        </div>`;
      el('lastfmRetryBtn').addEventListener('click', () => loadLastfmInfo(artist, { force: true }));
      return;
    }

    if (result.status === 'error' || !result.artist) {
      section.innerHTML = `
        <div class="lastfm-note">
          Couldn't reach Last.fm right now${result.message ? ` (${escapeHtml(result.message)})` : ''}.
          <button class="lastfm-refresh" id="lastfmRetryBtn">Retry</button>
        </div>`;
      el('lastfmRetryBtn').addEventListener('click', () => loadLastfmInfo(artist, { force: true }));
      return;
    }

    const a = result.artist;
    const bio = a.bio_summary || '';
    const bioIsLong = bio.length > 320;
    const shortBio = bioIsLong ? bio.slice(0, 320).replace(/\s+\S*$/, '') + '…' : bio;

    const tagsHtml = a.tags.length
      ? `<div class="pill-row"><span class="pill-label">Tags</span>${a.tags
          .map((t) => `<a class="pill" href="${escapeAttr(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a>`)
          .join('')}</div>`
      : '';

    const similarHtml = a.similar.length
      ? `<div class="pill-row"><span class="pill-label">Similar</span>${a.similar
          .map((s) => `<a class="pill" href="${escapeAttr(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>`)
          .join('')}</div>`
      : '';

    const statsText = a.listeners
      ? `${a.listeners.toLocaleString()} listeners · ${a.playcount.toLocaleString()} plays`
      : '';

    section.innerHTML = `
      <div class="lastfm-header">
        <h3>About</h3>
        <span class="lastfm-stats">${statsText}</span>
      </div>
      ${bio ? `<p class="lastfm-bio" id="lastfmBioText">${escapeHtml(bioIsLong ? shortBio : bio)}</p>` : ''}
      ${bioIsLong ? `<button class="lastfm-bio-toggle" id="lastfmBioToggle">Show more</button>` : ''}
      ${tagsHtml}
      ${similarHtml}
      <div class="lastfm-link">
        <a href="${escapeAttr(a.url)}" target="_blank" rel="noopener">View on Last.fm</a>
        · <button class="lastfm-refresh" id="lastfmRefreshBtn">Refresh${result.cached ? ' (cached)' : ''}</button>
      </div>
    `;

    if (bioIsLong) {
      let expanded = false;
      el('lastfmBioToggle').addEventListener('click', () => {
        expanded = !expanded;
        el('lastfmBioText').textContent = expanded ? bio : shortBio;
        el('lastfmBioToggle').textContent = expanded ? 'Show less' : 'Show more';
      });
    }
    el('lastfmRefreshBtn').addEventListener('click', () => loadLastfmInfo(artist, { force: true }));
  }

  // ---------- Picture hover-preview (artist photos & album covers) ----------
  // Shared by the Artists/Albums grids, the small album thumbnails on an artist's own page, and
  // the big photo/cover on an artist's or album's own detail page: hovering pops up a bigger
  // version near the cursor, and — where there's somewhere useful to go — clicking it navigates
  // there (e.g. an album thumbnail on an artist's page opens that album). Since the popup sits
  // a few pixels away from whatever you hovered, it tracks its own mouseenter/mouseleave (with
  // a short grace delay) so moving the mouse across that gap to actually click it doesn't just
  // close it first.
  let coverPreviewHideTimer = null;
  let coverPreviewClickHandler = null;

  function showCoverPreview(anchorEl, imageUrl, onClick) {
    clearTimeout(coverPreviewHideTimer);
    const preview = el('coverPreview');
    el('coverPreviewImg').src = imageUrl;
    preview.hidden = false;
    preview.classList.toggle('clickable', !!onClick);
    preview.title = onClick ? 'Click to open' : '';

    if (coverPreviewClickHandler) preview.removeEventListener('click', coverPreviewClickHandler);
    coverPreviewClickHandler = onClick
      ? () => {
          hideCoverPreview();
          onClick();
        }
      : null;
    if (coverPreviewClickHandler) preview.addEventListener('click', coverPreviewClickHandler);

    const rect = anchorEl.getBoundingClientRect();
    const size = 220; // keep in sync with .cover-preview img width/height in styles.css
    let left = rect.right + 12;
    if (left + size + 16 > window.innerWidth) left = rect.left - size - 12;
    if (left < 8) left = 8;
    let top = rect.top;
    if (top + size + 16 > window.innerHeight) top = window.innerHeight - size - 16;
    if (top < 8) top = 8;
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
  }

  function scheduleHideCoverPreview() {
    clearTimeout(coverPreviewHideTimer);
    coverPreviewHideTimer = setTimeout(hideCoverPreview, 150);
  }

  function hideCoverPreview() {
    clearTimeout(coverPreviewHideTimer);
    el('coverPreview').hidden = true;
  }

  // Hovering onto the popup itself (crossing the gap from whatever thumbnail triggered it)
  // keeps it open; leaving it (without landing back on a trigger) closes it on the same delay.
  el('coverPreview').addEventListener('mouseenter', () => clearTimeout(coverPreviewHideTimer));
  el('coverPreview').addEventListener('mouseleave', scheduleHideCoverPreview);

  // Wires one image element to open the shared preview on hover. getImageUrl is a function
  // (not a plain string) since a couple of callers want to re-resolve it at hover time — e.g. a
  // grid thumbnail may have already fallen back to a placeholder via onerror by then, and the
  // preview should show that same fallback rather than re-requesting the original URL and
  // failing again. onClick is optional; omit it for a picture with nowhere new to go (you're
  // already on that artist's/album's own page).
  function wireCoverPreview(imgEl, getImageUrl, onClick) {
    imgEl.addEventListener('mouseenter', () => showCoverPreview(imgEl, getImageUrl(), onClick));
    imgEl.addEventListener('mouseleave', scheduleHideCoverPreview);
  }

  function findTrackInArtistDetail(id) {
    if (!currentArtistDetail) return null;
    return currentArtistDetail.tracks.find((t) => t.id === id);
  }

  // The big photo/cover on an artist's or album's own detail page — wired once (these elements
  // are reused across visits, only their .src changes) rather than in openArtistDetail/
  // openAlbumDetail. No onClick: you're already on that artist's/album's own page, so there's
  // nowhere new for it to go — it's just a closer look at the picture.
  wireCoverPreview(el('artistDetailPhoto'), () => el('artistDetailPhoto').src, null);
  wireCoverPreview(el('albumDetailCover'), () => el('albumDetailCover').src, null);

  el('backToArtists').addEventListener('click', () => { hideCoverPreview(); switchView('artists'); });

  // ---------- Artist detail sub-tabs (Artist Info / Albums & Tracks) ----------
  function switchArtistSubview(subview) {
    hideCoverPreview();
    document.querySelectorAll('#artistDetailView .subtab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.subview === subview);
    });
    el('artistInfoView').classList.toggle('active', subview === 'info');
    el('artistAlbums').classList.toggle('active', subview === 'tracks');
  }

  document.querySelectorAll('#artistDetailView .subtab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchArtistSubview(btn.dataset.subview));
  });

  // ---------- Player ----------
  // `audio` always points at whichever physical <audio> element is "active" right now. For
  // ordinary (crossfade-off) playback this never changes, so it behaves exactly like the plain
  // const it used to be. Crossfading (see "Gapless crossfade" further down) reassigns it once a
  // ramp completes, so the rest of the player code — which just reads/writes audio.* — keeps
  // working unmodified whichever physical element is actually live.
  let audio = el('audioEl');
  let audioAlt = el('audioEl2');
  let playQueue = [];
  // Shuffle only reorders PLAYBACK within whatever queue is currently loaded — it never changes
  // which tracks are in a playlist. shuffleUpcoming holds the still-to-play order for the
  // current queue (regenerated whenever a fresh queue starts playing, or shuffle is switched on
  // mid-playback); the 'ended' handler below just shifts tracks off it instead of stepping
  // through playQueue in order.
  let shuffleUpcoming = [];

  // Holds { track, position } for a track restored from a previous visit (see "Resume where
  // you left off" below) that hasn't actually started loading/playing yet — the player bar
  // shows its title/cover/position, but audio.src is deliberately left unset until the user
  // presses ▶ themselves, rather than the page silently starting a network fetch (or risking
  // autoplay) on load. Cleared as soon as any real playback starts.
  let pendingResume = null;

  // ---------- Gapless crossfade state (functions further down, after playTrack) ----------
  // true from the moment a crossfade ramp has been kicked off for the current track until it
  // either finishes (handing off to the next track) or is cancelled — prevents starting a
  // second overlapping ramp and tells the natural 'ended' handler to stand down.
  let crossfadeArmed = false;
  let crossfadeRampHandle = null; // requestAnimationFrame id for the in-progress ramp, if any

  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // currentQueueMeta describes whatever queue is behind the current playback — a real saved
  // playlist ({ type: 'playlist', id, name }), or any other queue-starting action (Tracks tab,
  // an artist/album, Radio, Shuffle All, Rediscover, History, …), each passing its own
  // { type, name }. The Now Playing panel (📃) shows this queue regardless of type; only an
  // actual playlist auto-opens the panel the moment it starts (see applyTrackState below) —
  // everything else just keeps 📃 available so you can open it if you want to see what's queued.
  let currentQueueMeta = null;

  function playTrack(track, queue, isAdvance = false, queueMeta = null) {
    cancelCrossfade();
    pendingResume = null;
    playQueue = queue || [track];
    if (state.shuffle && !isAdvance) {
      shuffleUpcoming = shuffleArray(playQueue.filter((t) => t.id !== track.id));
    }
    audio.src = `/api/stream/${track.id}`;
    audio.play().catch(() => {});
    applyTrackState(track, isAdvance, queueMeta);
  }

  // Everything about a track becoming "the one playing" that ISN'T starting its audio element —
  // player-bar UI, Now Playing panel, row highlighting, resume state, Last.fm now-playing/
  // scrobble scheduling. Split out from playTrack so a crossfade handoff (finishCrossfade,
  // below) can run all of this without re-triggering audio.src/audio.play() and restarting the
  // already-mid-playback incoming track from position 0.
  function applyTrackState(track, isAdvance, queueMeta) {
    state.playingTrackId = track.id;
    crossfadeArmed = false;
    el('playerTitle').textContent = track.title || track.filename || 'Unknown title';
    el('playerSub').textContent = [track.artist, track.album].filter(Boolean).join(' — ');
    el('playerCover').src = `/api/cover/track/${track.id}`;
    el('playerCover').onerror = () => { el('playerCover').src = placeholderSvg(track.artist || track.title); };
    el('playPauseBtn').textContent = '⏸';

    if (!isAdvance) {
      // A fresh (non-advance) play always starts a "queue" the always-visible Now Playing panel
      // can show — falls back to a generic label if whoever started this play didn't pass one.
      currentQueueMeta = queueMeta || { type: 'queue', name: 'Now Playing' };
      renderNowPlayingPanel(playQueue);
      // Only a real saved playlist auto-maximizes the panel if it was minimized, same as it's
      // always auto-opened — every other queue type just updates the (already-visible) panel's
      // content without changing whether it's minimized.
      if (currentQueueMeta.type === 'playlist') {
        setNowPlayingPanelMinimized(false);
      }
      saveQueueSnapshot();
    }
    // isAdvance with no explicit queueMeta (the natural 'ended' handler, or a crossfade handoff)
    // is a continuation of whatever queue was already showing — highlightPlaying() below just
    // moves the highlighted row rather than rebuilding the whole list.

    highlightPlaying();
    saveResumeState();

    notifyLastfmNowPlaying(track);
    scheduleLastfmScrobble(track);
  }

  // ---------- Last.fm scrobbling ----------
  // Rides along with every track play; the server endpoint silently no-ops whenever Last.fm
  // isn't connected (see Settings above), so this never needs to know or care about that itself.
  function notifyLastfmNowPlaying(track) {
    fetch('/api/lastfm/now-playing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: track.id }),
    }).catch(() => {});
  }

  let scrobbleTimer = null;

  // Schedules a scrobble submission per Last.fm's own eligibility rule: only tracks longer than
  // 30s are eligible at all, and a scrobble fires once the track has played at least half its
  // duration or 4 minutes — whichever is LOWER. Re-armed every time a new track starts (both
  // playTrack and finishCrossfade funnel through applyTrackState above), so switching tracks
  // before the threshold never scrobbles the one that got abandoned.
  function scheduleLastfmScrobble(track) {
    if (scrobbleTimer) {
      clearTimeout(scrobbleTimer);
      scrobbleTimer = null;
    }
    const duration = track.duration;
    if (!duration || duration <= 30) return;
    const thresholdMs = Math.min(duration / 2, 240) * 1000;
    const scrobbleTrackId = track.id;
    scrobbleTimer = setTimeout(() => {
      scrobbleTimer = null;
      // Only scrobble if this is still the track actually playing — a stale timer firing after
      // the user paused, skipped, or switched tracks must never scrobble the wrong one.
      if (state.playingTrackId !== scrobbleTrackId || audio.paused) return;
      fetch('/api/lastfm/scrobble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: scrobbleTrackId }),
      }).catch(() => {});
    }, thresholdMs);
  }

  // ---------- Gapless crossfade (optional — off by default; enabled in Settings above) ----------
  // Returns the next track natural playback would advance to, WITHOUT consuming it from
  // shuffleUpcoming — used to peek ahead for the crossfade trigger below. Mirrors the decision
  // consumeNextTrack() makes so both agree on what "next" means.
  function peekNextTrack() {
    if (state.shuffle) {
      return shuffleUpcoming.length ? shuffleUpcoming[0] : null;
    }
    const idx = playQueue.findIndex((t) => t.id === state.playingTrackId);
    return idx >= 0 && idx < playQueue.length - 1 ? playQueue[idx + 1] : null;
  }

  // Returns the next track AND consumes it (shifts it off shuffleUpcoming when shuffling) —
  // called once playback is actually moving on to it, whether that's the natural 'ended' event
  // or a crossfade ramp completing, so the two paths can never double-advance or skip a track.
  function consumeNextTrack() {
    if (state.shuffle) {
      return shuffleUpcoming.length ? shuffleUpcoming.shift() : null;
    }
    const idx = playQueue.findIndex((t) => t.id === state.playingTrackId);
    return idx >= 0 && idx < playQueue.length - 1 ? playQueue[idx + 1] : null;
  }

  // Checked on every timeupdate of the currently-active element (see handleTimeUpdate below).
  // Starts the crossfade ramp once per track, crossfadeSettings.seconds before its natural end —
  // only when crossfade is enabled, nothing's already ramping, and there's actually a next track
  // queued up (a track with nothing after it just plays out normally either way).
  function maybeStartCrossfade() {
    if (!crossfadeSettings.enabled || crossfadeArmed) return;
    if (!audio.duration || !isFinite(audio.duration)) return;
    if (audio.duration - audio.currentTime > crossfadeSettings.seconds) return;
    const next = peekNextTrack();
    if (!next) return;
    crossfadeArmed = true;
    startCrossfade(next);
  }

  // Begins overlap playback: loads `next` into the currently-inactive element and ramps volume
  // from the outgoing (still-active) element to it over crossfadeSettings.seconds, reading the
  // live volume slider each frame so a mid-ramp volume change is respected. The outgoing element
  // is left actually playing throughout — only its volume is touched — so cancelCrossfade can
  // always put things back to a normal playing state if the ramp gets interrupted.
  function startCrossfade(next) {
    const outgoing = audio;
    const incoming = audioAlt;
    const nextTrack = next;
    const liveVolume = () => {
      const v = parseInt(el('volumeSlider').value, 10);
      return isNaN(v) ? outgoing.volume : v / 100;
    };

    incoming.muted = outgoing.muted;
    incoming.volume = 0;
    incoming.src = `/api/stream/${next.id}`;
    incoming.play().catch(() => {
      // Couldn't start the incoming track (network hiccup, etc.) — abandon the crossfade and
      // let the natural 'ended' handler advance to it the normal way instead.
      cancelCrossfade();
    });

    const startTime = performance.now();
    const durationMs = Math.max(1, crossfadeSettings.seconds * 1000);

    function tick(now) {
      if (!crossfadeArmed) return; // cancelled mid-ramp
      // Clamped at BOTH ends — the upper bound caps the ramp length, and the lower bound guards
      // against `now` (the rAF timestamp) landing a hair before `startTime` (a performance.now()
      // call moments earlier), which happens occasionally due to timestamp-precision rounding
      // and would otherwise make t negative, pushing v*(1-t) above 1 and throwing.
      const t = Math.min(1, Math.max(0, (now - startTime) / durationMs));
      const v = liveVolume();
      outgoing.volume = v * (1 - t);
      incoming.volume = v * t;
      if (t < 1) {
        crossfadeRampHandle = requestAnimationFrame(tick);
      } else {
        finishCrossfade(nextTrack, outgoing, incoming, v);
      }
    }
    crossfadeRampHandle = requestAnimationFrame(tick);
  }

  // Ramp reached the end: hand off "active" status from outgoing to incoming (which has been
  // playing, faded in, this whole time — never restarted), then run the same bookkeeping a
  // normal advance would via applyTrackState. audio.src/audio.play() are deliberately NOT
  // touched here — that's the whole point of the playTrack/applyTrackState split above.
  function finishCrossfade(next, outgoing, incoming, finalVolume) {
    crossfadeRampHandle = null;
    crossfadeArmed = false;

    outgoing.pause();
    outgoing.volume = finalVolume; // restored so it's correct next time this element is reused
    incoming.volume = finalVolume;

    audio = incoming;
    audioAlt = outgoing;

    consumeNextTrack(); // keeps shuffleUpcoming/index bookkeeping in sync with the handoff above
    applyTrackState(next, true, null);
  }

  // Aborts an in-flight ramp and restores the still-active outgoing element to a normal playing
  // state. Called whenever playback moves on some other way while a ramp is running (the user
  // starts, pauses, or seeks a track manually) — and it's a total no-op whenever no ramp is
  // running, which is the default (crossfade off) path, so this can never affect default
  // playback.
  function cancelCrossfade() {
    if (!crossfadeArmed) return;
    crossfadeArmed = false;
    if (crossfadeRampHandle) {
      cancelAnimationFrame(crossfadeRampHandle);
      crossfadeRampHandle = null;
    }
    try {
      audio.volume = parseInt(el('volumeSlider').value, 10) / 100;
    } catch {}
    // The incoming element never became active — stop it and drop what it had loaded.
    audioAlt.pause();
    audioAlt.removeAttribute('src');
  }

  function highlightPlaying() {
    document.querySelectorAll('.track-row').forEach((row) => {
      row.classList.toggle('playing', parseInt(row.dataset.id, 10) === state.playingTrackId);
    });
    document.querySelectorAll('.album-track-list li').forEach((li) => {
      li.classList.toggle('playing', parseInt(li.dataset.id, 10) === state.playingTrackId);
    });
    document.querySelectorAll('.playlist-track-list li').forEach((li) => {
      li.classList.toggle('playing', parseInt(li.dataset.id, 10) === state.playingTrackId);
    });
    document.querySelectorAll('.now-playing-list li').forEach((li) => {
      const isPlaying = parseInt(li.dataset.id, 10) === state.playingTrackId;
      li.classList.toggle('playing', isPlaying);
      if (isPlaying) li.scrollIntoView({ block: 'nearest' });
    });
  }

  // Keeps the panel's .minimized class, the –/▢ buttons' shown/hidden state, and the saved
  // preference (so minimizing/maximizing it sticks across visits, same as volume/crossfade) all
  // in sync in one place. The panel itself is always on screen now — this only ever changes its
  // size, never whether it's there at all.
  function setNowPlayingPanelMinimized(minimized) {
    el('nowPlayingPanel').classList.toggle('minimized', minimized);
    el('nowPlayingMinimize').hidden = minimized;
    el('nowPlayingMaximize').hidden = !minimized;
    try { localStorage.setItem('mp3lib_np_minimized', minimized ? '1' : '0'); } catch {}
  }

  // Demotes a live 'playlist' queue to a generic 'queue' the moment its contents are manually
  // customized (reordered, or a track added/removed) — a real playlist queue is normally
  // restored on reload by re-fetching the playlist fresh (so it picks up edits made elsewhere
  // in the app), which would silently discard a manual reorder/removal made here instead. Once
  // customized it's no longer "that playlist", so restoring falls back to the saved track-id
  // snapshot (see saveQueueSnapshot/restoreResumeState) like any other non-playlist queue.
  function demoteQueueMetaIfCustomized() {
    if (currentQueueMeta && currentQueueMeta.type === 'playlist') {
      currentQueueMeta = { type: 'queue', name: currentQueueMeta.name };
    }
  }

  // Drops any existing occurrence of `trackId` from playQueue in place — used before inserting a
  // track via playNext/addToQueue below so a track already sitting somewhere in the queue gets
  // MOVED to the new spot rather than ending up listed twice under the same id. A duplicated id
  // isn't just a cosmetic double row: next/prev navigation and highlightPlaying() all resolve
  // "where is the current track" via playQueue.findIndex(id), which would silently resolve to
  // whichever occurrence comes first if the currently-playing id itself were ever duplicated.
  function spliceFromQueue(trackId) {
    const idx = playQueue.findIndex((t) => t.id === trackId);
    if (idx !== -1) playQueue.splice(idx, 1);
  }

  // Inserts `track` immediately after whatever's currently playing — the "⏭ Play next" action on
  // track rows. With nothing currently playing, there's no "after" to insert at, so this just
  // starts playing it instead (matching what a first-time user would expect from the button).
  function playNext(track) {
    if (!playQueue.length || state.playingTrackId == null) {
      playTrack(track, [track], false, { type: 'queue', name: 'Now Playing' });
      return;
    }
    if (track.id === state.playingTrackId) return; // already the one playing right now
    spliceFromQueue(track.id);
    const idx = playQueue.findIndex((t) => t.id === state.playingTrackId);
    playQueue.splice(idx + 1, 0, track);
    if (state.shuffle) {
      shuffleUpcoming = shuffleUpcoming.filter((t) => t.id !== track.id);
      shuffleUpcoming.unshift(track);
    }
    demoteQueueMetaIfCustomized();
    renderNowPlayingPanel(playQueue);
    saveQueueSnapshot();
  }

  // Appends `track` to the end of the current queue — the "📃 Add to queue" action on track
  // rows. Same "nothing playing yet" fallback as playNext above.
  function addToQueue(track) {
    if (!playQueue.length || state.playingTrackId == null) {
      playTrack(track, [track], false, { type: 'queue', name: 'Now Playing' });
      return;
    }
    if (track.id === state.playingTrackId) return; // already the one playing right now
    spliceFromQueue(track.id);
    playQueue.push(track);
    if (state.shuffle) {
      shuffleUpcoming = shuffleUpcoming.filter((t) => t.id !== track.id);
      shuffleUpcoming.push(track);
    }
    demoteQueueMetaIfCustomized();
    renderNowPlayingPanel(playQueue);
    saveQueueSnapshot();
  }

  // Removes one track from the live queue (the Now Playing panel's ✕ button) — the
  // currently-playing track itself is never offered this button (see renderNowPlayingPanel), so
  // this only ever removes something other than what's actively playing right now.
  function removeFromQueue(trackId) {
    if (playQueue.findIndex((t) => t.id === trackId) === -1) return;
    spliceFromQueue(trackId);
    shuffleUpcoming = shuffleUpcoming.filter((t) => t.id !== trackId);
    demoteQueueMetaIfCustomized();
    renderNowPlayingPanel(playQueue);
    saveQueueSnapshot();
  }

  // Builds the Now Playing panel's track list for whatever queue is currently behind playback
  // (currentQueueMeta above) — a real playlist or any other queue source, or a placeholder if
  // nothing's playing yet. Re-run each time a fresh (non-advance) play starts, or the queue
  // itself is edited (reorder/remove/play next/add to queue); natural track-to-track advances
  // just update the highlight via highlightPlaying() above rather than rebuilding this list.
  function renderNowPlayingPanel(tracks) {
    el('nowPlayingTitle').textContent = currentQueueMeta ? currentQueueMeta.name : 'Now Playing';
    const list = el('nowPlayingList');
    if (!tracks || !tracks.length) {
      list.innerHTML = `<div class="now-playing-empty">Nothing playing yet — play a track to see its queue here.</div>`;
      return;
    }
    // Reordering only makes sense against playQueue's own order — while shuffle is on, what
    // actually plays next comes from the separate shuffleUpcoming list instead (see
    // peekNextTrack/consumeNextTrack), so dragging here wouldn't do anything to real playback
    // order. Simplest to just not offer it in that state rather than silently not working.
    const canReorder = !state.shuffle;
    list.innerHTML = tracks
      .map((t) => {
        const isPlaying = state.playingTrackId === t.id;
        return `
      <li data-id="${t.id}" class="${isPlaying ? 'playing' : ''}" ${canReorder ? 'draggable="true"' : ''}>
        ${canReorder ? '<span class="np-drag-handle" title="Drag to reorder">⠿</span>' : ''}
        <img class="np-cover" loading="lazy" src="/api/cover/track/${t.id}" onerror="this.src='${placeholderSvg(t.artist || t.title)}'">
        <div class="np-info">
          <div class="np-title">${escapeHtml(t.title || '—')}</div>
          <div class="np-sub">${escapeHtml(t.artist || '')}</div>
        </div>
        <button class="np-play-btn" data-id="${t.id}" title="Play">▶</button>
        ${isPlaying ? '' : `<button class="np-remove-btn" data-id="${t.id}" title="Remove from queue">✕</button>`}
      </li>`;
      })
      .join('');

    list.querySelectorAll('.np-play-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        const track = tracks.find((t) => t.id === id);
        if (track) playTrack(track, tracks, false, currentQueueMeta);
      });
    });

    list.querySelectorAll('.np-remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromQueue(parseInt(btn.dataset.id, 10));
      });
    });

    if (canReorder) {
      list.querySelectorAll('li[data-id]').forEach((li) => wireQueueDragAndDrop(li));
    }
  }

  // ---------- Drag-and-drop queue reordering (Now Playing panel) ----------
  // Mirrors the playlist drag-and-drop further down, but purely client-side: there's no
  // server-side "queue" to persist a reorder to, so a drop just reorders playQueue in memory and
  // re-saves the localStorage queue snapshot instead of calling a reorder API.
  let queueDragSrcLi = null;

  function wireQueueDragAndDrop(li) {
    li.addEventListener('dragstart', () => {
      queueDragSrcLi = li;
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      queueDragSrcLi = null;
      document.querySelectorAll('#nowPlayingList li').forEach((row) => row.classList.remove('drag-over-top', 'drag-over-bottom'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!queueDragSrcLi || queueDragSrcLi === li) return;
      const rect = li.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      li.classList.toggle('drag-over-top', before);
      li.classList.toggle('drag-over-bottom', !before);
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const before = li.classList.contains('drag-over-top');
      li.classList.remove('drag-over-top', 'drag-over-bottom');
      if (!queueDragSrcLi || queueDragSrcLi === li) return;

      const list = el('nowPlayingList');
      if (before) list.insertBefore(queueDragSrcLi, li);
      else list.insertBefore(queueDragSrcLi, li.nextSibling);

      const ids = [...list.querySelectorAll('li[data-id]')].map((l) => parseInt(l.dataset.id, 10));
      const byId = new Map(playQueue.map((t) => [t.id, t]));
      playQueue = ids.map((id) => byId.get(id)).filter(Boolean);
      demoteQueueMetaIfCustomized();
      saveQueueSnapshot();
    });
  }

  el('nowPlayingMinimize').addEventListener('click', () => setNowPlayingPanelMinimized(true));
  el('nowPlayingMaximize').addEventListener('click', () => setNowPlayingPanelMinimized(false));

  // Restore the minimize/maximize preference from last visit (defaults to maximized), and show
  // an empty-state placeholder immediately — the panel is always visible now, even before
  // restoreResumeState (below) has had a chance to know whether there's a queue to restore.
  (function initNowPlayingPanel() {
    let minimized = false;
    try {
      minimized = localStorage.getItem('mp3lib_np_minimized') === '1';
    } catch {}
    setNowPlayingPanelMinimized(minimized);
    renderNowPlayingPanel([]);
  })();

  el('playPauseBtn').addEventListener('click', () => {
    if (!audio.src) {
      // Nothing loaded yet — if the player bar is showing a restored "resume where you left
      // off" track, this first press is what actually starts loading it, at its saved position.
      if (pendingResume) {
        const { track, position, queueMeta } = pendingResume;
        pendingResume = null;
        audio.src = `/api/stream/${track.id}`;
        audio.addEventListener('loadedmetadata', function onLoaded() {
          audio.removeEventListener('loadedmetadata', onLoaded);
          if (position) audio.currentTime = Math.min(position, audio.duration || position);
        });
        audio.play().catch(() => {});
        // Runs the same bookkeeping a fresh play would (Now Playing panel/toggle, Last.fm
        // now-playing/scrobble scheduling) — audio.src/audio.play() are deliberately not
        // touched again here, same reasoning as the crossfade handoff in applyTrackState.
        // queueMeta carries whatever queue restoreResumeState managed to reconstruct (a real
        // playlist, or the Tracks/Shuffle/Radio/etc. queue it was part of); falls back to a
        // generic label only if nothing could be reconstructed (storage blocked, or every track
        // in that queue has since been deleted).
        applyTrackState(track, false, queueMeta || { type: 'queue', name: 'Now Playing' });
      }
      return;
    }
    if (audio.paused) {
      audio.play();
      el('playPauseBtn').textContent = '⏸';
    } else {
      cancelCrossfade();
      audio.pause();
      el('playPauseBtn').textContent = '▶';
    }
  });

  el('shuffleBtn').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    el('shuffleBtn').classList.toggle('active', state.shuffle);
    if (state.shuffle && playQueue.length) {
      shuffleUpcoming = shuffleArray(playQueue.filter((t) => t.id !== state.playingTrackId));
    }
  });

  // Shared by Shuffle All and Rediscover below — both fetch a pre-built queue from the server
  // and start playing it in shuffled order. state.shuffle is turned on (if not already) before
  // playTrack runs, so playTrack regenerates shuffleUpcoming itself from the rest of the queue,
  // and the existing 🔀 machinery keeps randomizing correctly if playback naturally advances
  // from track to track afterwards.
  async function playFetchedQueue(url, btn, busyLabel, queueName) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      const data = await fetch(url).then((r) => r.json());
      if (!data.tracks || !data.tracks.length) return;
      if (!state.shuffle) {
        state.shuffle = true;
        el('shuffleBtn').classList.add('active');
      }
      playTrack(data.tracks[0], data.tracks, false, { type: 'queue', name: queueName });
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // Plays the whole library in random order, ignoring whatever filters happen to be set on the
  // Tracks tab right now — a one-click alternative to building a playlist or filtering down to
  // something first just to get a shuffled queue going. The list comes back pre-randomized from
  // the server (GET /api/tracks/shuffle-all, uncapped unlike the paginated /api/tracks).
  el('shuffleAllBtn').addEventListener('click', () => playFetchedQueue('/api/tracks/shuffle-all', el('shuffleAllBtn'), 'Shuffling…', 'Shuffle All'));

  // Plays a queue biased toward tracks you haven't heard in a while (or ever) — a complementary
  // alternative to Shuffle All's even-odds shuffle across the whole library. See
  // GET /api/tracks/rediscover for how the candidate pool is chosen.
  el('rediscoverBtn').addEventListener('click', () => playFetchedQueue('/api/tracks/rediscover', el('rediscoverBtn'), 'Finding tracks…', 'Rediscover'));

  // ---------- Radio (📻 similar-tracks queue) ----------
  // Starts an ad-hoc queue built around one track (GET /api/tracks/:id/radio — similar artists
  // via cached Last.fm data, falling back to same-genre/same-artist so it still works with no
  // Last.fm key configured). Unlike Shuffle All/Rediscover, this deliberately does NOT touch
  // state.shuffle — the pool the server returns is already randomized, so leaving shuffle as
  // whatever the user last had it keeps "what's up next" showing the actual radio order rather
  // than re-shuffling an already-shuffled list.
  async function startRadio(trackId, btn) {
    const originalText = btn ? btn.textContent : null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '…';
    }
    try {
      const data = await fetch(`/api/tracks/${trackId}/radio`).then((r) => r.json());
      if (!data.tracks || !data.tracks.length) return;
      playTrack(data.tracks[0], data.tracks, false, { type: 'radio', name: 'Radio' });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  // Bound on BOTH physical <audio> elements (rather than just the current `audio` pointer),
  // since crossfading can make either one the active element at any given time — each handler
  // guards on e.target so events from the currently-inactive element are ignored.
  function handleTrackEnded(e) {
    if (e.target !== audio) return;
    if (crossfadeArmed) {
      // A crossfade ramp already handed off to the next track (or is about to) — natural
      // 'ended' firing on the same element around the same moment needs no action here.
      return;
    }
    const next = consumeNextTrack();
    if (next) {
      playTrack(next, playQueue, true);
    } else {
      el('playPauseBtn').textContent = '▶';
    }
  }
  el('audioEl').addEventListener('ended', handleTrackEnded);
  el('audioEl2').addEventListener('ended', handleTrackEnded);

  function handleTimeUpdate(e) {
    if (e.target !== audio) return;
    if (!audio.duration) return;
    el('seekBar').value = (audio.currentTime / audio.duration) * 100;
    el('timeDisplay').textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(audio.duration)}`;
    maybeStartCrossfade();
  }
  el('audioEl').addEventListener('timeupdate', handleTimeUpdate);
  el('audioEl2').addEventListener('timeupdate', handleTimeUpdate);

  el('seekBar').addEventListener('input', () => {
    if (!audio.duration) return;
    cancelCrossfade();
    audio.currentTime = (el('seekBar').value / 100) * audio.duration;
  });

  // ---------- Resume where you left off ----------
  // Saved to localStorage — this is the deployed app running in the user's own browser, so
  // remembering the last-played track and position across visits is safe and expected (same
  // reasoning as the volume preference below). Only the track id + position are stored; the
  // track's own details are re-fetched on load via GET /api/tracks/:id, so a track that's since
  // been removed from the library is handled cleanly (a 404 just clears the saved state).
  function saveResumeState() {
    if (!state.playingTrackId) return;
    try {
      localStorage.setItem('mp3lib_resume', JSON.stringify({ trackId: state.playingTrackId, position: audio.currentTime || 0 }));
    } catch {
      // Storage blocked — resume just won't be available next visit.
    }
  }

  // Snapshots which QUEUE (not just which track) is currently playing, so a reload/re-login can
  // restore the whole thing — not just the one track "resume" covers — into the Now Playing
  // panel. Saved once per fresh queue start (see applyTrackState above), not on every tick, since
  // the queue itself doesn't change as playback advances through it. Only track ids are stored
  // (plus the playlist id, for type 'playlist') rather than full track data, both to keep this
  // small and because a playlist's own contents are re-fetched live on restore anyway — see
  // restoreResumeState below.
  function saveQueueSnapshot() {
    if (!currentQueueMeta || !playQueue.length) return;
    try {
      localStorage.setItem(
        'mp3lib_queue',
        JSON.stringify({
          type: currentQueueMeta.type,
          name: currentQueueMeta.name,
          id: currentQueueMeta.id,
          trackIds: playQueue.map((t) => t.id),
        })
      );
    } catch {
      // Storage blocked — same fallback as resume state below: restoring will just fall back to
      // the single resumed track with no wider queue behind it.
    }
  }

  function clearResumeState() {
    try {
      localStorage.removeItem('mp3lib_resume');
      localStorage.removeItem('mp3lib_queue');
    } catch {}
  }

  // Reconstructs the queue a saved snapshot points to, for restoreResumeState below. A real
  // playlist is re-fetched live (GET /api/playlists/:id) rather than replayed from its saved
  // track ids, so a smart playlist re-evaluates and a regular one picks up any edits made since —
  // same as opening it normally. Everything else (Tracks tab, Shuffle All, Rediscover, Radio,
  // History, a recap group) has no such "current version" to re-fetch, so it's rebuilt from the
  // saved track ids via GET /api/tracks/by-ids, in the original order, silently missing any track
  // deleted since. Returns null if nothing usable could be reconstructed.
  async function restoreQueueSnapshot(resumeTrackId) {
    let snapshot;
    try {
      snapshot = JSON.parse(localStorage.getItem('mp3lib_queue') || 'null');
    } catch {
      snapshot = null;
    }
    if (!snapshot || !snapshot.type) return null;

    if (snapshot.type === 'playlist' && snapshot.id != null) {
      try {
        const res = await fetch(`/api/playlists/${snapshot.id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.tracks && data.tracks.length) {
            return { queueMeta: { type: 'playlist', id: data.id, name: data.name }, tracks: data.tracks };
          }
        }
      } catch {
        // Fall through to the by-ids reconstruction below.
      }
    }

    if (!Array.isArray(snapshot.trackIds) || !snapshot.trackIds.length) return null;
    try {
      const data = await fetch(`/api/tracks/by-ids?ids=${snapshot.trackIds.join(',')}`).then((r) => r.json());
      if (!data.tracks || !data.tracks.length) return null;
      return { queueMeta: { type: snapshot.type, name: snapshot.name }, tracks: data.tracks };
    } catch {
      return null;
    }
  }

  // Restores the player bar (title/cover/position) — and, where possible, the Now Playing
  // panel/queue behind it — to whatever was playing last time, left paused rather than
  // auto-playing: browser autoplay policies are unreliable, and audio suddenly starting on page
  // load would be jarring even where they allow it. Playback only actually starts once the user
  // presses ▶ themselves (see the playPauseBtn handler above), which is also where the queue
  // (once known) actually gets handed to applyTrackState.
  async function restoreResumeState() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem('mp3lib_resume') || 'null');
    } catch {
      saved = null;
    }
    if (!saved || !saved.trackId) return;

    let track;
    try {
      const res = await fetch(`/api/tracks/${saved.trackId}`);
      if (res.status === 404) {
        clearResumeState();
        return;
      }
      if (!res.ok) return;
      track = await res.json();
    } catch {
      return;
    }

    const restoredQueue = await restoreQueueSnapshot(track.id);

    pendingResume = { track, position: saved.position || 0, queueMeta: restoredQueue ? restoredQueue.queueMeta : null };
    state.playingTrackId = track.id;
    playQueue = restoredQueue ? restoredQueue.tracks : [track];

    if (restoredQueue) {
      // The queue is already known, so make the always-visible Now Playing panel reflect it
      // right away — same as if playback had never stopped — even though pressing ▶ is still
      // what actually starts audio. A real playlist auto-maximizes the panel if it was
      // minimized, matching how it behaves everywhere else.
      currentQueueMeta = restoredQueue.queueMeta;
      renderNowPlayingPanel(playQueue);
      if (currentQueueMeta.type === 'playlist') {
        setNowPlayingPanelMinimized(false);
      }
    }

    el('playerTitle').textContent = track.title || track.filename || 'Unknown title';
    el('playerSub').textContent = [track.artist, track.album].filter(Boolean).join(' — ');
    el('playerCover').src = `/api/cover/track/${track.id}`;
    el('playerCover').onerror = () => { el('playerCover').src = placeholderSvg(track.artist || track.title); };
    el('playPauseBtn').textContent = '▶';
    if (track.duration) {
      el('seekBar').value = (pendingResume.position / track.duration) * 100;
      el('timeDisplay').textContent = `${formatDuration(pendingResume.position)} / ${formatDuration(track.duration)}`;
    }
    highlightPlaying();
  }

  // Same dual-binding-with-guard pattern as the 'ended'/'timeupdate' handlers above — events
  // from whichever element crossfading has left inactive at the moment are ignored.
  function handlePauseForResume(e) {
    if (e.target !== audio) return;
    saveResumeState();
  }
  function handleSeekedForResume(e) {
    if (e.target !== audio) return;
    saveResumeState();
  }
  el('audioEl').addEventListener('pause', handlePauseForResume);
  el('audioEl').addEventListener('seeked', handleSeekedForResume);
  el('audioEl2').addEventListener('pause', handlePauseForResume);
  el('audioEl2').addEventListener('seeked', handleSeekedForResume);
  window.addEventListener('beforeunload', saveResumeState);
  // Belt-and-braces for a long play session that ends in a crash/force-quit rather than a clean
  // unload — keeps the saved position from drifting too far behind actual playback.
  setInterval(saveResumeState, 15000);

  // ---------- Volume ----------
  // Saved to localStorage — this is the deployed app running in the user's own browser (not an
  // in-conversation preview), so persisting a small UI preference like volume across visits is
  // safe and expected. Falls back quietly to full volume if storage is blocked/unavailable.
  function updateMuteIcon() {
    const btn = el('muteBtn');
    if (audio.muted || audio.volume === 0) btn.textContent = '🔇';
    else if (audio.volume < 0.5) btn.textContent = '🔉';
    else btn.textContent = '🔊';
  }

  // Shared by the slider's own input handler and the ↑/↓ keyboard shortcuts below, so both
  // paths update audio.volume, the slider position, the mute icon, and the saved preference the
  // same way.
  function setVolume(v) {
    v = Math.min(100, Math.max(0, v));
    audio.volume = v / 100;
    el('volumeSlider').value = v;
    if (v > 0 && audio.muted) audio.muted = false;
    updateMuteIcon();
    try { localStorage.setItem('mp3lib_volume', String(v)); } catch {}
  }

  (function initVolume() {
    let saved = 100;
    try {
      const stored = localStorage.getItem('mp3lib_volume');
      if (stored !== null) saved = Math.min(100, Math.max(0, parseInt(stored, 10) || 0));
    } catch {
      // Storage blocked (private browsing, etc.) — just start at full volume.
    }
    audio.volume = saved / 100;
    el('volumeSlider').value = saved;
    updateMuteIcon();
  })();

  el('volumeSlider').addEventListener('input', () => setVolume(parseInt(el('volumeSlider').value, 10)));

  el('muteBtn').addEventListener('click', () => {
    audio.muted = !audio.muted;
    updateMuteIcon();
  });

  // ---------- Keyboard shortcuts ----------
  // Space = play/pause, ←/→ = seek 5s back/forward, ↑/↓ = volume up/down. Ignored while typing
  // in a text field/dropdown or while the modal (rename/delete/etc.) is open, so this never
  // steals a space or arrow key from something the user is actually typing into.
  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const tag = active ? active.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (active && active.isContentEditable) return;
    if (!el('modalOverlay').hidden) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        if (!audio.src) return;
        e.preventDefault();
        el('playPauseBtn').click();
        break;
      case 'ArrowLeft':
        if (!audio.duration) return;
        e.preventDefault();
        cancelCrossfade();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
        break;
      case 'ArrowRight':
        if (!audio.duration) return;
        e.preventDefault();
        cancelCrossfade();
        audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setVolume(parseInt(el('volumeSlider').value, 10) + 5);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setVolume(parseInt(el('volumeSlider').value, 10) - 5);
        break;
    }
  });

  // ---------- Playlists ----------
  let lastPlaylists = [];

  async function loadPlaylists() {
    const data = await fetch('/api/playlists').then((r) => r.json());
    lastPlaylists = data.playlists;
    const grid = el('playlistGrid');
    if (!data.playlists.length) {
      grid.innerHTML = `<div class="empty-state">No playlists yet — click "New playlist" to make one, or use the + button next to any track.</div>`;
      return;
    }
    grid.innerHTML = data.playlists
      .map(
        (p) => `
      <div class="playlist-card" data-id="${p.id}">
        <div class="name">${escapeHtml(p.name)}${p.is_smart ? ' <span class="smart-badge">Smart</span>' : ''}</div>
        <div class="meta">${p.track_count} track${p.track_count === 1 ? '' : 's'} · ${formatDuration(p.total_duration)}</div>
      </div>`
      )
      .join('');
    grid.querySelectorAll('.playlist-card').forEach((card) => {
      card.addEventListener('click', () => openPlaylistDetail(parseInt(card.dataset.id, 10)));
    });
  }

  el('newPlaylistBtn').addEventListener('click', async () => {
    const name = await showModal({ title: 'New playlist name', withInput: true });
    if (!name) return;
    await fetch('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    loadPlaylists();
  });

  // ---------- Generate a smart playlist (Artist / Genre / Year / Decade) ----------
  // Each button lets you pick one specific artist/genre/year/decade from what's actually in
  // your library, then creates a single auto-updating smart playlist for it — same as "Save as
  // smart playlist" on the Tracks tab, just started from a dropdown instead of the filter bar.
  const GENERATE_DIMENSIONS = {
    artist: { label: 'artist', buttonId: 'genArtistBtn' },
    genre: { label: 'genre', buttonId: 'genGenreBtn' },
    year: { label: 'year', buttonId: 'genYearBtn' },
    decade: { label: 'decade', buttonId: 'genDecadeBtn' },
  };

  async function collectDimensionItems(dimension) {
    if (dimension === 'decade') {
      const stats = await fetch('/api/stats').then((r) => r.json());
      return (stats.by_decade || []).map((d) => ({ name: `${d.decade}s`, filters: { decade: d.decade } }));
    }
    if (dimension === 'year') {
      const data = await fetch('/api/years').then((r) => r.json());
      return (data.years || []).filter((y) => y).map((y) => ({ name: String(y), filters: { year: String(y) } }));
    }
    if (dimension === 'genre') {
      const data = await fetch('/api/genres').then((r) => r.json());
      return (data.genres || []).filter(Boolean).map((g) => ({ name: g, filters: { genre: g } }));
    }
    if (dimension === 'artist') {
      const data = await fetch('/api/artists?photos=0').then((r) => r.json());
      return (data.artists || []).filter((a) => a.artist).map((a) => ({ name: a.artist, filters: { artist: a.artist } }));
    }
    return [];
  }

  async function generatePlaylistsByDimension(dimension) {
    const { label, buttonId } = GENERATE_DIMENSIONS[dimension];
    const btn = el(buttonId);
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Loading…';

    try {
      const items = await collectDimensionItems(dimension);
      if (!items.length) {
        await showModal({ title: `No ${label}s found in your library yet.`, okLabel: 'OK', hideCancel: true });
        return;
      }

      const chosenName = await showModal({
        title: `Create a smart playlist for which ${label}?`,
        withSelect: true,
        selectOptions: items.map((i) => ({ value: i.name, label: i.name })),
        okLabel: 'Next',
      });
      if (!chosenName) return;

      const item = items.find((i) => i.name === chosenName);
      if (!item) return;

      const countChoice = await showModal({
        title: `How many tracks for "${item.name}"?`,
        withSelect: true,
        selectOptions: [
          { value: 'all', label: 'All matching tracks' },
          { value: '10', label: '10 random tracks (re-picked every time you open it)' },
          { value: '20', label: '20 random tracks (re-picked every time you open it)' },
          { value: '50', label: '50 random tracks (re-picked every time you open it)' },
          { value: '100', label: '100 random tracks (re-picked every time you open it)' },
        ],
        okLabel: 'Create',
      });
      if (countChoice === null) return;

      const randomCount = countChoice === 'all' ? null : parseInt(countChoice, 10);
      const playlistName = randomCount ? `${item.name} (${randomCount} random)` : item.name;

      const existing = await fetch('/api/playlists').then((r) => r.json());
      const alreadyExists = existing.playlists.some((p) => p.name === playlistName);
      if (alreadyExists) {
        await showModal({ title: `A playlist named "${playlistName}" already exists.`, okLabel: 'OK', hideCancel: true });
        return;
      }

      btn.textContent = 'Creating…';
      await fetch('/api/playlists/smart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playlistName, filters: { ...item.filters, randomCount } }),
      });

      await loadPlaylists();
      await showModal({ title: `Created smart playlist "${playlistName}".`, okLabel: 'OK', hideCancel: true });
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  Object.keys(GENERATE_DIMENSIONS).forEach((dimension) => {
    el(GENERATE_DIMENSIONS[dimension].buttonId).addEventListener('click', () => generatePlaylistsByDimension(dimension));
  });

  // ---------- Generate ALL playlists at once, as fixed (non-smart) playlists ----------
  // This is the original "one per distinct value" bulk behavior, restored alongside the
  // pick-one flow above — the difference is these are regular playlists: their matching tracks
  // are captured once, right now, into playlist_tracks, so they don't keep changing as the
  // library changes later (unlike the auto-updating smart playlists above). Named with a
  // "(fixed)" suffix so they can't collide with a same-named smart playlist.
  const GENERATE_FIXED_DIMENSIONS = {
    artist: { label: 'artist', buttonId: 'genFixedArtistBtn' },
    genre: { label: 'genre', buttonId: 'genFixedGenreBtn' },
    year: { label: 'year', buttonId: 'genFixedYearBtn' },
    decade: { label: 'decade', buttonId: 'genFixedDecadeBtn' },
  };

  async function generateFixedPlaylistsByDimension(dimension) {
    const { label, buttonId } = GENERATE_FIXED_DIMENSIONS[dimension];
    const btn = el(buttonId);
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';

    try {
      const items = (await collectDimensionItems(dimension)).map((i) => ({ name: `${i.name} (fixed)`, filters: i.filters }));
      if (!items.length) {
        await showModal({ title: `No ${label}s found in your library yet.`, okLabel: 'OK', hideCancel: true });
        return;
      }

      const existing = await fetch('/api/playlists').then((r) => r.json());
      const existingNames = new Set(existing.playlists.map((p) => p.name));
      const toCreate = items.filter((i) => !existingNames.has(i.name));

      if (!toCreate.length) {
        await showModal({ title: `All ${items.length} ${label} playlists already exist — nothing to create.`, okLabel: 'OK', hideCancel: true });
        return;
      }

      const skippedCount = items.length - toCreate.length;
      const confirmed = await showModal({
        title: `Create ${toCreate.length} fixed playlist${toCreate.length === 1 ? '' : 's'}, one per ${label}${
          skippedCount ? ` (${skippedCount} already exist and will be skipped)` : ''
        }? Each one's tracks are captured now and won't change later.`,
        okLabel: 'Create',
      });
      if (!confirmed) return;

      btn.textContent = 'Creating…';
      const result = await fetch('/api/playlists/fixed/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: toCreate }),
      }).then((r) => r.json());

      await loadPlaylists();
      await showModal({
        title: `Created ${result.created} fixed playlist${result.created === 1 ? '' : 's'}${result.skipped ? ` (${result.skipped} skipped)` : ''}.`,
        okLabel: 'OK',
        hideCancel: true,
      });
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  Object.keys(GENERATE_FIXED_DIMENSIONS).forEach((dimension) => {
    el(GENERATE_FIXED_DIMENSIONS[dimension].buttonId).addEventListener('click', () => generateFixedPlaylistsByDimension(dimension));
  });

  // ---------- Import playlist (.m3u/.m3u8) ----------
  el('importPlaylistBtn').addEventListener('click', () => el('importPlaylistInput').click());

  el('importPlaylistInput').addEventListener('change', async () => {
    const input = el('importPlaylistInput');
    const file = input.files[0];
    input.value = ''; // reset so picking the same file again still fires 'change'
    if (!file) return;

    const defaultName = file.name.replace(/\.(m3u8?|txt)$/i, '');
    const name = await showModal({ title: 'Import as playlist name', withInput: true, defaultValue: defaultName, okLabel: 'Import' });
    if (!name) return;

    let result;
    try {
      const content = await file.text();
      result = await fetch('/api/playlists/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      }).then((r) => r.json());
    } catch {
      result = { error: 'Could not read or import that file.' };
    }

    if (result.error) {
      await showModal({ title: result.error, okLabel: 'OK', hideCancel: true });
      return;
    }

    await loadPlaylists();
    const parts = [`Imported ${result.matched} of ${result.total_lines} track${result.total_lines === 1 ? '' : 's'} into "${name}"`];
    if (result.ambiguous) parts.push(`${result.ambiguous} matched by filename only (more than one track shares that name)`);
    if (result.skipped) parts.push(`${result.skipped} not found in your library`);
    await showModal({ title: parts.join(' — '), okLabel: 'OK', hideCancel: true });
    openPlaylistDetail(result.id);
  });

  let currentPlaylistDetail = null;

  async function openPlaylistDetail(id) {
    const data = await fetch(`/api/playlists/${id}`).then((r) => r.json());
    currentPlaylistDetail = data;
    state.currentPlaylistId = id;
    state.view = 'playlistDetail';
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    el('playlistDetailView').classList.add('active');
    el('filtersBar').style.display = 'none';
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));

    renderPlaylistDetail();
  }

  function renderPlaylistDetail() {
    const data = currentPlaylistDetail;
    el('playlistDetailName').innerHTML = escapeHtml(data.name) + (data.is_smart ? ' <span class="smart-badge">Smart</span>' : '');
    const totalDuration = data.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    el('playlistDetailMeta').textContent = `${data.tracks.length} track${data.tracks.length === 1 ? '' : 's'} · ${formatDuration(totalDuration)}`;
    el('exportPlaylistBtn').href = `/api/playlists/${data.id}/export.m3u8`;

    const smartInfo = el('playlistSmartInfo');
    if (data.is_smart) {
      smartInfo.hidden = false;
      smartInfo.innerHTML = `This is a <strong>smart playlist</strong> — it auto-updates from a saved search instead of a fixed track list. Matches: ${escapeHtml(describeSmartFilters(data.filters))}.`;
    } else {
      smartInfo.hidden = true;
    }

    const list = el('playlistTrackList');
    if (!data.tracks.length) {
      list.innerHTML = `<li class="empty-state">${
        data.is_smart
          ? 'No tracks currently match this smart playlist’s filters.'
          : 'This playlist is empty. Add tracks from the Tracks or Artists tab using the + button.'
      }</li>`;
      return;
    }

    list.innerHTML = data.tracks
      .map(
        (t, i) => `
      <li data-id="${t.id}" data-playlist-track-id="${t.playlist_track_id ?? ''}" class="${state.playingTrackId === t.id ? 'playing' : ''}" ${data.is_smart ? '' : 'draggable="true"'}>
        ${data.is_smart ? '' : '<span class="pl-drag-handle" title="Drag to reorder">⠿</span>'}
        <img class="pl-cover" src="/api/cover/track/${t.id}" onerror="this.src='${placeholderSvg(t.artist || t.title)}'">
        <div class="pl-info">
          <div class="pl-title">${escapeHtml(t.title || '—')}</div>
          <div class="pl-sub">${escapeHtml(t.artist || '')}${t.album ? ' — ' + escapeHtml(t.album) : ''}</div>
        </div>
        <span class="pl-dur">${formatDuration(t.duration)}</span>
        <div class="pl-actions">
          <button class="icon-btn play-track-btn" title="Play">▶</button>
          ${
            data.is_smart
              ? ''
              : `<button class="icon-btn move-up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn move-down" title="Move down" ${i === data.tracks.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn remove-track" title="Remove from playlist">✕</button>`
          }
        </div>
      </li>`
      )
      .join('');

    list.querySelectorAll('li[data-id]').forEach((li) => {
      const play = () => {
        const id = parseInt(li.dataset.id, 10);
        const track = data.tracks.find((t) => t.id === id);
        if (track) playTrack(track, data.tracks, false, { type: 'playlist', id: data.id, name: data.name });
      };
      li.querySelector('.play-track-btn').addEventListener('click', play);

      if (!data.is_smart) {
        li.querySelector('.move-up').addEventListener('click', () => movePlaylistTrack(li, -1));
        li.querySelector('.move-down').addEventListener('click', () => movePlaylistTrack(li, 1));
        li.querySelector('.remove-track').addEventListener('click', () => removeFromPlaylist(li.dataset.playlistTrackId));
        wireDragAndDrop(li);
      }
    });
  }

  async function movePlaylistTrack(li, direction) {
    const ids = [...el('playlistTrackList').querySelectorAll('li[data-playlist-track-id]')].map(
      (l) => parseInt(l.dataset.playlistTrackId, 10)
    );
    const id = parseInt(li.dataset.playlistTrackId, 10);
    const idx = ids.indexOf(id);
    const swapWith = idx + direction;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
    await reorderPlaylist(ids);
  }

  async function reorderPlaylist(ids) {
    await fetch(`/api/playlists/${state.currentPlaylistId}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ids }),
    });
    const data = await fetch(`/api/playlists/${state.currentPlaylistId}`).then((r) => r.json());
    currentPlaylistDetail = data;
    renderPlaylistDetail();
  }

  // ---------- Drag-and-drop playlist reordering ----------
  let dragSrcLi = null;

  function wireDragAndDrop(li) {
    li.addEventListener('dragstart', () => {
      dragSrcLi = li;
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragSrcLi = null;
      document.querySelectorAll('#playlistTrackList li').forEach((row) => row.classList.remove('drag-over-top', 'drag-over-bottom'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragSrcLi || dragSrcLi === li) return;
      const rect = li.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      li.classList.toggle('drag-over-top', before);
      li.classList.toggle('drag-over-bottom', !before);
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    li.addEventListener('drop', async (e) => {
      e.preventDefault();
      const before = li.classList.contains('drag-over-top');
      li.classList.remove('drag-over-top', 'drag-over-bottom');
      if (!dragSrcLi || dragSrcLi === li) return;

      const list = el('playlistTrackList');
      if (before) list.insertBefore(dragSrcLi, li);
      else list.insertBefore(dragSrcLi, li.nextSibling);

      const ids = [...list.querySelectorAll('li[data-playlist-track-id]')].map((l) => parseInt(l.dataset.playlistTrackId, 10));
      await reorderPlaylist(ids);
    });
  }

  async function removeFromPlaylist(playlistTrackId) {
    await fetch(`/api/playlists/${state.currentPlaylistId}/tracks/${playlistTrackId}`, { method: 'DELETE' });
    const data = await fetch(`/api/playlists/${state.currentPlaylistId}`).then((r) => r.json());
    currentPlaylistDetail = data;
    renderPlaylistDetail();
  }

  el('backToPlaylists').addEventListener('click', () => switchView('playlists'));

  el('playAllBtn').addEventListener('click', () => {
    const data = currentPlaylistDetail;
    if (data && data.tracks.length) playTrack(data.tracks[0], data.tracks, false, { type: 'playlist', id: data.id, name: data.name });
  });

  el('renamePlaylistBtn').addEventListener('click', async () => {
    const data = currentPlaylistDetail;
    const name = await showModal({ title: 'Rename playlist', withInput: true, defaultValue: data.name });
    if (!name) return;
    await fetch(`/api/playlists/${data.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    data.name = name;
    renderPlaylistDetail();
  });

  el('deletePlaylistBtn').addEventListener('click', async () => {
    const data = currentPlaylistDetail;
    const confirmed = await showModal({
      title: `Delete "${data.name}"? This cannot be undone.`,
      okLabel: 'Delete',
    });
    if (!confirmed) return;
    await fetch(`/api/playlists/${data.id}`, { method: 'DELETE' });
    switchView('playlists');
  });

  // ---------- Add-to-playlist popover (single track, or a multi-select batch) ----------
  let addToPlaylistTrackIds = [];

  async function openAddToPlaylistPopover(trackIdOrIds, anchorEl) {
    addToPlaylistTrackIds = Array.isArray(trackIdOrIds) ? trackIdOrIds : [trackIdOrIds];
    if (!addToPlaylistTrackIds.length) return;

    const popover = el('addToPlaylistPopover');
    const rect = anchorEl.getBoundingClientRect();
    popover.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 260)}px`;
    popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 256))}px`;
    popover.hidden = false;
    el('addToPlaylistNewName').value = '';
    el('addToPlaylistPopoverTitle').textContent = addToPlaylistTrackIds.length > 1
      ? `Add ${addToPlaylistTrackIds.length} tracks to playlist`
      : 'Add to playlist';

    const data = await fetch('/api/playlists').then((r) => r.json());
    const listEl = el('addToPlaylistList');
    // Smart playlists compute their own contents from saved filters — they aren't a valid target.
    const targetable = data.playlists.filter((p) => !p.is_smart);
    if (!targetable.length) {
      listEl.innerHTML = `<div class="muted" style="font-size:0.85rem;">No playlists yet.</div>`;
    } else {
      listEl.innerHTML = targetable
        .map((p) => `<div class="popover-item" data-id="${p.id}"><span>${escapeHtml(p.name)}</span><span class="count">${p.track_count}</span></div>`)
        .join('');
      listEl.querySelectorAll('.popover-item').forEach((item) => {
        item.addEventListener('click', async () => {
          await addTracksToPlaylist(item.dataset.id, addToPlaylistTrackIds);
          closeAddToPlaylistPopover();
        });
      });
    }
  }

  function closeAddToPlaylistPopover() {
    el('addToPlaylistPopover').hidden = true;
    addToPlaylistTrackIds = [];
  }

  document.addEventListener('click', (e) => {
    const popover = el('addToPlaylistPopover');
    if (
      !popover.hidden &&
      !popover.contains(e.target) &&
      !e.target.classList.contains('add-to-playlist-btn') &&
      e.target.id !== 'bulkAddToPlaylistBtn'
    ) {
      closeAddToPlaylistPopover();
    }
  });

  el('addToPlaylistNewForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el('addToPlaylistNewName').value.trim();
    if (!name || !addToPlaylistTrackIds.length) return;
    const created = await fetch('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.json());
    await addTracksToPlaylist(created.id, addToPlaylistTrackIds);
    closeAddToPlaylistPopover();
  });

  async function addTracksToPlaylist(playlistId, trackIds) {
    await fetch(`/api/playlists/${playlistId}/tracks/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_ids: trackIds }),
    });
    if (trackIds.length > 1) {
      state.selectedTrackIds.clear();
      document.querySelectorAll('.track-select-cb').forEach((cb) => { cb.checked = false; });
      updateSelectAllCheckbox();
      updateBulkBar();
    }
  }

  // ---------- Library health ----------
  const HEALTH_TILES = [
    { type: 'missing_title', label: 'Missing title tag' },
    { type: 'missing_artist', label: 'Missing artist' },
    { type: 'missing_album', label: 'Missing album' },
    { type: 'missing_year', label: 'Missing year' },
    { type: 'missing_genre', label: 'Missing genre' },
    { type: 'no_cover', label: 'No cover art' },
    { type: 'scan_error', label: 'Scan errors' },
    { type: 'duplicates', label: 'Possible duplicates' },
  ];

  let currentHealthType = null;

  async function loadHealth() {
    const summary = await fetch('/api/health/summary').then((r) => r.json());
    const tiles = el('healthTiles');
    tiles.innerHTML = `
      <div class="health-tile" data-type="_total">
        <div class="num">${summary.total_tracks}</div>
        <div class="label">Total tracks</div>
      </div>
      <div class="health-tile" data-type="no_artist_photo">
        <div class="num ${summary.artists_without_photo === 0 ? 'ok' : 'warn'}">${summary.artists_without_photo}</div>
        <div class="label">Artists without photo (of ${summary.artists_total})</div>
      </div>
      ${HEALTH_TILES.map((t) => {
        const count = summary.issues[t.type] || 0;
        return `
        <div class="health-tile" data-type="${t.type}">
          <div class="num ${count === 0 ? 'ok' : 'warn'}">${count}</div>
          <div class="label">${t.label}</div>
        </div>`;
      }).join('')}
    `;

    tiles.querySelectorAll('.health-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        const type = tile.dataset.type;
        if (type.startsWith('_')) return;
        tiles.querySelectorAll('.health-tile').forEach((t) => t.classList.remove('active'));
        tile.classList.add('active');
        currentHealthType = type;
        loadHealthIssues(type, 1);
      });
    });

    if (!currentHealthType) {
      el('healthDetail').innerHTML = `<div class="empty-state">Click a tile above to see the affected files.</div>`;
    }

    const lastScan = summary.last_scan;
    let note = document.getElementById('healthLastScanNote');
    if (lastScan && lastScan.finished_at) {
      if (!note) {
        note = document.createElement('p');
        note.id = 'healthLastScanNote';
        note.className = 'muted';
        note.style.marginTop = '4px';
        tiles.after(note);
      }
      const when = new Date(lastScan.finished_at).toLocaleString();
      note.textContent = `Last scan finished ${when} — ${lastScan.files_processed}/${lastScan.files_found} files processed, ${lastScan.errors} error${lastScan.errors === 1 ? '' : 's'}.`;
    } else if (note) {
      note.remove();
    }
  }

  async function loadHealthIssues(type, page) {
    const params = new URLSearchParams({ type, page, pageSize: 100 });
    const data = await fetch(`/api/health/issues?${params.toString()}`).then((r) => r.json());
    const detail = el('healthDetail');

    if (type === 'no_artist_photo') {
      const diag = await fetch('/api/health/artist-photo-diagnostics').then((r) => r.json());
      const hostPathWarning = diag.looksLikeHostPath
        ? `<div class="lastfm-note" style="margin-bottom:10px; border-color: var(--danger);">
             <strong>This looks like a Windows/host path, not a path inside the app's container</strong> — the app has no
             <code>D:</code> drive, so this can never work no matter how the folder is mounted.
             In your <code>.env</code>, <code>ARTIST_PICTURES_DIR</code> should be left as <code>/artist-pictures</code>
             (the default) — your real folder path belongs only in <code>ARTIST_PICTURES_HOST_DIR</code>. If both ended up
             set to the same real path, that's the fix. Rebuild after changing it:
             <code>docker compose up -d --build</code>.
           </div>`
        : '';
      const diagHtml = `
        ${hostPathWarning}
        <div class="lastfm-note" style="margin-bottom:16px;">
          Looking for artist photos in <code>${escapeHtml(diag.dir)}</code> —
          ${diag.dirReadable
            ? `found <strong>${diag.folderCount}</strong> folder${diag.folderCount === 1 ? '' : 's'} there.`
            : `<strong>can't read this folder</strong> (${escapeHtml(diag.error || 'unknown error')})${diag.looksLikeHostPath ? '' : " — check ARTIST_PICTURES_HOST_DIR in your .env and that you've rebuilt/restarted since changing it."}`}
          ${diag.dirReadable && diag.folderCount === 0
            ? ' That means the mount is empty or pointing at the wrong place — double check ARTIST_PICTURES_HOST_DIR in your .env.'
            : ''}
          ${diag.dirReadable && diag.folderCount > 0
            ? `<details style="margin-top:8px;"><summary style="cursor:pointer;">Show folder names found on disk</summary>
                 <div class="muted" style="margin-top:6px; word-break:break-word;">${diag.folders.map(escapeHtml).join(', ')}</div>
               </details>`
            : ''}
        </div>`;

      if (!data.items.length) {
        detail.innerHTML = diagHtml + `<div class="empty-state">Every artist has a matched photo — nice and tidy.</div>`;
        return;
      }

      detail.innerHTML = diagHtml + `
        <p class="muted" style="font-size:0.82rem; margin-bottom:8px;">
          A folder matches when its name simplifies to the same value shown here (lowercase, no accents/punctuation, leading "The" dropped) — compare it against the folder names above.
        </p>
        <table class="health-issue-table">
          <thead><tr><th>Artist</th><th>Simplifies to</th></tr></thead>
          <tbody>
            ${data.items
              .map(
                (i) => `<tr>
                  <td><span class="cell-link" data-role="artist-link" data-artist="${escapeAttr(i.artist)}">${escapeHtml(i.artist)}</span></td>
                  <td class="path">${escapeHtml(i.normalized)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        ${data.total > data.items.length ? `<p class="muted">Showing ${data.items.length} of ${data.total}.</p>` : ''}
      `;

      detail.querySelectorAll('[data-role="artist-link"]').forEach((link) => {
        link.addEventListener('click', () => openArtistDetail(link.dataset.artist));
      });
      return;
    }

    if (!data.items.length) {
      detail.innerHTML = `<div class="empty-state">No issues of this type — nice and tidy.</div>`;
      return;
    }

    if (type === 'duplicates') {
      detail.innerHTML = `
        <p class="muted" style="font-size:0.82rem; margin-bottom:12px;">
          Grouped by matching artist + title (case-insensitive) — worth a look before deleting anything, since a live version, a remaster, or a different mix can share both.
        </p>
        ${data.items
          .map(
            (g) => `
          <div class="dup-group">
            <h4>${escapeHtml(g.artist)} — ${escapeHtml(g.title)} <span class="muted">(${g.tracks.length} copies)</span></h4>
            <table class="health-issue-table">
              <thead><tr><th>Album</th><th>Year</th><th>Genre</th><th>Length</th><th>Size</th><th>File</th></tr></thead>
              <tbody>
                ${g.tracks
                  .map(
                    (t) => `<tr>
                      <td>${escapeHtml(t.album || '—')}</td>
                      <td>${t.year || ''}</td>
                      <td>${escapeHtml(t.genre || '')}</td>
                      <td>${formatDuration(t.duration)}</td>
                      <td>${formatBytes(t.filesize)}</td>
                      <td class="path">${escapeHtml(t.filepath)}</td>
                    </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>`
          )
          .join('')}
        ${data.total > data.items.length ? `<p class="muted">Showing ${data.items.length} of ${data.total} groups.</p>` : ''}
      `;
      return;
    }

    if (type === 'scan_error') {
      detail.innerHTML = `
        <table class="health-issue-table">
          <thead><tr><th>File</th><th>Error</th><th>When</th></tr></thead>
          <tbody>
            ${data.items
              .map(
                (i) => `<tr>
                  <td class="path">${escapeHtml(i.filepath)}</td>
                  <td>${escapeHtml(i.message)}</td>
                  <td>${new Date(i.occurred_at).toLocaleString()}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        ${data.total > data.items.length ? `<p class="muted">Showing ${data.items.length} of ${data.total}.</p>` : ''}
      `;
      return;
    }

    detail.innerHTML = `
      <table class="health-issue-table">
        <thead><tr><th>Title</th><th>Artist</th><th>Album</th><th>Year</th><th>File</th></tr></thead>
        <tbody>
          ${data.items
            .map(
              (t) => `<tr>
                <td>${escapeHtml(t.title || '—')}</td>
                <td>${escapeHtml(t.artist || '—')}</td>
                <td>${escapeHtml(t.album || '—')}</td>
                <td>${t.year || ''}</td>
                <td class="path">${escapeHtml(t.filepath)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
      ${data.total > data.items.length ? `<p class="muted">Showing ${data.items.length} of ${data.total}.</p>` : ''}
    `;
  }

  // ---------- Play history ----------
  // A real, chronological log of individual plays (GET /api/history — separate from the Tracks
  // tab's "Last played" column, which only ever shows the most recent play per track). Reuses
  // the .pl-* row styling from the playlist track list. Per the app's standing "never auto-play
  // on click" rule, each row's ▶ button is the only way to start playback from here.
  async function loadHistory(page) {
    const data = await fetch(`/api/history?page=${page}&pageSize=50`).then((r) => r.json());
    const list = el('historyList');
    const pagination = el('historyPagination');

    if (!data.items.length) {
      list.innerHTML = '';
      pagination.innerHTML = '';
      list.insertAdjacentHTML(
        'afterend',
        `<div class="empty-state history-empty">No plays recorded yet — history starts logging the next time you play something.</div>`
      );
      return;
    }
    const oldEmpty = el('historyView').querySelector('.history-empty');
    if (oldEmpty) oldEmpty.remove();

    list.innerHTML = data.items
      .map(
        (t) => `
      <li data-id="${t.id}">
        <img class="pl-cover" loading="lazy" src="/api/cover/track/${t.id}" onerror="this.src='${placeholderSvg(t.artist || t.title)}'">
        <div class="pl-info">
          <div class="pl-title">${escapeHtml(t.title || '—')}</div>
          <div class="pl-sub">${escapeHtml(t.artist || '')}${t.album ? ' — ' + escapeHtml(t.album) : ''}</div>
        </div>
        <span class="pl-dur">${formatRelativeTime(t.played_at)}</span>
        <div class="pl-actions">
          <button class="icon-btn history-play-btn" data-id="${t.id}" title="Play">▶</button>
        </div>
      </li>`
      )
      .join('');

    list.querySelectorAll('.history-play-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const item = data.items.find((t) => t.id === id);
        if (item) playTrack(item, data.items, false, { type: 'history', name: 'Play History' });
      });
    });

    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    pagination.innerHTML = `
      <button class="btn-ghost" id="historyPrevBtn" ${page <= 1 ? 'disabled' : ''}>← Newer</button>
      <span class="muted">Page ${page} of ${totalPages}</span>
      <button class="btn-ghost" id="historyNextBtn" ${page >= totalPages ? 'disabled' : ''}>Older →</button>
    `;
    if (page > 1) el('historyPrevBtn').addEventListener('click', () => loadHistory(page - 1));
    if (page < totalPages) el('historyNextBtn').addEventListener('click', () => loadHistory(page + 1));
  }

  // ---------- Listening recap ----------
  // A small summary panel above the full play log (GET /api/history/recap — computed entirely
  // from play_history, so it's only as far back as that table goes): how much got played in the
  // last 7 days plus the top tracks/artists in that window, and anything played on this same
  // calendar day in a previous year. Reuses renderBarList (below, shared with the Stats tab) for
  // the two "top" rankings, and the same .pl-* row styling as the full play log for "On this
  // day" — each with its own ▶ button, per the app's standing never-auto-play-on-click rule.
  async function loadRecap() {
    const panel = el('recapPanel');
    let data;
    try {
      data = await fetch('/api/history/recap').then((r) => r.json());
    } catch {
      panel.innerHTML = '';
      return;
    }

    const week = data.week || { plays: 0, unique_tracks: 0, top_tracks: [], top_artists: [] };
    const onThisDay = data.on_this_day || [];

    if (!week.plays && !onThisDay.length) {
      panel.innerHTML = `<div class="empty-state">No listening recap yet — come back after you've played a few tracks.</div>`;
      return;
    }

    const weekSection = week.plays
      ? `
      <div class="recap-section">
        <h3 class="artist-info-heading">Last 7 days</h3>
        <p class="recap-summary">${week.plays.toLocaleString()} play${week.plays === 1 ? '' : 's'} across ${week.unique_tracks.toLocaleString()} track${week.unique_tracks === 1 ? '' : 's'}.</p>
        <div class="recap-cols">
          <div>
            <h4 class="recap-subheading">Top tracks</h4>
            <div class="bar-list" id="recapTopTracks"></div>
          </div>
          <div>
            <h4 class="recap-subheading">Top artists</h4>
            <div class="bar-list" id="recapTopArtists"></div>
          </div>
        </div>
      </div>`
      : `
      <div class="recap-section">
        <h3 class="artist-info-heading">Last 7 days</h3>
        <p class="recap-summary muted">Nothing played in the last 7 days.</p>
      </div>`;

    const onThisDaySection = onThisDay.length
      ? `
      <div class="recap-section">
        <h3 class="artist-info-heading">On this day</h3>
        ${onThisDay
          .map(
            (yearGroup) => `
          <div class="recap-year-group">
            <div class="recap-year-label">${yearGroup.year}</div>
            <ol class="history-list recap-otd-list" data-year="${yearGroup.year}">
              ${yearGroup.tracks
                .map(
                  (t) => `
                <li data-id="${t.id}">
                  <img class="pl-cover" loading="lazy" src="/api/cover/track/${t.id}" onerror="this.src='${placeholderSvg(t.artist || t.title)}'">
                  <div class="pl-info">
                    <div class="pl-title">${escapeHtml(t.title || '—')}</div>
                    <div class="pl-sub">${escapeHtml(t.artist || '')}${t.album ? ' — ' + escapeHtml(t.album) : ''}</div>
                  </div>
                  <div class="pl-actions">
                    <button class="icon-btn recap-otd-play-btn" data-id="${t.id}" title="Play">▶</button>
                  </div>
                </li>`
                )
                .join('')}
            </ol>
          </div>`
          )
          .join('')}
      </div>`
      : '';

    panel.innerHTML = weekSection + onThisDaySection;

    if (week.plays) {
      renderBarList(
        el('recapTopTracks'),
        week.top_tracks.map((t) => ({ key: String(t.id), label: [t.title || 'Untitled', t.artist].filter(Boolean).join(' — '), value: t.play_count }))
      );
      renderBarList(
        el('recapTopArtists'),
        week.top_artists.map((a) => ({ key: a.artist, label: a.artist, value: a.play_count })),
        { clickable: true, onClick: (artist) => openArtistDetail(artist) }
      );
    }

    panel.querySelectorAll('.recap-otd-play-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const list = btn.closest('.recap-otd-list');
        const yearGroup = onThisDay.find((g) => String(g.year) === list.dataset.year);
        const track = yearGroup && yearGroup.tracks.find((t) => t.id === id);
        if (track) playTrack(track, yearGroup.tracks, false, { type: 'queue', name: `On this day · ${yearGroup.year}` });
      });
    });
  }

  // ---------- Stats ----------
  function goToTracksFilteredBy({ genre, year, favorite } = {}) {
    if (genre !== undefined) {
      state.filters.genre = genre;
      if (el('filterGenre')) el('filterGenre').value = genre;
    }
    if (year !== undefined) {
      state.filters.year = year;
      if (el('filterYear')) el('filterYear').value = year;
    }
    if (favorite) {
      state.filters.favorite = true;
      el('filterFavoriteBtn').classList.add('active');
      el('filterFavoriteBtn').textContent = '♥ Favorites';
    }
    state.page = 1;
    switchView('tracks');
  }

  async function loadStats() {
    const stats = await fetch('/api/stats').then((r) => r.json());
    const pct = (n) => (stats.tracks ? Math.round(((n || 0) / stats.tracks) * 100) : 0);
    const trackLabel = (t) => (t ? [t.title || 'Untitled', t.artist].filter(Boolean).join(' — ') : '—');

    el('statTiles').innerHTML = `
      <div class="stat-tile"><div class="num">${(stats.tracks ?? 0).toLocaleString()}</div><div class="label">Tracks</div></div>
      <div class="stat-tile"><div class="num">${(stats.artists ?? 0).toLocaleString()}</div><div class="label">Artists</div></div>
      <div class="stat-tile"><div class="num">${(stats.albums ?? 0).toLocaleString()}</div><div class="label">Albums</div></div>
      <div class="stat-tile"><div class="num">${formatDurationLong(stats.total_duration)}</div><div class="label">Total playtime</div></div>
      <div class="stat-tile"><div class="num">${formatBytes(stats.total_size)}</div><div class="label">Library size</div></div>
      <div class="stat-tile"><div class="num">${stats.avg_bitrate ? stats.avg_bitrate + ' kbps' : '—'}</div><div class="label">Avg. bitrate</div></div>
      <div class="stat-tile"><div class="num">${formatDurationLong(stats.total_listened)}</div><div class="label">Total listened</div><div class="sub">from play counts</div></div>
      <div class="stat-tile"><div class="num">${(stats.favorites_count ?? 0).toLocaleString()}</div><div class="label">Favorites</div><div class="sub">${pct(stats.favorites_count)}% of library</div></div>
      <div class="stat-tile"><div class="num">${(stats.unplayed_count ?? 0).toLocaleString()}</div><div class="label">Never played</div><div class="sub">${pct(stats.unplayed_count)}% of library</div></div>
      <div class="stat-tile"><div class="num">${stats.avg_duration ? formatDuration(stats.avg_duration) : '—'}</div><div class="label">Avg. track length</div></div>
      <div class="stat-tile"><div class="num">${(stats.avg_tracks_per_album ?? 0).toFixed(1)}</div><div class="label">Avg. tracks/album</div></div>
      <div class="stat-tile"><div class="num">${stats.largest_track ? formatBytes(stats.largest_track.filesize) : '—'}</div><div class="label">Largest track</div><div class="sub" title="${escapeAttr(trackLabel(stats.largest_track))}">${escapeHtml(trackLabel(stats.largest_track))}</div></div>
      <div class="stat-tile"><div class="num">${stats.smallest_track ? formatBytes(stats.smallest_track.filesize) : '—'}</div><div class="label">Smallest track</div><div class="sub" title="${escapeAttr(trackLabel(stats.smallest_track))}">${escapeHtml(trackLabel(stats.smallest_track))}</div></div>
    `;

    renderBarList(
      el('statsByDecade'),
      (stats.by_decade || [])
        .slice()
        .sort((a, b) => b.decade - a.decade) // latest decade first, regardless of the order the API returns
        .map((d) => ({ key: String(d.decade), label: `${d.decade}s`, value: d.count }))
    );

    renderBarList(
      el('statsByYear'),
      (stats.by_year || [])
        .slice()
        .sort((a, b) => b.year - a.year) // latest year first, matching the decade list above
        .map((y) => ({ key: String(y.year), label: String(y.year), value: y.count })),
      { clickable: true, onClick: (year) => goToTracksFilteredBy({ year }) }
    );

    renderBarList(
      el('statsTopGenres'),
      (stats.top_genres || []).map((g) => ({ key: g.genre, label: g.genre, value: g.count })),
      { clickable: true, onClick: (genre) => goToTracksFilteredBy({ genre }) }
    );

    renderBarList(
      el('statsTopGenresBySize'),
      (stats.top_genres_by_size || []).map((g) => ({ key: g.genre, label: g.genre, value: g.size })),
      { clickable: true, onClick: (genre) => goToTracksFilteredBy({ genre }), formatValue: formatBytes }
    );

    renderBarList(
      el('statsTopArtists'),
      (stats.top_artists || []).map((a) => ({ key: a.artist, label: a.artist, value: a.count })),
      { clickable: true, onClick: (artist) => openArtistDetail(artist) }
    );

    renderBarList(
      el('statsTopArtistsByAlbums'),
      (stats.top_artists_by_albums || []).map((a) => ({ key: a.artist, label: a.artist, value: a.count })),
      { clickable: true, onClick: (artist) => openArtistDetail(artist) }
    );

    renderBarList(
      el('statsTopArtistsBySize'),
      (stats.top_artists_by_size || []).map((a) => ({ key: a.artist, label: a.artist, value: a.size })),
      { clickable: true, onClick: (artist) => openArtistDetail(artist), formatValue: formatBytes }
    );

    renderBarList(
      el('statsTopAlbums'),
      (stats.top_albums || []).map((a) => ({ key: a.album_key, label: `${a.album} — ${a.artist}`, value: a.count })),
      { clickable: true, onClick: (albumKey) => openAlbumDetail(albumKey) }
    );

    // Not clickable-to-play, on purpose — clicking things in this app never starts playback
    // (see the dedicated ▶ buttons everywhere else); this list is just a ranking to look at.
    renderBarList(
      el('statsMostPlayed'),
      (stats.most_played || []).map((t) => ({ key: String(t.id), label: [t.title || 'Untitled', t.artist].filter(Boolean).join(' — '), value: t.play_count }))
    );

    renderBarList(
      el('statsFavoritesByGenre'),
      (stats.favorites_by_genre || []).map((g) => ({ key: g.genre, label: g.genre, value: g.count })),
      { clickable: true, onClick: (genre) => goToTracksFilteredBy({ genre, favorite: true }) }
    );
  }

  // Renders a simple magnitude bar list: rows = [{ key, label, value }]. Bars are all one hue
  // (var(--accent)) sized relative to the row's own list, so no categorical palette is involved.
  // opts.formatValue lets a list display something other than a plain count (e.g. formatBytes
  // for a "by disk space" ranking) while still sizing bars off the raw numeric value.
  function renderBarList(containerEl, rows, opts = {}) {
    if (!rows.length) {
      containerEl.innerHTML = `<div class="bar-list-empty">Not enough tagged data yet.</div>`;
      return;
    }
    const formatValue = opts.formatValue || ((v) => v.toLocaleString());
    const max = Math.max(...rows.map((r) => r.value), 1);
    containerEl.innerHTML = rows
      .map(
        (r) => `
      <div class="bar-row${opts.clickable ? ' clickable' : ''}"${opts.clickable ? ` data-key="${escapeAttr(r.key)}"` : ''}>
        <div class="bar-label" title="${escapeAttr(r.label)}">${escapeHtml(r.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max((r.value / max) * 100, 3)}%"></div></div>
        <div class="bar-value">${formatValue(r.value)}</div>
      </div>`
      )
      .join('');

    if (opts.clickable && opts.onClick) {
      containerEl.querySelectorAll('.bar-row').forEach((row) => {
        row.addEventListener('click', () => opts.onClick(row.dataset.key));
      });
    }
  }

  // ---------- Scan ----------
  // A rescan used to give almost no visible feedback — the status text was small/muted, and for
  // a big library the server-side walk used to block the whole app until it finished, so even
  // that text wouldn't update for a while. scanner.js's walk is now async (non-blocking) and
  // reports progress as it goes; this side adds a real progress bar, a disabled/relabeled
  // button, and a failure message, so a rescan is unmistakably "doing something" the moment you
  // click it, all the way through to a clear finished (or failed) state.
  let scanPollTimer = null;
  // Only pop up a "here's what happened" summary for a scan the user actually just triggered
  // and watched run — not for the status poll on page load, and not again on every idle poll
  // afterwards. Set true right when the user clicks Rescan, consumed (and cleared) the first
  // time pollScanStatus sees that scan finish.
  let watchingScan = false;

  el('scanBtn').addEventListener('click', async () => {
    watchingScan = true;
    setScanUiRunning();
    await fetch('/api/scan', { method: 'POST' });
    pollScanStatus();
  });

  // ---------- Backup ----------
  // Downloads a snapshot of the library database (GET /api/backup). Fetched as a blob and
  // "clicked" via a throwaway <a download> rather than a plain navigation, so a failure shows a
  // friendly message in place instead of navigating the whole app away to a raw error page.
  el('backupBtn').addEventListener('click', async () => {
    const btn = el('backupBtn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Backing up…';
    try {
      const res = await fetch('/api/backup');
      if (!res.ok) throw new Error('Backup request failed');
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = /filename="?([^"]+)"?/.exec(disposition);
      const filename = match ? match[1] : `mp3-library-backup-${Date.now()}.db`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Backup failed:', err);
      await showModal({ title: 'Backup failed', message: 'Could not download a database backup. Check the server logs and try again.', hideCancel: true });
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  function setScanUiRunning() {
    el('scanBtn').disabled = true;
    el('scanBtn').textContent = 'Scanning…';
    el('scanStatus').classList.add('active');
    el('scanStatus').textContent = 'Starting scan…';
    el('scanProgressBar').hidden = false;
    el('scanProgressFill').classList.add('indeterminate');
  }

  async function pollScanStatus() {
    clearTimeout(scanPollTimer);
    const status = await fetch('/api/scan/status').then((r) => r.json());

    if (status.status === 'running') {
      el('scanBtn').disabled = true;
      el('scanBtn').textContent = 'Scanning…';
      el('scanStatus').classList.add('active');
      el('scanProgressBar').hidden = false;

      if (status.files_found > 0) {
        const pct = Math.min(100, Math.round((status.files_processed / status.files_found) * 100));
        el('scanStatus').textContent = `Scanning… ${status.files_processed}/${status.files_found} (${pct}%)`;
        el('scanProgressFill').classList.remove('indeterminate');
        el('scanProgressFill').style.width = `${pct}%`;
      } else {
        el('scanStatus').textContent = 'Scanning… finding files…';
        el('scanProgressFill').classList.add('indeterminate');
      }
      scanPollTimer = setTimeout(pollScanStatus, 700);
      return;
    }

    el('scanBtn').disabled = false;
    el('scanBtn').textContent = 'Rescan';
    el('scanStatus').classList.remove('active');
    el('scanProgressBar').hidden = true;
    el('scanProgressFill').classList.remove('indeterminate');
    el('scanProgressFill').style.width = '0%';

    if (status.status === 'error') {
      el('scanStatus').textContent = `Scan failed: ${status.last_error || 'unknown error'}`;
    } else {
      el('scanStatus').textContent = status.finished_at
        ? `Last scan: +${status.files_added} added, ${status.files_updated} updated, ${status.files_removed} removed${status.errors ? ` (${status.errors} error${status.errors === 1 ? '' : 's'})` : ''}`
        : '';
    }

    // Pop up a summary only for a scan this session actually watched run (see watchingScan above).
    if (watchingScan) {
      watchingScan = false;
      if (status.status === 'error') {
        showModal({
          title: 'Scan failed',
          message: status.last_error || 'Unknown error — check the server log for details.',
          okLabel: 'OK',
          hideCancel: true,
        });
      } else {
        showModal({
          title: 'Scan complete',
          message: describeScanResult(status),
          okLabel: 'OK',
          hideCancel: true,
        });
      }
    }

    loadFilterOptions();
    if (state.view === 'tracks') loadTracks();
    if (state.view === 'artists') loadArtists();
    if (state.view === 'health') loadHealth();
  }

  // Builds the multi-line "what just happened" summary shown in the scan-complete popup.
  function describeScanResult(status) {
    if (!status.files_added && !status.files_updated && !status.files_removed && !status.errors) {
      return 'No changes — your library is already up to date.';
    }
    const lines = [
      `Added: ${status.files_added || 0}`,
      `Updated: ${status.files_updated || 0}`,
      `Removed: ${status.files_removed || 0}`,
    ];
    if (status.errors) {
      lines.push(`Errors: ${status.errors} file${status.errors === 1 ? '' : 's'} could not be read`);
    }
    return lines.join('\n');
  }

  // ---------- Helpers ----------
  function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '';
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  // mm:ss is unreadable for a whole-library total, so the Stats tab uses this instead —
  // "3d 4h 12m" style, dropping leading zero units.
  function formatDurationLong(seconds) {
    if (!seconds && seconds !== 0) return '—';
    let s = Math.round(seconds);
    if (s < 60) return '<1m';
    const days = Math.floor(s / 86400); s -= days * 86400;
    const hours = Math.floor(s / 3600); s -= hours * 3600;
    const minutes = Math.floor(s / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (days || hours) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
  }

  // Renders a last_played_at timestamp (ms since epoch, or falsy if never played) as a short
  // relative label — "just now", "3h ago", "5d ago" — falling back to a plain date once it's
  // further back than a couple of months, so the column stays useful for very recent plays
  // (where the exact time doesn't matter) without turning into "412 days ago" for old ones.
  function formatRelativeTime(ms) {
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const minute = 60 * 1000, hour = 60 * minute, day = 24 * hour;
    if (diff < minute) return 'just now';
    if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 60 * day) return `${Math.floor(diff / day)}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  function placeholderSvg(label) {
    const initial = (label || '?').trim().charAt(0).toUpperCase() || '?';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <rect width="100%" height="100%" fill="#2b2c35"/>
      <text x="50%" y="50%" font-size="80" fill="#9a9ba6" text-anchor="middle" dy=".35em" font-family="sans-serif">${initial}</text>
    </svg>`;
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  }

  // ---------- Init ----------
  (async function init() {
    await checkAuth();
    await loadFilterOptions();
    pollScanStatus();
    switchView('tracks');
    restoreResumeState();
  })();
})();
