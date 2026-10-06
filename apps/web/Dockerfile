# Read-only incident dashboard (Next.js). Build and runtime use the same digest-free Node 24 Alpine tag as the
# other Node services. Reproducible installs come from package-lock.json through `npm ci`.
FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY app ./app
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/.next ./.next
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "-p", "3000"]
