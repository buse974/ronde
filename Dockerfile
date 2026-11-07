FROM node:22-slim
WORKDIR /app
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DATABASE_PATH=/data/ronde.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
