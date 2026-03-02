/**
 * Storage Handler per YouTube Audio Player
 * Gestisce LocalStorage per cronologia, preferiti, impostazioni
 */

const Storage = {
    KEYS: {
        HISTORY: 'yt_audio_history',
        FAVORITES: 'yt_audio_favorites',
        QUEUE: 'yt_audio_queue',
        VOLUME: 'yt_audio_volume',
        SETTINGS: 'yt_audio_settings',
        PLAYLISTS: 'yt_audio_playlists'
    },

    MAX_ITEMS: 50,

    /**
     * Salva un valore nel localStorage
     * @param {string} key - Chiave
     * @param {any} value - Valore
     * @returns {boolean}
     */
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('Storage error:', e);
            return false;
        }
    },

    /**
     * Ottiene un valore dal localStorage
     * @param {string} key - Chiave
     * @returns {any}
     */
    get(key) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : null;
        } catch (e) {
            console.error('Storage error:', e);
            return null;
        }
    },

    /**
     * Rimuove un valore dal localStorage
     * @param {string} key - Chiave
     */
    remove(key) {
        localStorage.removeItem(key);
    },

    /**
     * Aggiunge un video alla cronologia
     * @param {Object} video - Dati del video
     */
    addToHistory(video) {
        let history = this.get(this.KEYS.HISTORY) || [];

        // Rimuovi se già presente (per evitare duplicati in cima)
        history = history.filter(v => v.videoId !== video.videoId);

        // Aggiungi all'inizio
        history.unshift({
            videoId: video.videoId,
            title: video.title,
            author: video.author,
            thumbnailUrl: video.thumbnailUrl,
            addedAt: Date.now()
        });

        // Limita la dimensione
        if (history.length > this.MAX_ITEMS) {
            history = history.slice(0, this.MAX_ITEMS);
        }

        this.set(this.KEYS.HISTORY, history);
    },

    /**
     * Ottiene la cronologia
     * @returns {Array}
     */
    getHistory() {
        return this.get(this.KEYS.HISTORY) || [];
    },

    /**
     * Pulisci la cronologia
     */
    clearHistory() {
        this.remove(this.KEYS.HISTORY);
    },

    /**
     * Aggiunge ai preferiti
     * @param {Object} video - Dati del video
     * @returns {boolean} - true se aggiunto, false se già presente
     */
    addToFavorites(video) {
        let favorites = this.get(this.KEYS.FAVORITES) || [];

        // Check se già presente
        if (favorites.some(f => f.videoId === video.videoId)) {
            return false;
        }

        favorites.unshift({
            videoId: video.videoId,
            title: video.title,
            author: video.author,
            thumbnailUrl: video.thumbnailUrl,
            addedAt: Date.now()
        });

        this.set(this.KEYS.FAVORITES, favorites);
        return true;
    },

    /**
     * Rimuove dai preferiti
     * @param {string} videoId - ID del video
     */
    removeFromFavorites(videoId) {
        let favorites = this.get(this.KEYS.FAVORITES) || [];
        favorites = favorites.filter(f => f.videoId !== videoId);
        this.set(this.KEYS.FAVORITES, favorites);
    },

    /**
     * Verifica se è nei preferiti
     * @param {string} videoId - ID del video
     * @returns {boolean}
     */
    isFavorite(videoId) {
        const favorites = this.get(this.KEYS.FAVORITES) || [];
        return favorites.some(f => f.videoId === videoId);
    },

    /**
     * Toggle preferito
     * @param {Object} video - Dati del video
     * @returns {boolean} - true se aggiunto, false se rimosso
     */
    toggleFavorite(video) {
        if (this.isFavorite(video.videoId)) {
            this.removeFromFavorites(video.videoId);
            return false;
        } else {
            this.addToFavorites(video);
            return true;
        }
    },

    /**
     * Ottiene i preferiti
     * @returns {Array}
     */
    getFavorites() {
        return this.get(this.KEYS.FAVORITES) || [];
    },

    /**
     * Salva la coda
     * @param {Array} queue - Array di video
     */
    saveQueue(queue) {
        this.set(this.KEYS.QUEUE, queue);
    },

    /**
     * Ottiene la coda
     * @returns {Array}
     */
    getQueue() {
        return this.get(this.KEYS.QUEUE) || [];
    },

    /**
     * Aggiunge un video alla coda
     * @param {Object} video - Dati del video
     */
    addToQueue(video) {
        let queue = this.getQueue();
        queue.push({
            videoId: video.videoId,
            title: video.title,
            author: video.author,
            thumbnailUrl: video.thumbnailUrl,
            addedAt: Date.now()
        });
        this.saveQueue(queue);
    },

    /**
     * Rimuove un video dalla coda
     * @param {number} index - Indice del video
     */
    removeFromQueue(index) {
        let queue = this.getQueue();
        queue.splice(index, 1);
        this.saveQueue(queue);
    },

    /**
     * Pulisci la coda
     */
    clearQueue() {
        this.remove(this.KEYS.QUEUE);
    },

    /**
     * Salva le impostazioni
     * @param {Object} settings - Impostazioni
     */
    saveSettings(settings) {
        const current = this.get(this.KEYS.SETTINGS) || {};
        this.set(this.KEYS.SETTINGS, { ...current, ...settings });
    },

    /**
     * Ottiene le impostazioni
     * @returns {Object}
     */
    getSettings() {
        return this.get(this.KEYS.SETTINGS) || {};
    },

    /**
     * Salva il volume
     * @param {number} volume - Livello volume 0-100
     */
    setVolume(volume) {
        this.set(this.KEYS.VOLUME, volume);
    },

    /**
     * Ottiene il volume
     * @returns {number}
     */
    getVolume() {
        return this.get(this.KEYS.VOLUME) || 100;
    },

    // === Playlist Management ===

    /**
     * Ottiene tutte le playlist salvate
     * @returns {Array} - Array di playlist objects {name, items, createdAt}
     */
    getPlaylists() {
        return this.get(this.KEYS.PLAYLISTS) || [];
    },

    /**
     * Salva una nuova playlist
     * @param {string} name - Nome della playlist
     * @param {Array} items - Array di video items
     */
    savePlaylist(name, items) {
        const playlists = this.getPlaylists();

        // Se esiste già una con lo stesso nome, aggiornala
        const existing = playlists.findIndex(p => p.name === name);
        const playlist = {
            name,
            items: items.map(v => ({
                videoId: v.videoId,
                title: v.title,
                author: v.author,
                thumbnailUrl: v.thumbnailUrl,
            })),
            createdAt: existing >= 0 ? playlists[existing].createdAt : Date.now(),
            updatedAt: Date.now(),
        };

        if (existing >= 0) {
            playlists[existing] = playlist;
        } else {
            playlists.unshift(playlist);
        }

        this.set(this.KEYS.PLAYLISTS, playlists);
    },

    /**
     * Elimina una playlist
     * @param {string} name - Nome della playlist
     */
    deletePlaylist(name) {
        let playlists = this.getPlaylists();
        playlists = playlists.filter(p => p.name !== name);
        this.set(this.KEYS.PLAYLISTS, playlists);
    },

    /**
     * Rinomina una playlist
     * @param {string} oldName 
     * @param {string} newName  
     */
    renamePlaylist(oldName, newName) {
        const playlists = this.getPlaylists();
        const pl = playlists.find(p => p.name === oldName);
        if (pl) {
            pl.name = newName;
            pl.updatedAt = Date.now();
            this.set(this.KEYS.PLAYLISTS, playlists);
        }
    },

    /**
     * Pulisci preferiti
     */
    clearFavorites() {
        this.remove(this.KEYS.FAVORITES);
    }
};

// Esporta per uso globale
window.Storage = Storage;
