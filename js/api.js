/**
 * API Handler per YouTube Audio Player
 * Comunica con il server proxy locale (server.js) che usa yt-dlp
 */

const API = {
    // URL del proxy locale
    proxyBase: window.location.origin,

    /**
     * Estrae l'ID del video da un URL YouTube
     * @param {string} url - URL YouTube
     * @returns {string|null} - Video ID o null
     */
    extractVideoId(url) {
        if (!url) return null;

        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    },

    /**
     * Valida se l'URL è un URL YouTube valido
     * @param {string} url - URL da validare
     * @returns {boolean}
     */
    isValidYouTubeUrl(url) {
        return this.extractVideoId(url) !== null;
    },

    /**
     * Ottiene i dati del video tramite il proxy locale (yt-dlp)
     * @param {string} videoId - ID del video
     * @returns {Promise<Object>}
     */
    async fetchVideoData(videoId) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 90000); // Render cold start + estrazione audio possono richiedere più tempo

            console.log(`[API] Richiedo dati per video: ${videoId}`);

            const response = await fetch(`${this.proxyBase}/api/video/${videoId}`, {
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            const result = await response.json();

            if (!result.success) {
                return {
                    success: false,
                    error: result.error || 'Errore sconosciuto dal server.'
                };
            }

            // I dati arrivano già normalizzati dal server
            const data = result.data;

            console.log(`[API] Video caricato: "${data.title}" di ${data.author}`);
            return { success: true, data, server: 'yt-dlp (locale)' };

        } catch (error) {
            console.error('[API] Errore:', error);

            if (error.name === 'AbortError') {
                return {
                    success: false,
                    error: 'Timeout: server lento o in cold start. Attendi qualche secondo e riprova.'
                };
            }

            return {
                success: false,
                error: 'Errore di connessione al server locale.\n\nAssicurati di aver avviato il server con:\n  node server.js'
            };
        }
    },

    /**
     * Formatta il conteggio visualizzazioni
     * @param {number} count
     * @returns {string}
     */
    formatViewCount(count) {
        if (!count) return '0 visualizzazioni';
        if (count >= 1000000) {
            return `${(count / 1000000).toFixed(1)}M visualizzazioni`;
        }
        if (count >= 1000) {
            return `${(count / 1000).toFixed(1)}K visualizzazioni`;
        }
        return `${count} visualizzazioni`;
    },

    /**
     * Formatta la durata in mm:ss
     * @param {number} seconds
     * @returns {string}
     */
    formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    /**
     * Ottiene l'URL diretto dell'audio
     * @param {Object} videoData - Dati del video
     * @returns {string|null}
     */
    getBestAudioUrl(videoData) {
        if (videoData.audioUrl) {
            return videoData.audioUrl;
        }
        if (videoData.hlsUrl) {
            return videoData.hlsUrl;
        }
        return null;
    }
};

// Esporta per uso globale
window.API = API;
