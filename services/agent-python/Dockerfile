# agent-python image stages. The build context is the repository root (see Dockerfile.dockerignore).
#   deps     the pinned interpreter plus the exact packages in requirements.txt. scripts/py-in-docker.mjs builds only this
#            stage and runs the tests in it with the repository mounted read-only.
#   runtime  the agent itself, and the last stage, so Compose builds it. It holds the pinned packages, the agent source,
#            and the diagnosis schema, and nothing else: it adds no tools, runs as a dedicated non-root user, and works
#            with a read-only root filesystem and a writable /tmp.
ARG PYTHON_IMAGE=python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f

FROM ${PYTHON_IMAGE} AS deps
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
COPY services/agent-python/requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt && rm /tmp/requirements.txt

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/src
COPY services/agent-python/requirements.txt /tmp/requirements.txt
# The pinned packages are installed once, and then the installer itself is removed, so the running image has no package manager.
RUN pip install -r /tmp/requirements.txt \
    && python -m pip uninstall -y pip \
    && rm /tmp/requirements.txt
RUN groupadd --system --gid 10001 agent \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin agent
WORKDIR /app
COPY services/agent-python/src /app/src
COPY contracts/events/diagnosis.schema.json /app/contracts/events/diagnosis.schema.json
USER 10001:10001
ENTRYPOINT ["python", "-m", "signalforge_agent", "run"]
