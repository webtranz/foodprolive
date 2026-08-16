# FoodPro capacity test

This test exercises the highest-frequency read paths through authenticated, paginated requests. It ramps to 1,000 virtual users by default and covers production, menu planning, inventory, and ingredient search.

Run it only against a staging environment with production-like data. Do not point it at the live system during operating hours.

## Prerequisites

- Install [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/).
- Prepare test accounts whose site assignments represent the intended 600-project distribution.
- Copy `users.example.json` outside source control, add the staging accounts, and protect that file as a secret.

## Run

```sh
BASE_URL=https://staging.example.com \
USER_POOL_FILE=/secure/path/load-users.json \
TARGET_USERS=1000 \
npm run test:load
```

For a small smoke test, set `TARGET_USERS=25`, `RAMP_UP=30s`, `HOLD=2m`, and `RAMP_DOWN=15s`.

## Pass criteria

- Fewer than 1% failed HTTP requests.
- At least 99% of functional checks pass.
- Paginated entity reads: p95 below 500 ms and p99 below 1,000 ms.
- Ingredient search: p95 below 400 ms and p99 below 800 ms.
- During the run, PostgreSQL CPU should normally remain below 70%, connections should remain below the configured limit, and the application should show no sustained event-loop or memory saturation.

Passing this script is one part of capacity approval. Repeat with realistic write traffic, exports, production completion, bulk uploads, and failure/recovery scenarios before certifying the platform for 1,000 concurrent users.
