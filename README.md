# FoodPro Platform

FoodPro is a production kitchen and dining operations platform built with React, Express, and PostgreSQL. The project now runs independently without Base44 and is structured for direct deployment from GitHub to Dokploy on a VPS.

## Stack

- Frontend: React + Vite + TanStack Query + Tailwind
- Backend: Express
- Database: PostgreSQL with automatic schema bootstrap
- File storage: local `uploads/`
- Optional integrations: OpenAI Responses API and SMTP email

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create an environment file:

```bash
cp .env.example .env
```

3. Start PostgreSQL, the client, and the API:

```bash
npm run dev
```

4. Sign in with either administrator account configured through
   `ADMIN_*` or `SECOND_ADMIN_*` in `.env`.

Override the example credentials before first production deployment.

## Production build

```bash
npm run build
npm run start
```

The server serves both the API and the built frontend.

## Environment variables

See `.env.example` for the full list. The most important values are:

- `PORT`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `DATABASE_URL`
- `POSTGRES_*`
- `PUBLIC_APP_URL`
- `OPENAI_API_KEY` for AI-assisted features
- `SMTP_*` and `EMAIL_FROM` for real email delivery

## Deploying with Dokploy

1. Push this repository to GitHub.
2. In Dokploy, create a new application from the GitHub repository.
3. Prefer importing the included `docker-compose.yml` so Dokploy runs both `foodpro` and `postgres` together.
4. Expose only the `foodpro` service publicly on port `3000`.
5. Set the required environment variables from `.env.example` in Dokploy:
   - `PUBLIC_APP_URL`
   - `DATABASE_URL`
   - `POSTGRES_*`
   - `ADMIN_NAME`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
6. Keep persistent storage for:
   - `/app/uploads`
   - PostgreSQL data volume
7. After deployment, open `/api/health` on the public domain and confirm it returns JSON with `{"status":"ok"}` before testing login.

If `/api/health` returns the frontend HTML instead of JSON, Dokploy is routing to a static/frontend target instead of the Express service and login will fail until that routing is corrected.
