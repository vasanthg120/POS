FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Reported by GET /api/health so the live build can be identified.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

RUN mkdir -p /app/logs && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "app.js"]
