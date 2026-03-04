FROM node:20-slim

# Installa dipendenze sistema: Python, yt-dlp, ffmpeg, Cloudflare WARP
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Installa yt-dlp
RUN python3 -m pip install --break-system-packages yt-dlp

# Installa Cloudflare WARP CLI
RUN curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" > /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update \
    && apt-get install -y cloudflare-warp \
    && rm -rf /var/lib/apt/lists/*

# Crea directory app
WORKDIR /app

# Installa dipendenze Node
COPY package*.json ./
RUN npm ci --omit=dev

# Copia tutti i file applicativi
COPY . .

# Script di avvio
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Esponi la porta (Render usa PORT env var)
EXPOSE 3000

# Avvia con script che inizializza WARP, poi lancia Node
CMD ["/app/start.sh"]
