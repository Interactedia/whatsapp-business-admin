# Local Development

## Requirements

- Node.js >=24 <25
- npm matching the checked-in lockfile
- Native Linux services for runtime work
- PostgreSQL for real database migration or runtime validation

Docker is not part of the approved development or deployment path for this project.

## Environment

Prisma loads `DATABASE_URL` from the environment through `prisma.config.ts`.
The value is required by Prisma commands such as `prisma generate` and by `npm run build`, because the build script runs Prisma Client generation first.

Prisma Client generation and Next.js compilation require a syntactically valid PostgreSQL URL, but they do not require opening a database connection. Use a non-production local value for generation/build-only checks, for example the placeholder shape shown in `.env.example`.

Do not use production credentials for local validation. Do not commit `.env` files or secrets.

## Commands

```sh
DATABASE_URL='postgresql://wa:wa@localhost:5434/wa_admin?schema=public' npm run db:generate
npm run lint
npm run test
DATABASE_URL='postgresql://wa:wa@localhost:5434/wa_admin?schema=public' npm run build
```

Use a real, disposable local PostgreSQL database only when validating migrations. A build-time placeholder is not evidence that migrations were executed.
