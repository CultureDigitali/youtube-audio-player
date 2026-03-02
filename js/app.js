/**
 * App principale per YouTube Audio Player v2.0
 * Gestisce l'interfaccia utente e gli eventi
 */

(function () {
    'use strict';

    // Elementi DOM
    let urlInput, clearBtn, playBtn, addQueueBtn;
    let videoInfoSection, playerSection;
    let likeBtn, pipBtn, copyBtn;
    let tabBtns, playlistContainer;

    // Player
    let player;
    let currentVideoData = null;
    let currentTab = 'queue';

    // === INIT ===
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onDOMReady);
        } else {
            onDOMReady();
        }
    }

    function onDOMReady() {
        urlInput = document.getElementById('url-input');
        clearBtn = document.getElementById('clear-btn');
        playBtn = document.getElementById('play-btn');
        addQueueBtn = document.getElementById('add-queue-btn');
        videoInfoSection = document.getElementById('video-info');
        playerSection = document.getElementById('player-section');
        likeBtn = document.getElementById('like-btn');
        pipBtn = document.getElementById('pip-btn');
        copyBtn = document.getElementById('copy-btn');
        tabBtns = document.querySelectorAll('.tab-btn');
        playlistContainer = document.getElementById('playlist-container');

        player = new AudioPlayer();

        // Player callbacks
        player.onTrackChange = (video) => {
            currentVideoData = video;
            showVideoInfo(video);
            playerSection?.classList.remove('hidden');
            updateLikeButton();
        };

        player.onQueueChange = () => {
            if (currentTab === 'queue') renderTabContent('queue');
        };

        setupEventListeners();
        loadInitialUI();
        urlInput?.focus();
        console.log('YouTube Audio Player v2.0 inizializzato');
    }

    // === EVENT LISTENERS ===
    function setupEventListeners() {
        urlInput?.addEventListener('input', handleUrlInput);
        urlInput?.addEventListener('paste', () => setTimeout(handleUrlInput, 0));
        urlInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    handleAddToQueue(); // Shift+Enter = aggiungi alla coda
                } else {
                    handlePlay();
                }
            }
        });

        clearBtn?.addEventListener('click', () => {
            urlInput.value = '';
            handleUrlInput();
            hideVideoInfo();
            urlInput.focus();
        });

        playBtn?.addEventListener('click', handlePlay);
        addQueueBtn?.addEventListener('click', handleAddToQueue);

        // Action buttons
        likeBtn?.addEventListener('click', handleLike);
        pipBtn?.addEventListener('click', handlePiP);
        copyBtn?.addEventListener('click', handleCopy);

        // Tabs
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => handleTabClick(btn));
        });

        // Menu button
        document.getElementById('menu-btn')?.addEventListener('click', () => {
            document.getElementById('menu-modal').classList.remove('hidden');
        });

        // Settings button
        document.getElementById('settings-btn')?.addEventListener('click', () => {
            document.getElementById('settings-modal').classList.remove('hidden');
        });

        // Close modals
        document.querySelectorAll('.close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.target.closest('.modal').classList.add('hidden');
            });
        });

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.classList.add('hidden');
            });
        });

        // Settings Actions
        document.getElementById('clear-queue-btn')?.addEventListener('click', () => {
            if (confirm('Sei sicuro di voler svuotare la coda?')) {
                player?.clearQueue();
                renderTabContent(currentTab);
                document.getElementById('settings-modal').classList.add('hidden');
                showToast('Coda svuotata');
            }
        });

        document.getElementById('clear-history-btn')?.addEventListener('click', () => {
            if (confirm('Sei sicuro di voler eliminare la cronologia?')) {
                Storage.clearHistory();
                renderTabContent(currentTab);
                document.getElementById('settings-modal').classList.add('hidden');
                showToast('Cronologia eliminata');
            }
        });

        document.getElementById('clear-favorites-btn')?.addEventListener('click', () => {
            if (confirm('Sei sicuro di voler eliminare tutti i preferiti?')) {
                Storage.clearFavorites();
                renderTabContent(currentTab);
                updateLikeButton();
                document.getElementById('settings-modal').classList.add('hidden');
                showToast('Preferiti eliminati');
            }
        });

        // Save playlist modal
        document.getElementById('save-playlist-confirm-btn')?.addEventListener('click', handleSavePlaylist);
        document.getElementById('playlist-name-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleSavePlaylist();
        });

        // Online/offline
        window.addEventListener('online', () => showToast('Connessione ripristinata'));
        window.addEventListener('offline', () => showToast('⚠️ Connessione internet assente'));
    }

    // === INPUT & BUTTONS ===
    function handleUrlInput() {
        const url = urlInput?.value?.trim() || '';
        const isValid = API.isValidYouTubeUrl(url);

        playBtn.disabled = !isValid;
        addQueueBtn.disabled = !isValid;
        clearBtn.style.display = url.length > 0 ? 'block' : 'none';
    }

    // === PLAY: carica e riproduce subito ===
    async function handlePlay() {
        const url = urlInput?.value?.trim();
        if (!url || !API.isValidYouTubeUrl(url)) {
            showToast('⚠️ Inserisci un URL YouTube valido');
            return;
        }

        const videoId = API.extractVideoId(url);
        showLoading(true);

        try {
            const result = await API.fetchVideoData(videoId);
            if (!result.success) throw new Error(result.error);

            const audioUrl = API.getBestAudioUrl(result.data);
            if (!audioUrl) throw new Error('Audio non disponibile per questo video');

            player.addAndPlay(result.data);
            playerSection.classList.remove('hidden');

            // Pulisci input dopo play
            urlInput.value = '';
            handleUrlInput();

            showToast(`▶ ${result.data.title}`);

        } catch (error) {
            console.error(error);
            showToast('❌ ' + (error.message || 'Errore nel caricamento'));
        } finally {
            showLoading(false);
        }
    }

    // === ADD TO QUEUE: aggiunge senza riprodurre ===
    async function handleAddToQueue() {
        const url = urlInput?.value?.trim();
        if (!url || !API.isValidYouTubeUrl(url)) {
            showToast('⚠️ Inserisci un URL YouTube valido');
            return;
        }

        const videoId = API.extractVideoId(url);
        showLoading(true);

        try {
            const result = await API.fetchVideoData(videoId);
            if (!result.success) throw new Error(result.error);

            const added = player.addToQueue(result.data);
            if (added) {
                showToast(`➕ Aggiunto alla coda: ${result.data.title}`);
            } else {
                showToast('⚠️ Questo video è già in coda');
            }

            // Pulisci input
            urlInput.value = '';
            handleUrlInput();

            // Mostra tab coda
            switchToTab('queue');

        } catch (error) {
            console.error(error);
            showToast('❌ ' + (error.message || 'Errore nel caricamento'));
        } finally {
            showLoading(false);
        }
    }

    // === VIDEO INFO ===
    function showVideoInfo(video) {
        document.getElementById('video-title').textContent = video.title;
        document.getElementById('video-channel').textContent = video.author;
        document.getElementById('video-stats').textContent = API.formatViewCount(video.viewCount);
        document.getElementById('video-thumb').src = video.thumbnailUrl;
        videoInfoSection?.classList.remove('hidden');
    }

    function hideVideoInfo() {
        videoInfoSection?.classList.add('hidden');
        playerSection?.classList.add('hidden');
        currentVideoData = null;
    }

    // === LIKE / PiP / Copy ===
    function handleLike() {
        if (!currentVideoData) return;
        const isFav = Storage.toggleFavorite(currentVideoData);
        likeBtn.textContent = isFav ? '❤️' : '🤍';
        likeBtn.classList.toggle('liked', isFav);
        showToast(isFav ? '❤️ Aggiunto ai preferiti' : '💔 Rimosso dai preferiti');
        if (currentTab === 'favorites') renderTabContent('favorites');
    }

    function updateLikeButton() {
        if (!currentVideoData) return;
        const isFav = Storage.isFavorite(currentVideoData.videoId);
        likeBtn.textContent = isFav ? '❤️' : '🤍';
        likeBtn.classList.toggle('liked', isFav);
    }

    async function handlePiP() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else {
                showToast('ℹ️ Per PiP, esci dalla tab/app. Il sistema mostrerà i controlli.');
            }
        } catch (err) {
            console.error('PiP error:', err);
        }
    }

    function handleCopy() {
        if (!currentVideoData) return;
        const url = `https://youtube.com/watch?v=${currentVideoData.videoId}`;
        navigator.clipboard.writeText(url).then(() => {
            copyBtn.textContent = '✓';
            showToast('📋 URL copiato!');
            setTimeout(() => { copyBtn.textContent = '📋'; }, 2000);
        }).catch(() => showToast('❌ Impossibile copiare'));
    }

    // === TABS ===
    function handleTabClick(btn) {
        const tab = btn.dataset.tab;
        if (!tab) return;
        switchToTab(tab);
    }

    function switchToTab(tab) {
        tabBtns.forEach(b => b.classList.remove('active'));
        document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
        currentTab = tab;
        renderTabContent(tab);
    }

    // === RENDER TAB CONTENT ===
    function renderTabContent(tab) {
        if (!playlistContainer) return;

        switch (tab) {
            case 'queue': renderQueue(); break;
            case 'history': renderList(Storage.getHistory(), 'Nessuna cronologia recente'); break;
            case 'favorites': renderList(Storage.getFavorites(), 'Nessun video preferito'); break;
            case 'playlists': renderPlaylists(); break;
        }
    }

    // --- Queue rendering (with numbers and remove buttons) ---
    function renderQueue() {
        const items = player?.getQueue() || [];
        const currentIdx = player?.getCurrentIndex() ?? -1;

        if (items.length === 0) {
            playlistContainer.innerHTML = `
                <p class="empty-state">La coda è vuota.<br>
                <small>Incolla un link YouTube e premi <strong>+ Coda</strong> per aggiungere brani,<br>
                oppure premi <strong>▶ Riproduci</strong> per ascoltare subito.</small></p>`;
            return;
        }

        playlistContainer.innerHTML = items.map((item, index) => `
            <div class="playlist-item ${currentIdx === index ? 'active' : ''}" 
                 data-index="${index}" data-videoid="${item.videoId}">
                <span class="queue-number">${index + 1}</span>
                <img class="playlist-item-thumb" src="${item.thumbnailUrl}" alt=""
                     onerror="this.src='https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg'">
                <div class="playlist-item-info">
                    <div class="playlist-item-title">${escapeHtml(item.title)}</div>
                    <div class="playlist-item-duration">${escapeHtml(item.author)}</div>
                </div>
                <button class="remove-btn" data-remove-index="${index}" title="Rimuovi dalla coda">✕</button>
            </div>
        `).join('');

        // Click to play
        playlistContainer.querySelectorAll('.playlist-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('remove-btn')) return;
                const idx = parseInt(el.dataset.index);
                if (player) {
                    player.currentIndex = idx;
                    player._loadAndPlayIndex(idx);
                }
            });
        });

        // Remove buttons
        playlistContainer.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.removeIndex);
                player?.removeFromQueue(idx);
                showToast('🗑️ Rimosso dalla coda');
            });
        });
    }

    // --- History / Favorites list rendering ---
    function renderList(items, emptyMessage) {
        if (items.length === 0) {
            playlistContainer.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
            return;
        }

        playlistContainer.innerHTML = items.map((item, index) => `
            <div class="playlist-item" data-index="${index}" data-videoid="${item.videoId}">
                <img class="playlist-item-thumb" src="${item.thumbnailUrl}" alt=""
                     onerror="this.src='https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg'">
                <div class="playlist-item-info">
                    <div class="playlist-item-title">${escapeHtml(item.title)}</div>
                    <div class="playlist-item-duration">${escapeHtml(item.author)}</div>
                </div>
            </div>
        `).join('');

        playlistContainer.querySelectorAll('.playlist-item').forEach(el => {
            el.addEventListener('click', () => handleListItemClick(el));
        });
    }

    async function handleListItemClick(el) {
        const videoId = el.dataset.videoid;
        showLoading(true);

        try {
            const result = await API.fetchVideoData(videoId);
            if (result.success) {
                player.addAndPlay(result.data);
                playerSection.classList.remove('hidden');
            }
        } catch (error) {
            showToast('❌ Errore nel caricamento');
        } finally {
            showLoading(false);
        }
    }

    // --- Playlists tab rendering ---
    function renderPlaylists() {
        const playlists = Storage.getPlaylists();
        const queueLength = player?.getQueue()?.length || 0;

        let html = `
            <div class="playlist-manager">
                ${queueLength > 0 ? `
                    <div class="save-bar">
                        <input type="text" id="inline-playlist-name" placeholder="Nome playlist..." />
                        <button class="secondary-btn" id="inline-save-btn">💾 Salva coda</button>
                    </div>
                ` : ''}
        `;

        if (playlists.length === 0) {
            html += `<p class="empty-state">Nessuna playlist salvata.<br>
                <small>Costruisci una coda con i tuoi brani, poi salvala come playlist!</small></p>`;
        } else {
            html += playlists.map(pl => `
                <div class="playlist-card" data-playlist-name="${escapeHtml(pl.name)}">
                    <div class="playlist-card-info">
                        <h3>🎶 ${escapeHtml(pl.name)}</h3>
                        <p>${pl.items.length} brani · ${timeAgo(pl.updatedAt || pl.createdAt)}</p>
                    </div>
                    <div class="playlist-card-actions">
                        <button class="load-playlist-btn" title="Carica in coda">▶</button>
                        <button class="delete-playlist-btn" title="Elimina">🗑️</button>
                    </div>
                </div>
            `).join('');
        }

        html += `</div>`;
        playlistContainer.innerHTML = html;

        // Bind save button
        document.getElementById('inline-save-btn')?.addEventListener('click', () => {
            const nameInput = document.getElementById('inline-playlist-name');
            const name = nameInput?.value.trim();
            if (!name) {
                showToast('⚠️ Inserisci un nome per la playlist');
                nameInput?.focus();
                return;
            }
            const queue = player?.getQueue() || [];
            Storage.savePlaylist(name, queue);
            showToast(`💾 Playlist "${name}" salvata (${queue.length} brani)`);
            nameInput.value = '';
            renderPlaylists();
        });

        // Bind load buttons
        playlistContainer.querySelectorAll('.load-playlist-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = btn.closest('.playlist-card').dataset.playlistName;
                const pl = Storage.getPlaylists().find(p => p.name === name);
                if (pl) {
                    player.loadPlaylistToQueue(pl.items);
                    showToast(`▶ Playlist "${name}" caricata (${pl.items.length} brani)`);
                    switchToTab('queue');

                    // Avvia il primo brano
                    if (pl.items.length > 0) {
                        player.currentIndex = 0;
                        player._loadAndPlayIndex(0);
                    }
                }
            });
        });

        // Bind delete buttons
        playlistContainer.querySelectorAll('.delete-playlist-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = btn.closest('.playlist-card').dataset.playlistName;
                if (confirm(`Eliminare la playlist "${name}"?`)) {
                    Storage.deletePlaylist(name);
                    showToast(`🗑️ Playlist "${name}" eliminata`);
                    renderPlaylists();
                }
            });
        });

        // Click on card to expand/preview
        playlistContainer.querySelectorAll('.playlist-card').forEach(card => {
            card.addEventListener('click', () => {
                const name = card.dataset.playlistName;
                const pl = Storage.getPlaylists().find(p => p.name === name);
                if (pl) {
                    player.loadPlaylistToQueue(pl.items);
                    showToast(`▶ Playlist "${name}" caricata`);
                    switchToTab('queue');
                    if (pl.items.length > 0) {
                        player.currentIndex = 0;
                        player._loadAndPlayIndex(0);
                    }
                }
            });
        });
    }

    // === Save Playlist Modal (legacy) ===
    function handleSavePlaylist() {
        const nameInput = document.getElementById('playlist-name-input');
        const name = nameInput?.value?.trim();
        if (!name) {
            showToast('⚠️ Inserisci un nome per la playlist');
            return;
        }
        const queue = player?.getQueue() || [];
        if (queue.length === 0) {
            showToast('⚠️ La coda è vuota!');
            return;
        }

        Storage.savePlaylist(name, queue);
        showToast(`💾 Playlist "${name}" salvata con ${queue.length} brani`);
        nameInput.value = '';
        document.getElementById('save-playlist-modal')?.classList.add('hidden');
        if (currentTab === 'playlists') renderPlaylists();
    }

    // === TOAST NOTIFICATIONS ===
    function showToast(message) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => toast.remove(), 3000);
    }

    // === LOADING ===
    function showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        if (show) overlay?.classList.remove('hidden');
        else overlay?.classList.add('hidden');
    }

    function loadInitialUI() {
        renderTabContent('queue');
    }

    // === UTILITIES ===
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function timeAgo(timestamp) {
        if (!timestamp) return '';
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return 'poco fa';
        if (seconds < 3600) return `${Math.floor(seconds / 60)} min fa`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} ore fa`;
        if (seconds < 604800) return `${Math.floor(seconds / 86400)} giorni fa`;
        return new Date(timestamp).toLocaleDateString('it-IT');
    }

    // Avvia
    init();
})();
