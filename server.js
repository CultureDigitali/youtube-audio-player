/**
 * YouTube Audio Player - Server Proxy Multi-Backend
 * 
 * Backend Strategy (fallback chain):
 *   1. cobalt.tools API → funziona dal cloud senza blocchi
 *   2. yt-dlp locale    → funziona perfettamente in locale
 * 
 * Per i metadati usa YouTube oEmbed (funziona ovunque).
 * Serve anche i file statici della web app.
 */

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Istanze cobalt.tools pubbliche (fallback chain)
const COBALT_INSTANCES = [
    'https://api.cobalt.tools',
    'https://cobalt-api.kwiatekmiki.com',
];

// MIME types per i file statici
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.webm': 'audio/webm',
    '.mp4': 'audio/mp4',
};

// Cache in memoria (TTL 30 min)
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.time < CACHE_TTL) {
        return entry.data;
    }
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, time: Date.now() });
}

// ─── Helper: HTTPS fetch con JSON ───────────────────────
function fetchJSON(fetchUrl, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(fetchUrl);
        const reqOptions = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(options.headers || {}),
            },
            timeout: options.timeout || 15000,
        };

        const req = https.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    reject(new Error(`JSON parse error (status ${res.statusCode})`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ─── YouTube oEmbed: metadati (funziona ovunque) ────────
async function getVideoMetadata(videoId) {
    const cached = getCached(`meta_${videoId}`);
    if (cached) return cached;

    try {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
        const { data } = await fetchJSON(oembedUrl);

        const meta = {
            title: data.title || 'Titolo non disponibile',
            author: data.author_name || 'Canale sconosciuto',
            thumbnailUrl: data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            videoId: videoId,
        };
        setCache(`meta_${videoId}`, meta);
        return meta;
    } catch (err) {
        console.log(`[OEMBED] Fallback thumbnail per ${videoId}:`, err.message);
        return {
            title: 'Video YouTube',
            author: 'Sconosciuto',
            thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            videoId: videoId,
        };
    }
}

// ─── Backend 1: cobalt.tools (cloud-friendly) ───────────
async function extractWithCobalt(videoId) {
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

    for (const instance of COBALT_INSTANCES) {
        try {
            console.log(`[COBALT] Tentativo: ${instance}...`);
            const { status, data } = await fetchJSON(`${instance}/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    url: ytUrl,
                    downloadMode: 'audio',
                    audioFormat: 'best',
                    audioBitrate: '128',
                }),
                timeout: 20000,
            });

            if (data.status === 'tunnel' || data.status === 'redirect') {
                console.log(`[COBALT] OK da ${instance}`);
                return {
                    audioUrl: data.url,
                    filename: data.filename || null,
                    source: 'cobalt',
                };
            } else if (data.status === 'picker' && data.picker?.length > 0) {
                // cobalt returns multiple options, pick the first audio
                const audio = data.picker.find(p => p.type === 'audio') || data.picker[0];
                console.log(`[COBALT] OK (picker) da ${instance}`);
                return {
                    audioUrl: audio.url,
                    filename: data.filename || null,
                    source: 'cobalt',
                };
            } else {
                console.log(`[COBALT] Risposta non valida da ${instance}:`, data.status, data.error?.code);
            }
        } catch (err) {
            console.log(`[COBALT] Errore ${instance}:`, err.message);
        }
    }
    return null;
}
// ─── Backend 2: youtube-dl-exec (locale, autonoma, senza dipendenze Python) ─────────────
const youtubedl = require('youtube-dl-exec');

function extractWithYtDlp(videoId) {
    return new Promise((resolve) => {
        const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

        const options = {
            dumpJson: true,
            noWarnings: true,
            noCheckCertificates: true,
            format: 'bestaudio',
            geoBypass: true
        };

        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            options.cookies = cookiesPath;
        }

        console.log(`[YT-DLP-EXEC] Tentativo per ${videoId}...`);

        youtubedl(ytUrl, options).then(data => {
            console.log(`[YT-DLP-EXEC] OK: "${data.title}"`);
            resolve({
                title: data.title,
                author: data.uploader || data.channel,
                channelId: data.channel_id || '',
                viewCount: data.view_count || 0,
                lengthSeconds: data.duration || 0,
                audioUrl: data.url,
                audioBitrate: data.abr || 128,
                audioType: data.ext === 'webm' ? 'audio/webm' : 'audio/mp4',
                thumbnailUrl: data.thumbnail,
                description: (data.description || '').slice(0, 200),
                source: 'yt-dlp',
            });
        }).catch(error => {
            console.log(`[YT-DLP-EXEC] Errore:`, error.message.slice(0, 300));
            resolve(null);
        });
    });
}

// ─── Estrazione principale (fallback chain) ─────────────
async function extractVideoInfo(videoId) {
    const cached = getCached(videoId);
    if (cached) {
        console.log(`[CACHE] Hit per ${videoId}`);
        return cached;
    }

    console.log(`[EXTRACT] Inizio estrazione per ${videoId}...`);

    // 1. Ottieni metadati via oEmbed (veloce, funziona ovunque)
    const meta = await getVideoMetadata(videoId);

    // 2. Prova cobalt.tools (funziona dal cloud)
    let audioResult = await extractWithCobalt(videoId);

    // 3. Fallback: yt-dlp (funziona in locale)
    if (!audioResult) {
        console.log('[EXTRACT] Cobalt fallito, provo yt-dlp...');
        const ytdlpResult = await extractWithYtDlp(videoId);
        if (ytdlpResult) {
            audioResult = ytdlpResult;
            // yt-dlp ci dà anche i metadati migliori
            meta.title = ytdlpResult.title || meta.title;
            meta.author = ytdlpResult.author || meta.author;
            meta.thumbnailUrl = ytdlpResult.thumbnailUrl || meta.thumbnailUrl;
        }
    }

    if (!audioResult || !audioResult.audioUrl) {
        throw new Error('Impossibile estrarre l\'audio. Tutti i backend hanno fallito.');
    }

    const result = {
        title: meta.title,
        author: meta.author,
        channelId: audioResult.channelId || '',
        viewCount: audioResult.viewCount || 0,
        lengthSeconds: audioResult.lengthSeconds || 0,
        videoId: videoId,
        thumbnailUrl: meta.thumbnailUrl,
        audioUrl: audioResult.audioUrl,
        audioBitrate: audioResult.audioBitrate || 128,
        audioType: audioResult.audioType || 'audio/webm',
        description: audioResult.description || '',
        source: audioResult.source || 'unknown',
    };

    setCache(videoId, result);
    console.log(`[EXTRACT] ✅ "${result.title}" via ${result.source}`);
    return result;
}

// ─── Proxy audio stream ─────────────────────────────────
function proxyStream(targetUrl, req, res) {
    try {
        const parsed = new URL(targetUrl);
        const proto = parsed.protocol === 'https:' ? https : http;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };

        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const proxyReq = proto.get(targetUrl, { headers, timeout: 15000 }, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                proxyStream(proxyRes.headers.location, req, res);
                return;
            }

            const responseHeaders = {
                'Access-Control-Allow-Origin': '*',
                'Accept-Ranges': 'bytes',
            };

            if (proxyRes.headers['content-type']) responseHeaders['Content-Type'] = proxyRes.headers['content-type'];
            if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];

            res.writeHead(proxyRes.statusCode, responseHeaders);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('[STREAM] Errore proxy:', err.message);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Stream non disponibile' }));
            }
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Timeout stream' }));
            }
        });

    } catch (err) {
        console.error('[STREAM] URL non valido:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'URL stream non valido' }));
    }
}

// ─── Serve file statici ─────────────────────────────────
function serveStatic(filePath, res) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File non trovato');
            return;
        }
        res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
}

// Directory base dell'app
const APP_DIR = __dirname;

// ═══════════════════════════════════════════════════════
// ═══ SERVER HTTP ═══════════════════════════════════════
// ═══════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers per tutte le risposte API
    if (pathname.startsWith('/api/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
    }

    // ─── API: Dati video ─────────────────────────────
    if (pathname.startsWith('/api/video/')) {
        const videoId = pathname.split('/api/video/')[1];
        if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ID video non valido' }));
            return;
        }

        try {
            const videoData = await extractVideoInfo(videoId);

            // Proxy l'audio per evitare problemi CORS
            const proxiedAudioUrl = videoData.audioUrl
                ? `/api/stream?url=${encodeURIComponent(videoData.audioUrl)}`
                : null;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                data: {
                    ...videoData,
                    audioUrl: proxiedAudioUrl,
                    originalAudioUrl: videoData.audioUrl,
                }
            }));
        } catch (err) {
            console.error(`[API] Errore video ${videoId}:`, err.message);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }

    // ─── API: Proxy audio stream ─────────────────────
    if (pathname === '/api/stream') {
        const targetUrl = parsedUrl.query.url;
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'URL mancante' }));
            return;
        }
        proxyStream(targetUrl, req, res);
        return;
    }

    // ─── API: Stato server ───────────────────────────
    if (pathname === '/api/status') {
        const hasCookies = fs.existsSync(path.join(__dirname, 'cookies.txt'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            backends: ['cobalt', 'yt-dlp'],
            cookies: hasCookies,
            cacheSize: cache.size,
            uptime: Math.floor(process.uptime())
        }));
        return;
    }

    // ─── API: Ricerca video (yt-dlp) ─────────────────
    if (pathname === '/api/search') {
        const query = parsedUrl.query.q;
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Query mancante' }));
            return;
        }

        try {
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            const results = await new Promise((resolve, reject) => {
                execFile(pythonCmd, [
                    '-m', 'yt_dlp',
                    `ytsearch5:${query}`,
                    '--flat-playlist',
                    '-j',
                    '--no-download',
                    '--no-warnings',
                ], { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
                    if (error) { reject(error); return; }
                    const items = stdout.trim().split('\n').map(line => {
                        try { return JSON.parse(line); } catch { return null; }
                    }).filter(Boolean);
                    resolve(items.map(item => ({
                        videoId: item.id,
                        title: item.title,
                        author: item.uploader || item.channel || '',
                        thumbnailUrl: item.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`,
                        lengthSeconds: item.duration || 0,
                    })));
                });
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, results }));
        } catch (err) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Ricerca fallita' }));
        }
        return;
    }

    // ─── File statici ────────────────────────────────
    let filePath = path.join(APP_DIR, pathname === '/' ? 'index.html' : pathname);
    filePath = path.normalize(filePath);

    if (!filePath.startsWith(APP_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Accesso negato');
        return;
    }

    serveStatic(filePath, res);
});

server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║   🎵 YouTube Audio Player - Server v3.0            ║');
    console.log(`║   🌐 http://localhost:${PORT}                          ║`);
    console.log('║   🔧 Backend: cobalt.tools + yt-dlp (fallback)     ║');
    console.log('║   ✅ Funziona sia in locale che nel cloud!          ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('');

    // Self-ping per evitare il timeout di Render (free tier)
    if (process.env.RENDER && process.env.RENDER_EXTERNAL_HOSTNAME) {
        const pingUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/status`;
        setInterval(() => {
            https.get(pingUrl, (res) => {
                console.log(`[KEEP-ALIVE] Ping → ${res.statusCode}`);
            }).on('error', (err) => {
                console.log(`[KEEP-ALIVE] Ping fallito:`, err.message);
            });
        }, 14 * 60 * 1000); // Ogni 14 minuti
        console.log('[KEEP-ALIVE] Self-ping attivo (ogni 14 min)');
    }
});

