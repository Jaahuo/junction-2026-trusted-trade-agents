FROM mirror.gcr.io/library/node:24.22.2@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40 AS node

FROM mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS source
WORKDIR /app
COPY . .

FROM source AS production-dependencies
RUN bun install --frozen-lockfile --production --omit peer --ignore-scripts

FROM source AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build

FROM mirror.gcr.io/oven/bun:1.4.3-distroless@sha256:1aaa515018b0b37d95dbdebd55d1b7f37ad258a6289ba63e4bc3b9c9e3038697 AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ROOT=/app WEB_DIST=apps/web/dist
COPY --from=production-dependencies --chown=1000:1000 /app/package.json /app/bun.lock ./
COPY --from=production-dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=1000:1000 /app/apps ./apps
COPY --from=production-dependencies --chown=1000:1000 /app/contexts ./contexts
COPY --from=production-dependencies --chown=1000:1000 /app/packages ./packages
COPY --from=source --chown=1000:1000 /app/skills ./skills
COPY --from=build --chown=1000:1000 /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=1000:1000 /app/contexts/views/dist ./contexts/views/dist
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["apps/api/src/main.ts"]
