#!/bin/sh
# What one container has to settle before a night may start: who the Checkpoints
# are committed under, and whether git will touch the mounted project at all.
# Both belong to the container rather than to the service — the Runs commit too,
# and they read the same global config the Supervisor does.
set -e

# A commit with no identity is refused outright, and a night that dies at its
# first Checkpoint is the worst way to find that out. So there is always one,
# and an instance that would rather be somebody else says so.
git config --global user.name "${SUPERVISOR_GIT_NAME:-AI Supervisor}"
git config --global user.email "${SUPERVISOR_GIT_EMAIL:-ai-supervisor@localhost}"

# A mounted repository belongs to whoever owns it on the host, which is not who
# the container runs as, and git refuses such a repository rather than guessing.
# The container sees only what it was mounted, so there is nothing else to trust
# — and replacing rather than adding leaves one entry however often it restarts.
git config --global --replace-all safe.directory '*'

# So that a Checkpoint can be pushed over https with the token the container was
# given. Not worth refusing to start over: a queue of ticket files pushing to no
# remote at all needs none of this.
if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  gh auth setup-git ||
    echo "supervisor: the GitHub token would not set git up to push with" >&2
fi

exec "$@"
