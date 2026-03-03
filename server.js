/**
 * YouTube Audio Player - Server Proxy con yt-dlp
 * Usa yt-dlp per estrarre i dati audio da YouTube (100% affidabile).
 * Serve anche i file statici della web app.
 */

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

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

// Cache in memoria per evitare richieste ripetute (TTL 30 min)
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// Percorso cookies per yt-dlp (bypassa blocco IP datacenter)
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.time < CACHE_TTL) {
        console.log(`[CACHE] Hit per ${key}`);
        return entry.data;
    }
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, time: Date.now() });
}

/**
 * Costruisce gli argomenti base di yt-dlp (con supporto cookies)
 */
function getYtDlpBaseArgs() {
    const args = [
        '-m', 'yt_dlp',
        '--no-warnings',
        '--no-check-certificates',
        '--geo-bypass',
    ];

    // Se esiste il file cookies.txt, usalo
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
        console.log('[YT-DLP] Usando cookies.txt per autenticazione');
    }

    return args;
}

/**
 * Estrae le info del video usando yt-dlp
 * Tenta prima con il client web, poi con client alternativi se fallisce
 */
function extractVideoInfo(videoId) {
    return new Promise((resolve, reject) => {
        const cached = getCached(videoId);
        if (cached) { resolve(cached); return; }

        const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

        const baseArgs = getYtDlpBaseArgs();
        const args = [
            ...baseArgs,
            '-j',                    // Output JSON
            '--no-download',         // Non scaricare il video
            '-f', 'bestaudio',       // Solo il miglior audio
            ytUrl
        ];

        console.log(`[YT-DLP] Estrazione: ${videoId}...`);

        const proc = execFile('python3', args, {
            timeout: 60000,
            maxBuffer: 1024 * 1024 * 5
        }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[YT-DLP] Errore:`, error.message);
                if (stderr) console.error(`[YT-DLP] Stderr:`, stderr.slice(0, 500));

                // Suggerisci l'uso di cookies se non sono configurati
                const hint = fs.existsSync(COOKIES_PATH)
                    ? 'I cookies potrebbero essere scaduti. Ricaricali da /api/upload-cookies.'
                    : 'Prova a caricare i cookies YouTube su /api/upload-cookies per sbloccare.';

                reject(new Error(`Impossibile estrarre i dati del video. ${hint}`));
                return;
            }

            try {
                const data = JSON.parse(stdout);

                const result = {
                    title: data.title || 'Titolo non disponibile',
                    author: data.uploader || data.channel || 'Canale sconosciuto',
                    channelId: data.channel_id || '',
                    viewCount: data.view_count || 0,
                    lengthSeconds: data.duration || 0,
                    videoId: videoId,
                    thumbnailUrl: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                    audioUrl: data.url || null,
                    audioBitrate: data.abr || 128,
                    audioType: data.ext === 'webm' ? 'audio/webm' : 'audio/mp4',
                    description: (data.description || '').slice(0, 200),
                };

                setCache(videoId, result);
                console.log(`[YT-DLP] OK: "${result.title}" (${result.lengthSeconds}s, ${result.audioBitrate}kbps)`);
                resolve(result);
            } catch (e) {
                console.error(`[YT-DLP] JSON parse error:`, e.message);
                reject(new Error('Errore nel parsing dei dati del video.'));
            }
        });
    });
}

/**
 * Proxy lo stream audio dal server YouTube originale
 */
function proxyStream(targetUrl, req, res) {
    try {
        const parsed = new URL(targetUrl);
        const proto = parsed.protocol === 'https:' ? https : http;

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };

        // Supporto Range requests per seeking
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const proxyReq = proto.get(targetUrl, { headers, timeout: 15000 }, (proxyRes) => {
            // Segui redirect
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

/**
 * Serve un file statico
 */
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
            'Cache-Control': 'no-cache'  // No cache durante lo sviluppo
        });
        res.end(data);
    });
}

// Directory base dell'app
const APP_DIR = __dirname;

// === Crea il server HTTP ===
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

    // === API: Dati video (usa yt-dlp) ===
    if (pathname.startsWith('/api/video/')) {
        const videoId = pathname.split('/api/video/')[1];
        if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ID video non valido' }));
            return;
        }

        try {
            const videoData = await extractVideoInfo(videoId);

            // L'URL audio diretto di YouTube scade dopo 6h, lo proxyamo
            // in modo che il browser non abbia problemi di CORS
            const proxiedAudioUrl = videoData.audioUrl
                ? `/api/stream?url=${encodeURIComponent(videoData.audioUrl)}`
                : null;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                data: {
                    ...videoData,
                    audioUrl: proxiedAudioUrl,
                    originalAudioUrl: videoData.audioUrl, // per debug
                }
            }));
        } catch (err) {
            console.error(`[API] Errore video ${videoId}:`, err.message);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }

    // === API: Proxy audio stream ===
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

    // === API: Upload cookies (per sbloccare YouTube da datacenter) ===
    if (pathname === '/api/upload-cookies' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                if (!body || body.length < 10) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Cookies vuoti o troppo corti' }));
                    return;
                }
                fs.writeFileSync(COOKIES_PATH, body, 'utf8');
                console.log(`[COOKIES] Salvati ${body.length} bytes in cookies.txt`);
                cache.clear(); // Pulisci la cache per usare i nuovi cookies
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Cookies salvati! Riprova a riprodurre un video.' }));
            } catch (err) {
                console.error('[COOKIES] Errore salvataggio:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Errore nel salvataggio dei cookies' }));
            }
        });
        return;
    }

    // === API: Stato del server ===
    if (pathname === '/api/status') {
        const hasCookies = fs.existsSync(COOKIES_PATH);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            cookies: hasCookies,
            cacheSize: cache.size,
            uptime: Math.floor(process.uptime())
        }));
        return;
    }

    // === API: Ricerca video (usa yt-dlp) ===
    if (pathname === '/api/search') {
        const query = parsedUrl.query.q;
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Query mancante' }));
            return;
        }

        try {
            const results = await new Promise((resolve, reject) => {
                const searchArgs = [
                    ...getYtDlpBaseArgs(),
                    `ytsearch5:${query}`,
                    '--flat-playlist',
                    '-j',
                    '--no-download',
                ];
                execFile('python3', searchArgs, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
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

    // === File statici ===
    let filePath = path.join(APP_DIR, pathname === '/' ? 'index.html' : pathname);
    filePath = path.normalize(filePath);

    // Sicurezza: impedisci directory traversal
    if (!filePath.startsWith(APP_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Accesso negato');
        return;
    }

    serveStatic(filePath, res);
});

server.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║   🎵 YouTube Audio Player - Server             ║');
    console.log(`║   🌐 http://localhost:${PORT}                     ║`);
    console.log('║   🔧 Backend: yt-dlp (estrazione diretta)      ║');
    console.log('║   ✅ Niente più CORS, niente API esterne!       ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('');
    console.log('Apri http://localhost:3000 nel browser per iniziare.');
    console.log('');
});
