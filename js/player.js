/**
 * Player Audio per YouTube Audio Player
 * Gestisce la riproduzione audio e i controlli
 */

class AudioPlayer {
    constructor() {
        this.audio = document.getElementById('audio-player');
        this.isPlaying = false;
        this.currentVideo = null;
        this.queue = [];
        this.currentIndex = -1;
        this.wakeLock = null;
        this.resumeOnGestureHandler = null;

        // Shuffle & Repeat
        this.shuffleEnabled = false;
        this.repeatMode = 'none'; // 'none', 'all', 'one'

        // Callbacks - app.js li assegna
        this.onTrackChange = null;
        this.onQueueChange = null;

        // Elementi UI
        this.playPauseBtn = document.getElementById('play-pause-btn');
        this.prevBtn = document.getElementById('prev-btn');
        this.nextBtn = document.getElementById('next-btn');
        this.shuffleBtn = document.getElementById('shuffle-btn');
        this.repeatBtn = document.getElementById('repeat-btn');
        this.progressBar = document.getElementById('progress-bar');
        this.volumeSlider = document.getElementById('volume-slider');
        this.currentTimeEl = document.getElementById('current-time');
        this.durationEl = document.getElementById('duration');

        this.init();
    }

    init() {
        // Event listeners per controlli
        this.playPauseBtn?.addEventListener('click', () => this.togglePlay());
        this.prevBtn?.addEventListener('click', () => this.playPrevious());
        this.nextBtn?.addEventListener('click', () => this.playNext());
        this.shuffleBtn?.addEventListener('click', () => this.toggleShuffle());
        this.repeatBtn?.addEventListener('click', () => this.toggleRepeat());

        this.progressBar?.addEventListener('input', (e) => this.seek(e.target.value));
        this.progressBar?.addEventListener('change', (e) => this.seek(e.target.value));
        this.volumeSlider?.addEventListener('input', (e) => this.setVolume(e.target.value));

        // Audio events
        this.audio.addEventListener('timeupdate', () => this.updateProgress());
        this.audio.addEventListener('loadedmetadata', () => this.onMetadataLoaded());
        this.audio.addEventListener('ended', () => this.onEnded());
        this.audio.addEventListener('error', (e) => this.onError(e));
        this.audio.addEventListener('waiting', () => this.onBuffering(true));
        this.audio.addEventListener('playing', () => this.onBuffering(false));
        this.audio.addEventListener('play', () => this.onPlay());
        this.audio.addEventListener('pause', () => this.onPause());

        // Carica volume salvato
        const savedVolume = Storage.getVolume();
        if (savedVolume !== null) {
            this.setVolume(savedVolume);
            this.volumeSlider.value = savedVolume;
        }

        // Carica coda salvata
        this.queue = Storage.getQueue();

        // Carica impostazioni shuffle/repeat
        const settings = Storage.getSettings();
        if (settings.shuffleEnabled) {
            this.shuffleEnabled = true;
            this.shuffleBtn?.classList.add('active');
        }
        if (settings.repeatMode) {
            this.repeatMode = settings.repeatMode;
            this.updateRepeatButton();
        }
    }

    /**
     * Carica un video nel player
     */
    load(video) {
        if (!video) return;

        this.currentVideo = video;

        const audioUrl = API.getBestAudioUrl(video);
        if (!audioUrl) {
            this.showError('Audio non disponibile per questo video');
            return;
        }

        this.audio.src = audioUrl;
        this.audio.load();

        // Aggiorna UI info video
        document.getElementById('video-title').textContent = video.title;
        document.getElementById('video-channel').textContent = video.author;
        document.getElementById('video-stats').textContent = API.formatViewCount(video.viewCount);
        document.getElementById('video-thumb').src = video.thumbnailUrl;

        this.onTrackChange?.(video);
    }

    togglePlay() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    async play() {
        if (!this.audio.src) {
            this.showError('Nessun audio caricato');
            return;
        }

        try {
            await this.audio.play();
            this.clearResumeOnUserGesture();
            this.isPlaying = true;
            this.updatePlayButton();
            this.requestWakeLock();
            this.onPlayStateChange?.(true);
        } catch (error) {
            console.error('Playback failed:', error);
            const isAutoplayBlock = error?.name === 'NotAllowedError' ||
                /gesture|autoplay|notallowed/i.test(error?.message || '');

            if (isAutoplayBlock) {
                const recovered = await this.tryMutedAutoplay();
                if (recovered) return;

                this.armResumeOnUserGesture();
                this.showError('Il browser ha bloccato l\'autoplay. Tocca di nuovo Play.');
                return;
            }

            this.showError('Errore nella riproduzione: ' + error.message);
        }
    }

    async tryMutedAutoplay() {
        const previousMuted = this.audio.muted;
        try {
            this.audio.muted = true;
            await this.audio.play();
            this.audio.muted = previousMuted;
            this.clearResumeOnUserGesture();
            this.isPlaying = true;
            this.updatePlayButton();
            this.requestWakeLock();
            this.onPlayStateChange?.(true);
            return true;
        } catch {
            this.audio.muted = previousMuted;
            return false;
        }
    }

