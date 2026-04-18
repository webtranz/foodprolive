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

4. Sign in with the seeded admin account:

- Email: `admin@foodpro.local`
- Password: `admin12345`

Override those defaults in `.env` before first production deployment.

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
3. Select Dockerfile deployment.
4. Set the required environment variables from `.env.example`.
5. Mount persistent storage for:
   - `/app/uploads`
   - PostgreSQL data volume
6. Expose the container port configured by `PORT` or use the default `3000`.

The included `docker-compose.yml` can also be imported into Dokploy if you prefer compose-based deployment.
