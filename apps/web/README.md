# web

Next.js read-only incident dashboard (TypeScript). This directory currently contains the application
shell and the health endpoint `GET /api/health`, which reports only that the process is up.
The dashboard pages and the read-only API are built in later tasks.

Run it through Compose:

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build web
curl -s http://localhost:3000/api/health
```
