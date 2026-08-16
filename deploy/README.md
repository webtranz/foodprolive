# Production capacity deployment

The application is now stateless when S3-compatible object storage is configured. Entity-change notifications and the durable bulk-upload queue use PostgreSQL, so any API replica can serve a request or claim a background job.

## Required managed services

- PostgreSQL 16 with automated backups, point-in-time recovery, monitoring, and enough IOPS for peak production activity.
- PgBouncer in transaction mode. Set `DATABASE_URL` to the PgBouncer endpoint rather than connecting every pod directly to PostgreSQL. Set `REALTIME_DATABASE_URL` to a direct PostgreSQL endpoint or a separate PgBouncer session-mode endpoint because PostgreSQL `LISTEN/NOTIFY` requires a stable session.
- S3-compatible object storage for uploads. Set all `OBJECT_STORAGE_*` variables. The configured service account needs get, put, and delete access only to the FoodPro bucket. Set `OBJECT_STORAGE_PUBLIC_URL` to an HTTPS CDN or public-read asset endpoint when images should bypass the API proxy.
- A load balancer or Kubernetes ingress with a response timeout above 60 seconds and buffering disabled for `/api/events`.

## Secrets

Create `foodpro-secrets` separately. At minimum it must contain `DATABASE_URL`, `REALTIME_DATABASE_URL`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY`, `PUBLIC_APP_URL`, and the application administrator/SMTP secrets required by the environment. Do not commit the Secret manifest.

## Connection budget

`DB_POOL_MAX` applies per pod. Three pods at the default of 20 can use up to 60 normal pool connections, plus one PostgreSQL notification listener per pod and background-worker connections. PgBouncer and PostgreSQL limits must be sized above that total with room for migrations and administration. Recalculate the budget before raising the HPA maximum.

## Rollout sequence

1. Provision PostgreSQL/PgBouncer and object storage, then take a database backup.
2. Apply the SQL migrations by starting one release instance.
3. Deploy three API replicas and verify both health endpoints.
4. Run the 25-user smoke profile from `load-tests/README.md`.
5. Run staged tests at 100, 250, 500, and 1,000 users while monitoring latency, errors, database CPU/IO, pool saturation, memory, and event-loop delay.
6. Approve 1,000-user capacity only after the full profile passes with production-like data and a realistic 600-site test-account distribution.

The Kubernetes manifest is a baseline. Replace the image name and region/bucket values, add your ingress and certificate policy, and tune resource requests from measured load-test results.
