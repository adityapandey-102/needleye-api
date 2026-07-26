# Multi-stage build: compile with tsup in a full node image, run the
# resulting bundle in a slim image with only production dependencies.
# There is exactly one deployable artifact (the Feature-Based Modular
# Monolith) -- no per-module images, matching CLAUDE.md's "keep it simple."

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# openapi.yaml is read at startup via process.cwd() (see src/docs/openapi.ts)
# -- must sit next to dist/, not inside it.
COPY openapi.yaml ./openapi.yaml

# Runs as a non-root user -- the "node" user/group already exists in the
# official image.
USER node

EXPOSE 4000
CMD ["node", "dist/index.js"]
