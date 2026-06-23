# syntax=docker/dockerfile:1

# Use the official Node.js v22 base image
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

ENV HOME="/app"

# Install ca-certificates (the system CA bundle used for TLS), then clean
# the apt cache. Required by the LiveKit SDK: the native Rust core reads
# the system trust store at runtime, which the slim base image doesn't ship.
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*

# --- Build stage ---
FROM base AS build

WORKDIR /app

# Copy just the dependency files first, for more efficient layer caching
COPY package.json package-lock.json ./

# Install dependencies using npm ci for exact, reproducible builds
RUN npm ci

# Copy all remaining application files into the container
COPY . .

# Build the project
RUN npm run build

# Pre-download any ML models or files the agent needs (e.g. Silero VAD)
RUN npm run download-files

# Remove dev dependencies for a leaner production image
RUN npm prune --production

# --- Production stage ---
FROM base

# Create a non-privileged user that the app will run under
ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

WORKDIR /app

# Copy the built application with correct ownership
COPY --from=build --chown=appuser:appuser /app /app

USER appuser

# Set Node.js to production mode
ENV NODE_ENV=production

# Run the application
CMD [ "npm", "start" ]