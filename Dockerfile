# The Supervisor as one container: the service and its dashboard, the Claude Code
# executable it launches Runs with, and the git and gh those Runs need. One image
# per project — everything that differs between projects is mounted or given as
# environment, so the same image minds any of them.

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim

# git, because every ticket a Run finishes ends in a Checkpoint commit; gh,
# because a queue of GitHub issues is read and written back through it; ssh,
# because a project cloned over ssh pushes its Checkpoints that way. The apt
# lists go again afterwards rather than being carried in the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only what the service needs to run. The Claude Code executable arrives with the
# Agent SDK's own platform package, so there is nothing to install beside it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The Claude Code executable the Agent SDK ships for this platform, put on the
# path under its own name. There is no second copy to drift: the credentials a
# night runs on are arranged with the very binary that will run it.
RUN set -e; \
  cli="$(find /app/node_modules/@anthropic-ai -maxdepth 2 -name claude -type f | head -n 1)"; \
  test -n "$cli"; \
  ln -s "$cli" /usr/local/bin/claude

COPY --from=build /app/dist ./dist

COPY docker/entrypoint.sh /usr/local/bin/supervisor-entrypoint
RUN chmod +x /usr/local/bin/supervisor-entrypoint

# Where the three mounts land. The data directory and the bind address are set
# here rather than left to the config file, because they are the container's
# shape rather than the project's; everything else the file settles.
ENV NODE_ENV=production \
  SUPERVISOR_DATA_DIR=/data \
  SUPERVISOR_HOST=0.0.0.0 \
  SUPERVISOR_PORT=4317 \
  CLAUDE_CONFIG_DIR=/claude \
  HOME=/home/node

# Claude Code refuses to skip permissions for root, and a Run that stops to ask
# is a Run that never finishes — so the container is somebody else. `node` is
# uid 1000, which is whom a Linux host's own first user usually is; a host where
# it is not overrides it. Everything the container writes to is writable by
# whoever it turns out to be, because the one thing an override must not do is
# leave the Supervisor unable to open its own store. What the *mounts* are owned
# by is still the host's to get right — an empty volume is all this settles.
RUN mkdir -p /data /claude && chmod 0777 /data /claude /home/node
USER node

EXPOSE 4317

ENTRYPOINT ["/usr/local/bin/supervisor-entrypoint"]
CMD ["node", "dist/main.js"]
