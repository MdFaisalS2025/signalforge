# agent-python image stages. Only `deps` exists so far: it is the pinned interpreter plus the exact packages in
# requirements.txt, and scripts/py-in-docker.mjs runs the tests in it with the repository mounted read-only.
# The build context is the repository root (see Dockerfile.dockerignore).
ARG PYTHON_IMAGE=python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f

FROM ${PYTHON_IMAGE} AS deps
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
COPY services/agent-python/requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt && rm /tmp/requirements.txt
