# Build context: repository root (see compose.yaml).
FROM node:24-alpine AS build
RUN npm install -g pnpm@12.3.4
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm --filter "@otkryvay/miniapp..." build

FROM nginx:1-alpine
COPY apps/miniapp/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/miniapp/dist /usr/share/nginx/html
EXPOSE 80
