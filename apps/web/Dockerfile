FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/compiler-adk/package.json packages/compiler-adk/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/workflow-ir/package.json packages/workflow-ir/package.json
COPY packages/node-registry/package.json packages/node-registry/package.json
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @robflow/shared \
  && npm run build -w @robflow/workflow-ir \
  && npm run build -w @robflow/node-registry \
  && npm run build -w @robflow/persistence \
  && npm run build -w @robflow/compiler-adk \
  && npm run build -w @robflow/web

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