    armResumeOnUserGesture() {
        if (this.resumeOnGestureHandler) return;

        this.resumeOnGestureHandler = async () => {
            try {
                await this.audio.play();
                this.clearResumeOnUserGesture();
            } catch {
                // keep waiting for a valid gesture
            }
        };

        document.addEventListener('pointerdown', this.resumeOnGestureHandler, { passive: true });
        document.addEventListener('keydown', this.resumeOnGestureHandler);
    }

    clearResumeOnUserGesture() {
        if (!this.resumeOnGestureHandler) return;
        document.removeEventListener('pointerdown', this.resumeOnGestureHandler);
        document.removeEventListener('keydown', this.resumeOnGestureHandler);
        this.resumeOnGestureHandler = null;
    }

    pause() {
        this.audio.pause();
        this.isPlaying = false;
        this.updatePlayButton();
    }

    updatePlayButton() {
        if (this.playPauseBtn) {
            this.playPauseBtn.textContent = this.isPlaying ? '❚❚' : '▶';
        }
    }

    seek(time) {
        const seekTime = parseFloat(time);
        if (isNaN(seekTime)) return;
        this.audio.currentTime = seekTime;
        this.updateProgress();
    }

    setVolume(value) {
        const volume = Math.max(0, Math.min(100, parseInt(value))) / 100;
        this.audio.volume = volume;
        if (this.volumeSlider) {
            this.volumeSlider.value = value;
        }
        Storage.setVolume(value);
    }

    // === QUEUE MANAGEMENT ===

    /**
     * Aggiungi alla coda (senza riprodurre)
     */
    addToQueue(video) {
        // Non aggiungere duplicati
        if (this.queue.some(v => v.videoId === video.videoId)) {
            return false;
        }

        this.queue.push({
            videoId: video.videoId,
            title: video.title,
            author: video.author,
            thumbnailUrl: video.thumbnailUrl,
            audioUrl: video.audioUrl,
            lengthSeconds: video.lengthSeconds || 0,
            addedAt: Date.now()
        });

        Storage.saveQueue(this.queue);
        this.onQueueChange?.();
        return true;
    }

    /**
     * Aggiungi alla coda e inizia a riprodurre
     */
    addAndPlay(video) {
        const existingIndex = this.queue.findIndex(v => v.videoId === video.videoId);
        if (existingIndex >= 0) {
            this.currentIndex = existingIndex;
        } else {
            this.addToQueue(video);
            this.currentIndex = this.queue.length - 1;
        }

        this.load(video);
        this.play();
        Storage.addToHistory(video);
    }

    removeFromQueue(index) {
        if (index < 0 || index >= this.queue.length) return;

        this.queue.splice(index, 1);

        if (index < this.currentIndex) {
            this.currentIndex--;
        } else if (index === this.currentIndex) {
            this.pause();
            this.audio.src = '';
            if (this.queue.length > 0) {
                this.currentIndex = Math.min(this.currentIndex, this.queue.length - 1);
            } else {
                this.currentIndex = -1;
            }
        }

        Storage.saveQueue(this.queue);
        this.onQueueChange?.();
    }

    /**
     * Carica tutta una playlist nella coda
     */
    loadPlaylistToQueue(items) {
        this.queue = items.map(v => ({
            videoId: v.videoId,
            title: v.title,
            author: v.author,
            thumbnailUrl: v.thumbnailUrl,
            audioUrl: v.audioUrl || null,
            addedAt: Date.now()
        }));
        this.currentIndex = -1;
        Storage.saveQueue(this.queue);
        this.onQueueChange?.();
    }

    clearQueue() {
        this.queue = [];
        this.currentIndex = -1;
        this.pause();
        this.audio.src = '';
        Storage.clearQueue();
        this.onQueueChange?.();
    }

    getQueue() { return this.queue; }
    getCurrentIndex() { return this.currentIndex; }

    // === NAVIGATION ===

    playPrevious() {
        if (this.queue.length === 0) return;

        // Se siamo oltre 3 secondi, riavvolgi al'inizio
        if (this.audio.currentTime > 3) {
            this.audio.currentTime = 0;
            return;
        }

        if (this.currentIndex > 0) {
            this.currentIndex--;
            this._loadAndPlayIndex(this.currentIndex);
        }
    }

    playNext() {
        if (this.queue.length === 0) return;

        if (this.shuffleEnabled) {
            this._playShuffledNext();
            return;
        }

        if (this.currentIndex < this.queue.length - 1) {
            this.currentIndex++;
            this._loadAndPlayIndex(this.currentIndex);
        } else if (this.repeatMode === 'all') {
            this.currentIndex = 0;
            this._loadAndPlayIndex(0);
        }
    }

    async _loadAndPlayIndex(index) {
        const video = this.queue[index];
        if (!video) return;

        // Se il video non ha audioUrl (caricato da playlist), 
        // dobbiamo riottenere l'URL dal server
        if (!video.audioUrl) {
            try {
                const result = await API.fetchVideoData(video.videoId);
                if (result.success) {
                    Object.assign(video, result.data);
                    this.queue[index] = video;
                    Storage.saveQueue(this.queue);
                }
            } catch (e) {
                console.error('Failed to fetch video data for queue item:', e);
                return;
            }
        }

        this.load(video);
        this.play();
        this.onQueueChange?.();
    }

