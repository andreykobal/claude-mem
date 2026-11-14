# claude-mem server image for Railway (see docker/railway/README.md).
#
# One container serves HTTP /v1 + MCP + search and, unless
# CLAUDE_MEM_GENERATION_DISABLED is set, runs observation generation in the
# same process (CLAUDE_MEM_CONTAINER_MODE=worker still runs a split worker).
#
# Unlike docker/claude-mem/Dockerfile, this one builds the plugin bundles from
# source in its first stage, so no host-side `npm run build` is needed.
#
# Generation runs through a Claude subscription
# (CLAUDE_MEM_SERVER_PROVIDER=claude-subscription + CLAUDE_CODE_OAUTH_TOKEN),
# which needs the Claude Code CLI in the image.

# ---------- build: plugin bundles from source ----------
FROM node:22-trixie AS build

ARG BUN_VERSION=1.3.12
ENV BUN_INSTALL="/usr/local/bun"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/usr/local/bun/bin:${PATH}"

# Source: the build context, or, when CLAUDE_MEM_SOURCE_REF is set, that exact
# commit of the repository. `railway up` leaves hidden files (the plugin
# manifests, .mcp.json) out of its upload, so Railway builds pass the deployed
# commit and clone it instead; local builds keep using the working tree.
ARG CLAUDE_MEM_SOURCE_REPO=https://github.com/andreykobal/claude-mem.git
ARG CLAUDE_MEM_SOURCE_REF=
COPY . /context
RUN if [ -n "$CLAUDE_MEM_SOURCE_REF" ]; then \
      git clone --filter=blob:none --no-checkout "$CLAUDE_MEM_SOURCE_REPO" /src \
      && git -C /src checkout --quiet "$CLAUDE_MEM_SOURCE_REF"; \
    else \
      cp -a /context/. /src/; \
    fi \
 && rm -rf /context
WORKDIR /src
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
COPY --from=build --chown=node:node /src/docker/claude-mem/entrypoint.sh /usr/local/bin/claude-mem-entrypoint
RUN chmod +x /usr/local/bin/claude-mem-entrypoint

USER node
WORKDIR /home/node

ENV CLAUDE_MEM_CONTAINER_MODE=server \
    CLAUDE_MEM_RUNTIME=server \
    CLAUDE_MEM_DATA_DIR=/data/claude-mem \
    CLAUDE_MEM_SERVER_CLAUDE_PATH=/usr/local/share/npm-global/bin/claude

ENTRYPOINT ["/usr/local/bin/claude-mem-entrypoint"]
CMD []
