FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

ENV NODE_OPTIONS="--max-old-space-size=8192"
ENV MHB_GUI_HOST="0.0.0.0"
ENV MHB_STATE_DIR="/app/data"
ENV PORT="8765"

EXPOSE 8765

CMD ["node", "start-render.js"]
