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
const ytdl = require('@distube/ytdl-core');

const PORT = process.env.PORT || 3000;

// Istanze cobalt.tools pubbliche (fallback chain)
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';
const COBALT_API_URL = process.env.COBALT_API_URL || '';
const ENABLE_PUBLIC_COBALT = process.env.ENABLE_PUBLIC_COBALT === '1';
const ENABLE_YTDL_CORE_FALLBACK = process.env.ENABLE_YTDL_CORE_FALLBACK === '1';

const COBALT_INSTANCES = [
    COBALT_API_URL,
    ...(COBALT_API_KEY ? ['https://api.cobalt.tools'] : []),
    ...(ENABLE_PUBLIC_COBALT ? ['https://cobalt-api.kwiatekmiki.com'] : []),
].filter(Boolean);

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

function runCommand(cmd, args, timeout = 45000) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                const err = new Error(stderr || error.message || 'Command failed');
                err.code = error.code;
                reject(err);
                return;
            }
            resolve(stdout);
        });
    });
}

function pickBestAudioFormat(formats) {
    if (!Array.isArray(formats)) return null;

    const audioOnly = formats.filter(fmt => {
        const hasAudio = fmt.acodec && fmt.acodec !== 'none';
        const hasNoVideo = !fmt.vcodec || fmt.vcodec === 'none';
        return hasAudio && hasNoVideo && !!fmt.url;
    });

    if (audioOnly.length === 0) return null;
    audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0));
    return audioOnly[0];
}

function normalizeYtDlpPayload(data) {
    if (!data) return null;

    const bestAudioFormat = pickBestAudioFormat(data.formats);
    const audioUrl = data.url || bestAudioFormat?.url || null;
    if (!audioUrl) return null;

    const ext = data.ext || bestAudioFormat?.ext || '';
    const abr = data.abr || bestAudioFormat?.abr || 128;

    return {
        title: data.title,
        author: data.uploader || data.channel,
        channelId: data.channel_id || '',
        viewCount: data.view_count || 0,
        lengthSeconds: data.duration || 0,
        audioUrl,
        audioBitrate: abr,
        audioType: ext === 'webm' ? 'audio/webm' : 'audio/mp4',
        thumbnailUrl: data.thumbnail,
        description: (data.description || '').slice(0, 200),
        source: 'yt-dlp',
    };
}

function parseJsonLines(payload) {
    return payload
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function cleanupGeneratedPlayerScripts() {
    fs.readdir(__dirname, (err, files) => {
        if (err) return;
        for (const file of files) {
            if (/^\d+-player-script\.js$/.test(file)) {
                fs.unlink(path.join(__dirname, file), () => { });
            }
        }
    });
}

function validateAudioUrl(targetUrl, redirectDepth = 0) {
    return new Promise((resolve) => {
        try {
            if (redirectDepth > 4) {
                resolve(false);
                return;
            }

            const parsed = new URL(targetUrl);
            const proto = parsed.protocol === 'https:' ? https : http;

            const req = proto.request(targetUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Range': 'bytes=0-1',
                },
                timeout: 12000,
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    const nextUrl = new URL(res.headers.location, targetUrl).toString();
                    validateAudioUrl(nextUrl, redirectDepth + 1).then(resolve);
                    return;
                }

                const ok = res.statusCode === 200 || res.statusCode === 206;
                res.resume();
                resolve(ok);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.on('error', () => resolve(false));
            req.end();
        } catch {
            resolve(false);
        }
    });
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
                    ...(COBALT_API_KEY ? { 'Authorization': COBALT_API_KEY.startsWith('Bearer ') ? COBALT_API_KEY : `Bearer ${COBALT_API_KEY}` } : {}),
                },
                body: JSON.stringify({
                    url: ytUrl,
                    downloadMode: 'audio',
                    audioFormat: 'best',
                    audioBitrate: '128',
                }),
                timeout: 7000,
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
async function extractWithYtDlp(videoId) {
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    const cookieArgs = fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : [];

    const commonArgs = [
        ...cookieArgs,
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--geo-bypass',
        '--no-check-certificates',
        '-f', 'bestaudio',
        '--',
        ytUrl
    ];

    const attempts = [
        { cmd: 'yt-dlp', args: commonArgs, label: 'yt-dlp' },
        { cmd: 'python3', args: ['-m', 'yt_dlp', ...commonArgs], label: 'python3 -m yt_dlp' },
        { cmd: 'python', args: ['-m', 'yt_dlp', ...commonArgs], label: 'python -m yt_dlp' },
    ];

    for (const attempt of attempts) {
        try {
            console.log(`[YT-DLP] Tentativo ${attempt.label}...`);
            const stdout = await runCommand(attempt.cmd, attempt.args, 45000);
            const data = JSON.parse(stdout);
            const normalized = normalizeYtDlpPayload(data);
            if (normalized?.audioUrl) {
                console.log(`[YT-DLP] OK via ${attempt.label}: "${normalized.title || videoId}"`);
                return normalized;
            }
        } catch (err) {
            const shortErr = String(err.message || err).slice(0, 220);
            console.log(`[YT-DLP] Fallito ${attempt.label}: ${shortErr}`);
        }
    }

    return null;
}

