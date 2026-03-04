#!/bin/bash
set -e

echo "============================================"
echo "[WARP] Inizializzazione Cloudflare WARP..."
echo "============================================"

# ─── Avvia dbus (necessario per warp-svc) ────────────
mkdir -p /run/dbus
if [ ! -e /run/dbus/system_bus_socket ]; then
    dbus-daemon --system --nofork &
    DBUS_PID=$!
    sleep 2
    echo "[WARP] dbus-daemon avviato (PID: $DBUS_PID)"
else
    echo "[WARP] dbus gia attivo"
fi

# ─── Avvia WARP daemon ──────────────────────────────
warp-svc &
WARP_PID=$!
echo "[WARP] warp-svc avviato (PID: $WARP_PID)"

# Attendi che il socket IPC sia pronto (max 10 sec)
TRIES=0
while [ ! -e /run/cloudflare-warp/warp_service ] && [ $TRIES -lt 10 ]; do
    sleep 1
    TRIES=$((TRIES + 1))
    echo "[WARP] Attendo socket IPC... ($TRIES/10)"
done

if [ ! -e /run/cloudflare-warp/warp_service ]; then
    echo "[WARP] ERRORE: socket IPC non trovato dopo 10s, avvio Node senza WARP"
    exec node server.js
fi

# ─── Registra WARP (free, nessun account) ────────────
echo "[WARP] Registrazione..."
if timeout 15 warp-cli --accept-tos registration new 2>&1; then
    echo "[WARP] Registrazione OK"
else
    echo "[WARP] Registrazione fallita o gia presente, continuo..."
fi

# ─── Configura proxy mode (SOCKS5 su porta 40000) ───
echo "[WARP] Configurazione proxy mode..."
timeout 5 warp-cli --accept-tos mode proxy 2>&1 || echo "[WARP] mode proxy fallito"
timeout 5 warp-cli --accept-tos proxy port 40000 2>&1 || echo "[WARP] set port fallito"

# ─── Connetti ────────────────────────────────────────
echo "[WARP] Connessione..."
timeout 15 warp-cli --accept-tos connect 2>&1 || echo "[WARP] connect fallito"

# Attendi stabilizzazione connessione
sleep 3

# ─── Verifica stato ─────────────────────────────────
WARP_STATUS=$(timeout 5 warp-cli status 2>&1 || echo "status check failed")
echo "[WARP] Stato: $WARP_STATUS"

# ─── Test proxy ─────────────────────────────────────
echo "[WARP] Test proxy SOCKS5 su 127.0.0.1:40000..."
WARP_IP=$(timeout 10 curl -s --socks5-hostname 127.0.0.1:40000 https://ifconfig.me 2>/dev/null || echo "test fallito")
echo "[WARP] IP via WARP: $WARP_IP"

if [ "$WARP_IP" != "test fallito" ] && [ -n "$WARP_IP" ]; then
    export WARP_SOCKS_PROXY="socks5://127.0.0.1:40000"
    echo "[WARP] ✅ Proxy SOCKS5 attivo! Traffico yt-dlp uscira da IP: $WARP_IP"
else
    echo "[WARP] ⚠️ Proxy non funzionante, Node partira senza WARP"
fi

echo "============================================"
echo "[WARP] Avvio server Node.js..."
echo "============================================"

# Avvia il server Node.js
exec node server.js
