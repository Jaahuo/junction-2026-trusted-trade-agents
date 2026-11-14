FROM node:24.22.2@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40 AS node

FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
WORKDIR /app
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build

FROM oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 AS runtime
RUN apk add --no-cache --upgrade musl=1.2.6-r3 musl-utils=1.2.6-r3 zlib=1.4-r0
WORKDIR /app
ENV NODE_ENV=production APP_ROOT=/app WEB_DIST=apps/web/dist
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock ./
COPY --from=build --chown=bun:bun /app/apps ./apps
COPY --from=build --chown=bun:bun /app/contexts ./contexts
COPY --from=build --chown=bun:bun /app/packages ./packages
COPY --from=build --chown=bun:bun /app/skills ./skills
RUN bun install --frozen-lockfile --production --omit peer --ignore-scripts
USER bun
CMD ["bun", "apps/api/src/main.ts"]
