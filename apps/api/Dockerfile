# Build context: repository root (see compose.yaml).
FROM node:24-alpine AS build
RUN npm install -g pnpm@12.3.4
WORKDIR /repo

# Download dependencies from the lockfile only, so this layer is reused
# until pnpm-lock.yaml changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm --filter "@otkryvay/api..." build \
 && pnpm --filter @otkryvay/api deploy --prod --prefer-offline /out

# All tests of the monorepo (core, API with the throwaway db-test, mini-app):
# docker compose --profile test run --rm --build tests
FROM build AS test
CMD ["pnpm", "test"]

FROM node:24-alpine
ENV NODE_ENV=production
# platform-api2.max.ru is signed by the Russian Trusted Root CA (Mintsifry),
# which is not in Node's default trust store.
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem
WORKDIR /app
COPY --from=build /out ./
COPY certs/russian_trusted_root_ca.pem ./certs/
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
