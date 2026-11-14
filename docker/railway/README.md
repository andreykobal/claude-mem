# claude-mem on Railway

A remote memory store for several machines: one `claude-mem` service runs the
server runtime (HTTP `/v1`, MCP, search) and observation generation in the same
process, next to Postgres and Valkey. Generation runs through a Claude
subscription (`claude-subscription` provider), not an API key.

Railway no longer reads `railway.json` (Config as Code is deprecated), so the
service settings below are applied through the dashboard, the CLI or the
GraphQL API.

## Services

| Service | Source | Settings | Volume | Limit |
|---|---|---|---|---|
| `postgres` | `railway up docker/postgres --path-as-root --service postgres` | Dockerfile `Dockerfile`; start command `docker-entrypoint.sh postgres -c shared_preload_libraries=pg_textsearch -c shared_buffers=64MB -c max_connections=40 -c effective_cache_size=256MB` | `/var/lib/postgresql/data` | 1 vCPU / 1 GB |
| `valkey` | image `valkey/valkey:8-alpine` | start command `valkey-server --appendonly yes --appendfsync everysec --maxmemory-policy noeviction --dir /data` | `/data` | 0.25 vCPU / 256 MB |
| `claude-mem` | `railway up --service claude-mem` from the repository root | Dockerfile `docker/railway/Dockerfile`; healthcheck `/healthz` (300 s); public domain on port 37877 | none | 1 vCPU / 1.5 GB |

All three run in one region with one replica each.

`railway up` leaves hidden files out of its upload, and the build needs several
(the plugin manifests, `plugin/.mcp.json`). So the `claude-mem` build clones the
public repository at the commit named by the `CLAUDE_MEM_SOURCE_REF` service
variable, which Railway passes to the Dockerfile as a build argument. The
deploy workflow (`.github/workflows/railway-deploy.yml`) sets it to the pushed
commit before `railway up`. A local `docker build` without the argument uses
the working tree.

## Variables

`postgres`: `POSTGRES_USER`, `POSTGRES_PASSWORD` (random), `POSTGRES_DB`,
`PGDATA=/var/lib/postgresql/data/pgdata` (a subdirectory, because the volume
root is not empty).

`claude-mem`:

```
CLAUDE_MEM_CONTAINER_MODE=server
CLAUDE_MEM_RUNTIME=server
CLAUDE_MEM_DOCKER=1
CLAUDE_MEM_AUTH_MODE=api-key
CLAUDE_MEM_HOST=0.0.0.0
CLAUDE_MEM_SERVER_HOST=0.0.0.0
CLAUDE_MEM_SERVER_PORT=37877
PORT=37877
CLAUDE_MEM_WORKER_HOST=0.0.0.0
CLAUDE_MEM_WORKER_PORT=37877
CLAUDE_MEM_DATA_DIR=/data/claude-mem
CLAUDE_MEM_SERVER_DATABASE_URL=postgres://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.POSTGRES_DB}}
CLAUDE_MEM_REDIS_URL=redis://${{valkey.RAILWAY_PRIVATE_DOMAIN}}:6379
CLAUDE_MEM_REDIS_MODE=docker
CLAUDE_MEM_QUEUE_ENGINE=bullmq
CLAUDE_MEM_QUEUE_REDIS_PREFIX=claude_mem_37877
CLAUDE_MEM_GENERATION_DISABLED=false
CLAUDE_MEM_CHROMA_ENABLED=false
CLAUDE_MEM_SERVER_VECTOR_SEARCH=auto
CLAUDE_MEM_EMBEDDING_MODEL=all-MiniLM-L6-v2
CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS=1
CLAUDE_MEM_PUBLIC_URL=https://<domain>
CLAUDE_MEM_SERVER_PROVIDER=claude-subscription
CLAUDE_MEM_SERVER_MODEL=haiku
CLAUDE_MEM_SERVER_GENERATION_CONCURRENCY=1
CLAUDE_CODE_OAUTH_TOKEN=<from `claude setup-token`>
```

Set the token from a file so it never appears on a command line:

```bash
railway variable set --service claude-mem --stdin CLAUDE_CODE_OAUTH_TOKEN < ~/.config/claude-mem-server/oauth-token
```

Do not set `ANTHROPIC_API_KEY`; the Claude Code child would not receive it
anyway (the provider passes it an environment allowlist).

## Client keys

From the `claude-mem` service shell (`railway ssh --service claude-mem`):

```bash
bun /opt/claude-mem/scripts/server-service.cjs server api-key create \
  --scope memories:read,memories:write --team-wide
```

One key per machine, so each can be revoked on its own. A team-wide key lets
hooks name their working directory's project (`projectId: "name:<project>"`);
the server creates it on first write.

Client `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_RUNTIME": "server",
  "CLAUDE_MEM_SERVER_URL": "https://<domain>",
  "CLAUDE_MEM_SERVER_API_KEY": "cmem_..."
}
```

## Local rehearsal

```bash
POSTGRES_USER=cm POSTGRES_PASSWORD=cm POSTGRES_DB=claude_mem \
CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.config/claude-mem-server/oauth-token)" \
docker compose -f docker-compose.yml -f docker/railway/compose.override.yml up --build
```
