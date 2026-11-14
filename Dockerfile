FROM node:24.22.2 AS node

FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build

FROM oven/bun:1.4.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ROOT=/app WEB_DIST=apps/web/dist
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock ./
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/apps ./apps
COPY --from=build --chown=bun:bun /app/contexts ./contexts
COPY --from=build --chown=bun:bun /app/packages ./packages
COPY --from=build --chown=bun:bun /app/skills ./skills
USER bun
CMD ["bun", "apps/api/src/main.ts"]
