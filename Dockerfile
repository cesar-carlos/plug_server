# Node version matches .nvmrc. scripts/check_ci_image_pins.py rejects a different pin.
FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS build
WORKDIR /app
ENV DATABASE_URL="postgresql://postgres:postgres@postgres:5432/plug_server?schema=public"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node scripts/check-persona-release.mjs && npx prisma generate && npm run build

FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV DATABASE_URL="postgresql://postgres:postgres@postgres:5432/plug_server?schema=public"
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts && npx prisma generate
COPY --from=build /app/dist ./dist
COPY assets ./assets
EXPOSE 3000
CMD ["node", "dist/server.js"]
