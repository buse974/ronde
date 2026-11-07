# --- Dépendances (modules natifs compilés ici : better-sqlite3, argon2) ---
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Image finale ---
FROM node:22-slim

# CLI Claude Code, exécuté par l'utilisateur dédié « runner ».
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

# Utilisateur sans privilège pour les runs : pas d'accès à /data (base, secret).
RUN groupadd --gid 1001 runner \
 && useradd --uid 1001 --gid 1001 --create-home --home-dir /home/runner --shell /usr/sbin/nologin runner \
 && mkdir -p /home/runner/work && chown -R runner:runner /home/runner \
 # 711 : root (sans capacités) doit pouvoir y faire chdir avant de passer sous runner.
 && chmod 711 /home/runner /home/runner/work

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Europe/Paris \
    RUNNER_UID=1001 \
    RUNNER_GID=1001 \
    RUNNER_HOME=/home/runner \
    RUNNER_CWD=/home/runner/work

RUN mkdir -p /data /host-metrics && chmod 700 /data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Le process app reste root dans le conteneur, uniquement pour lancer claude
# sous l'uid runner. docker-compose.yml retire toutes les autres capacités.
CMD ["node", "server/index.js"]
