# claude-mem server image for Railway: one image, two services.
#
#   CLAUDE_MEM_CONTAINER_MODE=server  HTTP /v1 + MCP + search (no generation)
#   CLAUDE_MEM_CONTAINER_MODE=worker  BullMQ generation worker
#
# Unlike docker/claude-mem/Dockerfile, this one builds the plugin bundles from
# source in its first stage, so Railway can build straight from the repository
# without a host-side `npm run build`.
#
# Generation runs through a Claude subscription
# (CLAUDE_MEM_SERVER_PROVIDER=claude-subscription + CLAUDE_CODE_OAUTH_TOKEN),
# which needs the Claude Code CLI in the image. The server service never
# launches it.

# ---------- build: plugin bundles from source ----------
FROM node:22-trixie AS build

ARG BUN_VERSION=1.3.12
ENV BUN_INSTALL="/usr/local/bun"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/usr/local/bun/bin:${PATH}"

WORKDIR /src
COPY . .
# Bundling needs no native add-ons, and some grammar postinstalls need a newer
# glibc than bookworm ships; the runtime stage installs its own dependencies.
RUN npm install --no-audit --no-fund --ignore-scripts \
 && npm run build

# ---------- runtime ----------
# The full image (not -slim): plugin dependencies such as the tree-sitter
# grammars compile from source where no prebuilt binary exists (arm64), which
# needs python3 and a C++ toolchain. Image size does not affect runtime RAM.
FROM node:22-trixie

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip procps \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.12
ENV BUN_INSTALL="/usr/local/bun"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && chmod -R a+rX /usr/local/bun
ENV PATH="/usr/local/bun/bin:/usr/local/share/npm-global/bin:${PATH}"

# Claude Code CLI for subscription generation (worker only).
RUN mkdir -p /usr/local/share/npm-global && chown -R node:node /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ARG CLAUDE_CODE_VERSION=latest
USER node
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} --no-audit --no-fund \
 && npm cache clean --force

USER root
RUN mkdir -p /opt/claude-mem && chown node:node /opt/claude-mem

USER node
# Dependencies first, from the manifest alone, so a code change reuses this
# (slow, natively compiled) layer. onnxruntime-node would add a ~370 MB CUDA
# provider on linux/x64; the embedder runs on the CPU.
COPY --from=build --chown=node:node /src/plugin/package.json /opt/claude-mem/package.json
RUN cd /opt/claude-mem \
 && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install --omit=dev --legacy-peer-deps --no-audit --no-fund \
 && npm cache clean --force

# Then the freshly built bundles, without the build stage's own node_modules.
USER root
COPY --from=build /src/plugin/ /tmp/plugin/
RUN rm -rf /tmp/plugin/node_modules /tmp/plugin/package.json \
 && cp -a /tmp/plugin/. /opt/claude-mem/ \
 && rm -rf /tmp/plugin \
 && chown -R node:node /opt/claude-mem
USER node

# Bake the default embedding model so a fresh container searches by meaning
# without a first-use download.
ARG EMBEDDING_REPO=Xenova/all-MiniLM-L6-v2
RUN cd /opt/claude-mem \
 && node -e "import('@huggingface/transformers').then(t => t.pipeline('feature-extraction', process.argv[1], { dtype: 'fp32' }))" "$EMBEDDING_REPO"

USER root
RUN mkdir -p /home/node/.claude /home/node/.claude-mem /data/claude-mem \
 && chown -R node:node /home/node/.claude /home/node/.claude-mem /data/claude-mem
COPY --chown=node:node docker/claude-mem/entrypoint.sh /usr/local/bin/claude-mem-entrypoint
RUN chmod +x /usr/local/bin/claude-mem-entrypoint

USER node
WORKDIR /home/node

ENV CLAUDE_MEM_CONTAINER_MODE=server \
    CLAUDE_MEM_RUNTIME=server \
    CLAUDE_MEM_DATA_DIR=/data/claude-mem \
    CLAUDE_MEM_SERVER_CLAUDE_PATH=/usr/local/share/npm-global/bin/claude

ENTRYPOINT ["/usr/local/bin/claude-mem-entrypoint"]
CMD []
