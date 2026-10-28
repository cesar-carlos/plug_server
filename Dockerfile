# Node version matches .nvmrc. scripts/check_ci_image_pins.py rejects a different pin.
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /app
ENV DATABASE_URL="postgresql://postgres:postgres@postgres:5432/plug_server?schema=public"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Packages the hub process. Persona-v2 publication stays blocked by
# `npm run persona:release-check` and contracts/persona-v2-release.json.
RUN npx prisma generate && npm run build

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS runtime
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
