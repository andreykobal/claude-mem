# Encrypted backups of the claude-mem server to Cloudflare R2

A Railway cron service (`backup`, schedule `0 3 * * *` UTC) runs
`backup.sh` once a day and exits:

1. `pg_dump --format=custom` of the claude-mem database, without the data of
   `observation_embeddings` (the server recomputes vectors after a restore);
2. `pg_restore --list` to make sure the archive is readable;
3. `age` encryption to a public key (the private key is never on Railway or R2);
4. upload to `daily/claude-mem-YYYY-MM-DD.dump.age`, and on Sundays also
   `weekly/claude-mem-YYYY-MM-DD.dump.age`.

Retention is the bucket's lifecycle rules, not the script: `daily/` 7 days,
`weekly/` 35 days, unfinished multipart uploads 1 day. About 12 copies exist at
any time.

## Service settings

| Setting | Value |
|---|---|
| Source | `railway up docker/backup --path-as-root --service backup` |
| Dockerfile | `Dockerfile` |
| Cron schedule | `0 3 * * *` |
| Restart policy | `NEVER` |
| Limit | 0.5 vCPU / 512 MB |

Variables:

```
DATABASE_URL=postgres://${{postgres.POSTGRES_USER}}:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{postgres.POSTGRES_DB}}
BACKUP_AGE_RECIPIENT=age1...            # public key only
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
R2_BUCKET=claude-mem-backups
R2_ACCESS_KEY_ID=...                    # R2 token scoped to the bucket
R2_SECRET_ACCESS_KEY=...
```

The R2 credentials come from an account API token with only
*Workers R2 Storage Bucket Item Read/Write* on this one bucket: the access key
id is the token id and the secret is the SHA-256 of the token value.

Run one now: `railway cron run --service backup --yes`; see runs with
`railway cron list --service backup`.

## Restore

```bash
# 1. Fetch and decrypt (needs the age private key)
curl -sSf --aws-sigv4 "aws:amz:auto:s3" --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
  -o backup.age "$R2_ENDPOINT/$R2_BUCKET/daily/claude-mem-YYYY-MM-DD.dump.age"
age -d -i backup-age-key.txt -o backup.dump backup.age

# 2. Restore into an empty database built from docker/postgres (pgvector,
#    pg_textsearch preloaded)
pg_restore --no-owner -d "postgres://...empty database..." backup.dump

# 3. Start claude-mem against it: it recomputes the vectors in the background.
```

Rehearse a restore after schema changes and about once a month: a backup that
was never restored is not known to work.
