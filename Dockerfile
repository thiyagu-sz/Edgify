# Multi-stage build producing a Next.js standalone image (docs/07-deployment.md).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build-only placeholders. `next build` evaluates modules that read the environment (env.ts,
# Better Auth), so these must be present and valid — but they are fake and never used at
# runtime, where Cloud Run injects the real secrets via Secret Manager. No DB connection is
# made during the build.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    BETTER_AUTH_SECRET="build-time-placeholder-secret-000000000" \
    BETTER_AUTH_URL="http://localhost:3000" \
    GOOGLE_CLIENT_ID="build-placeholder" \
    GOOGLE_CLIENT_SECRET="build-placeholder" \
    OPENROUTER_API_KEY="build-placeholder"

# NEXT_PUBLIC_* are INLINED INTO THE CLIENT BUNDLE AT BUILD TIME, so unlike everything above
# these cannot be supplied by Cloud Run at runtime — setting them on the service does nothing.
# They must arrive here, as build args, or the browser half is permanently unconfigured.
#
# Both default to empty, and empty means "off": lib/env.ts treats an empty string as unset, and
# both SDKs are a no-op without their key. The image therefore builds and runs correctly with no
# analytics and no browser error reporting, which is the current production state.
#
# To switch either on, pass it at build time, e.g.
#   docker build --build-arg NEXT_PUBLIC_POSTHOG_KEY=phc_xxx .
# and note that this means a REBUILD, not a config change — see docs/07.
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ARG NEXT_PUBLIC_POSTHOG_HOST="https://us.i.posthog.com"
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
# This list must cover EVERY variable lib/env.ts requires without a default, and it silently went
# stale once already: OPENROUTER_API_KEY became required in Phase 3, months after this file was
# written in Phase 1, and the image simply stopped building — "Failed to collect page data for
# /api/auth/[...all]", which names neither the variable nor the cause. Nobody noticed because the
# image had never been built. test/dockerfile-env.test.ts now reads both this file and the schema
# and fails if they diverge again.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S nodejs -g 1001 && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 8080
# Cloud Run injects PORT; bind to 0.0.0.0, not localhost, or health checks fail.
ENV PORT=8080 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
