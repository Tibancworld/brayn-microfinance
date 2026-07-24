FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p data/backups \
  && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000

USER node
EXPOSE 3000

CMD ["node", "server.js"]
