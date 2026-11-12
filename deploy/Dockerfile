# Public trial image: server.py in public mode (SPELLING_PUBLIC_ROOT) serving the browser-only build, where each
# family's words, recordings and progress stay in its own browser (IndexedDB). The server stores nothing but the
# feedback queue (sqlite, rows leave once sent to Vikunja). Stdlib only, no pip.
#
# Build (repo root as context):  docker build -f deploy/Dockerfile -t spellaloud:$(git rev-parse --short HEAD) .
# Run:   docker run --rm -p 8080:8080 -e SPELLING_ALLOWED_HOSTS=localhost,127.0.0.1 -v spellaloud-data:/data spellaloud:<tag>
# Deploy on the Hetzner `sites` project: deploy/public.md.
# The LAN family instance (TrueNAS, ash./finn.lab) does NOT use this image; see deploy/compose.yaml.
# NOTE: floating tag, as in compose.yaml; pin a digest once known good (Vikunja #4122).
FROM python:3.13-alpine

# alpine has no zone files; SPELLING_TZ needs them (README)
RUN apk add --no-cache tzdata && adduser -D -H -u 10001 app && mkdir /data && chown app /data

WORKDIR /app
COPY server.py ./
COPY static ./static
COPY bin/build-local ./bin/build-local
# The browser-only build at the site root (no --base), then drop the builder.
RUN python3 bin/build-local --src /app --out /app/public && rm -rf bin

# SEC-1: server.py defaults to 127.0.0.1, so the container binds 0.0.0.0 explicitly (Traefik reaches it over stack-net;
# the port is never published to the host) and sets NO SPELLING_AUTH_TOKEN: the public build and POST /api/feedback
# carry no auth header (tests/test_public_deploy.py).
ENV SPELLING_DATA_DIR=/data \
    SPELLING_PORT=8080 \
    SPELLING_BIND=0.0.0.0 \
    SPELLING_TZ=Europe/London \
    SPELLING_PUBLIC_ROOT=/app/public \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER app
VOLUME /data
EXPOSE 8080
# 127.0.0.1 must be in SPELLING_ALLOWED_HOSTS for this check (the host allowlist answers 421 otherwise).
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
CMD ["python", "/app/server.py"]
