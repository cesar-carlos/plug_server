# Node version matches .nvmrc. scripts/check_ci_image_pins.py rejects a different pin.
FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
ENV DATABASE_URL="postgresql://postgres:postgres@postgres:5432/plug_server?schema=public"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Packages the hub process. Persona-v2 publication stays blocked by
# `npm run persona:release-check` and contracts/persona-v2-release.json.
RUN npx prisma generate && npm run build

FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
# Generate only. The URL is not persisted, so a container without .env cannot
# reach the Compose Postgres by accident.
RUN DATABASE_URL="postgresql://postgres:postgres@postgres:5432/plug_server?schema=public" \
    sh -c "npm ci --omit=dev --ignore-scripts && npx prisma generate"
COPY --from=build /app/dist ./dist
COPY assets ./assets
EXPOSE 4000
CMD ["node", "dist/server.js"]