    _playShuffledNext() {
        if (this.queue.length <= 1) return;

        let nextIndex;
        do {
            nextIndex = Math.floor(Math.random() * this.queue.length);
        } while (nextIndex === this.currentIndex && this.queue.length > 1);

        this.currentIndex = nextIndex;
        this._loadAndPlayIndex(nextIndex);
    }

    // === SHUFFLE & REPEAT ===

    toggleShuffle() {
        this.shuffleEnabled = !this.shuffleEnabled;
        this.shuffleBtn?.classList.toggle('active', this.shuffleEnabled);
        Storage.saveSettings({ shuffleEnabled: this.shuffleEnabled });
    }

    toggleRepeat() {
        const modes = ['none', 'all', 'one'];
        const currentIdx = modes.indexOf(this.repeatMode);
        this.repeatMode = modes[(currentIdx + 1) % modes.length];
        this.updateRepeatButton();
        Storage.saveSettings({ repeatMode: this.repeatMode });
    }

    updateRepeatButton() {
        if (!this.repeatBtn) return;

        this.repeatBtn.classList.remove('active');

        switch (this.repeatMode) {
            case 'none':
                this.repeatBtn.textContent = '🔁';
                break;
            case 'all':
                this.repeatBtn.textContent = '🔁';
                this.repeatBtn.classList.add('active');
                break;
            case 'one':
                this.repeatBtn.textContent = '🔂';
                this.repeatBtn.classList.add('active');
                break;
        }
    }

    // === AUDIO EVENTS ===

    updateProgress() {
        if (!this.audio.duration || isNaN(this.audio.duration)) return;

        if (this.progressBar) {
            this.progressBar.value = this.audio.currentTime;
            this.progressBar.max = Math.floor(this.audio.duration);
        }

        if (this.currentTimeEl) {
            this.currentTimeEl.textContent = API.formatDuration(this.audio.currentTime);
        }
    }

    onMetadataLoaded() {
        if (this.durationEl) {
            this.durationEl.textContent = API.formatDuration(this.audio.duration);
        }
        if (this.progressBar) {
            this.progressBar.max = Math.floor(this.audio.duration);
        }
        this.onReady?.();
    }

    onEnded() {
        this.isPlaying = false;
        this.updatePlayButton();

        // Repeat one: riproduci lo stesso brano
        if (this.repeatMode === 'one') {
            this.audio.currentTime = 0;
            this.play();
            return;
        }

        // Auto-play next
        if (this.currentIndex < this.queue.length - 1 || this.shuffleEnabled || this.repeatMode === 'all') {
            this.playNext();
        }
    }

    onError(e) {
        console.error('Audio error:', e);
        const error = this.audio.error;
        let message = 'Errore nella riproduzione audio';

        if (error) {
            switch (error.code) {
                case MediaError.MEDIA_ERR_ABORTED:
                    message = 'Riproduzione interrotta';
                    break;
                case MediaError.MEDIA_ERR_NETWORK:
                    message = 'Errore di rete';
                    break;
                case MediaError.MEDIA_ERR_DECODE:
                    message = 'Errore nella decodifica audio';
                    break;
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                    message = 'Formato audio non supportato';
                    break;
            }
        }

        this.showError(message);
        this.isPlaying = false;
        this.updatePlayButton();
    }

    onBuffering(isBuffering) {
        const overlay = document.getElementById('loading-overlay');
        if (isBuffering) {
            overlay?.classList.remove('hidden');
        } else {
            overlay?.classList.add('hidden');
        }
    }

    updateMediaSession() {
        if ('mediaSession' in navigator && this.currentVideo) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: this.currentVideo.title,
                artist: this.currentVideo.author,
                artwork: [
                    { src: this.currentVideo.thumbnailUrl, sizes: '512x512', type: 'image/jpeg' }
                ]
            });

            navigator.mediaSession.setActionHandler('play', () => this.play());
            navigator.mediaSession.setActionHandler('pause', () => this.pause());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrevious());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext());
        }
    }

    onPlay() {
        this.isPlaying = true;
        this.updatePlayButton();
        this.updateMediaSession();
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
        }
    }

    onPause() {
        this.isPlaying = false;
        this.updatePlayButton();
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
        }
    }

    showError(message) {
        console.error(message);
        if (message) alert(message);
    }

    async requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => {
                    this.wakeLock = null;
                });
            }
        } catch (err) {
            console.warn('Wake Lock non disponibile:', err.message);
        }
    }

    async releaseWakeLock() {
        if (this.wakeLock) {
            try {
                await this.wakeLock.release();
                this.wakeLock = null;
            } catch (err) {
                console.warn('Errore nel rilascio Wake Lock:', err);
            }
        }
    }
}

// Esporta
window.AudioPlayer = AudioPlayer;
