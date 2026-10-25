# The Cinemesh blind relay. Build from this folder: see README.md (Docker).
FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bin.js ./
COPY src ./src

# /data keeps the seed (the relay's key) across restarts and upgrades: mount a volume there.
RUN mkdir /data && chown node:node /data
ENV STATE_DIRECTORY=/data
VOLUME /data

USER node
EXPOSE 49737/udp
ENTRYPOINT ["node", "bin.js"]
CMD ["--port", "49737"]
