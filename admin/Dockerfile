FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build -- --configuration production

FROM nginx:1.28-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist/admin/browser /usr/share/nginx/html

# /version.json names the commit this frontend was built from.
ARG GIT_SHA=unknown
RUN printf '{"commit":"%s"}\n' "$GIT_SHA" > /usr/share/nginx/html/version.json

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
