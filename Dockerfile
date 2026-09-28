# dino.forever live server. Node runs the TypeScript sources directly
# (type stripping); esbuild only bundles the vendored game for the engine
# and the static site, which the server also serves.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN node build.mjs

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data PUBLIC_DIR=/app/public BOOTSTRAP_DIR=/app/web/data
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server
COPY --from=build /app/trainer/episodes.ts ./trainer/episodes.ts
COPY --from=build /app/web/data ./web/data
EXPOSE 8080
CMD ["node", "server/main.ts"]
