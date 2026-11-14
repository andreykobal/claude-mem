# Nightly encrypted Postgres backup of the claude-mem server to Cloudflare R2.
# Runs as a Railway cron service: dumps, verifies, encrypts with age, uploads,
# exits. Retention is R2's lifecycle rules (daily/ 7 days, weekly/ 35 days), not
# this script. See docker/backup/README.md.
#
# Same Postgres major as the server's database (docker/postgres/Dockerfile),
# because pg_dump refuses a newer server.
FROM postgres:17-trixie

RUN apt-get update \
 && apt-get install -y --no-install-recommends age ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 backup.sh /usr/local/bin/claude-mem-backup

# Not a database server: run the backup and exit.
ENTRYPOINT []
CMD ["/usr/local/bin/claude-mem-backup"]