async function extractWithYtdlCore(videoId) {
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

    try {
        console.log(`[YTDL-CORE] Tentativo per ${videoId}...`);

        const info = await ytdl.getInfo(ytUrl, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                }
            }
        });

        const audioFormats = ytdl
            .filterFormats(info.formats, 'audioonly')
            .filter(fmt => !!fmt.url);

        if (audioFormats.length === 0) {
            console.log('[YTDL-CORE] Nessun formato audio trovato');
            return null;
        }

        audioFormats.sort((a, b) => (b.audioBitrate || b.bitrate || 0) - (a.audioBitrate || a.bitrate || 0));
        const best = audioFormats[0];

        const videoDetails = info.videoDetails || {};
        const thumbnailUrl = (videoDetails.thumbnails && videoDetails.thumbnails.length > 0)
            ? videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url
            : null;

        return {
            title: videoDetails.title,
            author: videoDetails.author?.name || videoDetails.ownerChannelName || '',
            channelId: videoDetails.channelId || '',
            viewCount: Number(videoDetails.viewCount || 0),
            lengthSeconds: Number(videoDetails.lengthSeconds || 0),
            audioUrl: best.url,
            audioBitrate: best.audioBitrate || 128,
            audioType: best.mimeType?.includes('webm') ? 'audio/webm' : 'audio/mp4',
            thumbnailUrl,
            description: (videoDetails.shortDescription || '').slice(0, 200),
            source: 'ytdl-core',
        };
    } catch (err) {
        const shortErr = String(err.message || err).slice(0, 260);
        console.log(`[YTDL-CORE] Errore: ${shortErr}`);
        return null;
    } finally {
        cleanupGeneratedPlayerScripts();
    }
}

// ─── Estrazione principale (fallback chain) ─────────────
async function extractVideoInfo(videoId) {
    const cached = getCached(videoId);
    if (cached) {
        console.log(`[CACHE] Hit per ${videoId}`);
        return cached;
    }

    console.log(`[EXTRACT] Inizio estrazione per ${videoId}...`);

    const meta = await getVideoMetadata(videoId);
    let audioResult = null;
    const ytdlpResult = await extractWithYtDlp(videoId);
    if (ytdlpResult?.audioUrl) {
        const valid = await validateAudioUrl(ytdlpResult.audioUrl);
        if (valid) {
            audioResult = ytdlpResult;
            meta.title = ytdlpResult.title || meta.title;
            meta.author = ytdlpResult.author || meta.author;
            meta.thumbnailUrl = ytdlpResult.thumbnailUrl || meta.thumbnailUrl;
        } else {
            console.log('[EXTRACT] URL yt-dlp non valida, provo fallback...');
        }
    }

    // 2) Optional fallback: cobalt (only if configured)
    if (!audioResult && COBALT_INSTANCES.length > 0) {
        const cobaltResult = await extractWithCobalt(videoId);
        if (cobaltResult?.audioUrl) {
            const valid = await validateAudioUrl(cobaltResult.audioUrl);
            if (valid) {
                audioResult = cobaltResult;
            } else {
                console.log('[EXTRACT] URL cobalt non valida, continuo fallback...');
            }
        }
    }

    // 3) Last-resort fallback (disabled by default): ytdl-core
    if (!audioResult && ENABLE_YTDL_CORE_FALLBACK) {
        const ytdlCoreResult = await extractWithYtdlCore(videoId);
        if (ytdlCoreResult?.audioUrl) {
            const valid = await validateAudioUrl(ytdlCoreResult.audioUrl);
            if (valid) {
                audioResult = ytdlCoreResult;
                meta.title = ytdlCoreResult.title || meta.title;
                meta.author = ytdlCoreResult.author || meta.author;
                meta.thumbnailUrl = ytdlCoreResult.thumbnailUrl || meta.thumbnailUrl;
            } else {
                console.log('[EXTRACT] URL ytdl-core non valida.');
            }
        }
    }

    if (!audioResult || !audioResult.audioUrl) {
        throw new Error('Impossibile estrarre l\'audio. Verifica che il deploy usi Docker con yt-dlp disponibile.');
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
    console.log(`[EXTRACT] OK "${result.title}" via ${result.source}`);
    return result;
}

// ─── Proxy audio stream ─────────────────────────────────
function proxyStream(targetUrl, req, res) {
    try {
        const parsed = new URL(targetUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('Protocollo non supportato');
        }
        const proto = parsed.protocol === 'https:' ? https : http;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
        };

        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const proxyReq = proto.get(targetUrl, { headers, timeout: 30000 }, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
                proxyStream(redirectUrl, req, res);
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
        const backends = ['yt-dlp'];
        if (COBALT_INSTANCES.length > 0) backends.push('cobalt');
        if (ENABLE_YTDL_CORE_FALLBACK) backends.push('ytdl-core');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            backends,
            cobaltConfigured: COBALT_INSTANCES.length > 0,
            ytdlCoreFallback: ENABLE_YTDL_CORE_FALLBACK,
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
            const searchArgs = [
                `ytsearch5:${query}`,
                '--flat-playlist',
                '-j',
                '--no-download',
                '--no-warnings',
            ];

            const attempts = [
                { cmd: 'yt-dlp', args: searchArgs, label: 'yt-dlp' },
                { cmd: 'python3', args: ['-m', 'yt_dlp', ...searchArgs], label: 'python3 -m yt_dlp' },
                { cmd: 'python', args: ['-m', 'yt_dlp', ...searchArgs], label: 'python -m yt_dlp' },
            ];

            let items = [];
            for (const attempt of attempts) {
                try {
                    const stdout = await runCommand(attempt.cmd, attempt.args, 30000);
                    items = parseJsonLines(stdout);
                    if (items.length > 0) {
                        break;
                    }
                } catch (err) {
                    const shortErr = String(err.message || err).slice(0, 160);
                    console.log(`[SEARCH] ${attempt.label} fallito: ${shortErr}`);
                }
            }

            const results = items.map(item => ({
                videoId: item.id,
                title: item.title,
                author: item.uploader || item.channel || '',
                thumbnailUrl: item.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${item.id}/mqdefault.jpg`,
                lengthSeconds: item.duration || 0,
            }));

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
    console.log('[BOOT] Backends: yt-dlp primary, optional cobalt/ytdl-core');
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

