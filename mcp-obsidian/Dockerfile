FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache git util-linux ripgrep openssh-client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Pre-seed known_hosts and configure git for sync worker
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
    ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null && \
    chmod 644 /root/.ssh/known_hosts

# Inline entrypoint sets git identity from env and ensures safe.directory
COPY <<'EOF' /usr/local/bin/entry.sh
#!/bin/sh
set -e
git config --global user.name "${GIT_AUTHOR_NAME:-mcp-obsidian}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-mcp@fama.local}"
git config --global --add safe.directory "${VAULT_PATH:-/vault}"
if [ -f /root/.ssh/id_ed25519 ]; then chmod 600 /root/.ssh/id_ed25519 2>/dev/null || true; fi
exec "$@"
EOF
RUN chmod +x /usr/local/bin/entry.sh

EXPOSE 3201
ENTRYPOINT ["/usr/local/bin/entry.sh"]
CMD ["node", "dist/index.js"]
