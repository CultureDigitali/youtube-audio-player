FROM node:20-slim

# Installa Python e pip per yt-dlp + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Installa yt-dlp
RUN python3 -m pip install --break-system-packages yt-dlp

# Crea directory app
WORKDIR /app

# Installa dipendenze Node
COPY package*.json ./
RUN npm ci --omit=dev

# Copia tutti i file applicativi
COPY . .

# Esponi la porta (Render/Cloud Run usa PORT env var)
EXPOSE 3000

# Avvia il server
CMD ["node", "server.js"]
