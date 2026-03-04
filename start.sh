#!/bin/bash
set -e

echo "[WARP] Inizializzazione Cloudflare WARP..."

# Avvia il servizio WARP daemon in background
# warp-svc necessita di dbus, lo avviamo senza systemd
mkdir -p /var/run/dbus
dbus-daemon --system --nofork &
sleep 1

# Avvia il servizio WARP
warp-svc &
sleep 3

# Registra WARP (modalita free, nessun account necessario)
echo "[WARP] Registrazione..."
warp-cli --accept-tos registration new || echo "[WARP] Gia registrato"

# Imposta WARP in modalita proxy (SOCKS5 su 127.0.0.1:40000)
echo "[WARP] Configurazione proxy mode (SOCKS5 :40000)..."
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000

# Connetti WARP
echo "[WARP] Connessione..."
warp-cli --accept-tos connect

# Attendi che la connessione sia stabile
sleep 3

# Verifica stato
WARP_STATUS=$(warp-cli status 2>&1 || echo "unknown")
echo "[WARP] Stato: $WARP_STATUS"

# Testa il proxy
echo "[WARP] Test proxy SOCKS5..."
IP_VIA_WARP=$(curl -s --socks5 127.0.0.1:40000 https://ifconfig.me 2>/dev/null || echo "test fallito")
echo "[WARP] IP via WARP: $IP_VIA_WARP"

# Esporta env per Node.js
export WARP_SOCKS_PROXY="socks5://127.0.0.1:40000"

echo "[WARP] Pronto! Proxy SOCKS5 su 127.0.0.1:40000"
echo "[WARP] Avvio server Node.js..."

# Avvia il server Node.js
exec node server.js
