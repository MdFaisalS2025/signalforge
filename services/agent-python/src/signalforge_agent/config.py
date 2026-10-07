"""Agent configuration, parsed from a mapping and validated so that it fails closed.

This module is pure: it reads only the mapping it is given, so it never touches the process environment, the network,
the filesystem, ClickHouse, or a provider. Docs: docs/specs/2026-10-07-evidence-cited-diagnosis.md, sections 10.2
and 13.1.

An invalid setting raises ConfigError, which names the variable and a fixed reason. It never repeats a value,
because a value may be a secret or may contain one (a URL with credentials, for example).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional
from urllib.parse import urlsplit

REVISION_POLICIES = ("first-only", "on-analyzer-change")
PROVIDERS = ("deterministic", "openai-compatible")

# The only hosts for which plain HTTP and a missing API key are acceptable: a model server on this machine.
LOCAL_PROVIDER_HOSTS = frozenset({"localhost", "127.0.0.1", "host.docker.internal"})

DEFAULT_DATABASE = "signalforge"
DEFAULT_POLL_INTERVAL_S = 2
DEFAULT_BATCH_SIZE = 5
DEFAULT_HEARTBEAT_PATH = "/tmp/agent-heartbeat"
DEFAULT_PROVIDER_TIMEOUT_S = 20

_REDACTED = "<redacted>"


class ConfigError(Exception):
    """A setting is missing or invalid. The message names the variable and never contains a value."""

    def __init__(self, variable: str, reason: str) -> None:
        super().__init__(f"{variable}: {reason}")
        self.variable = variable
        self.reason = reason


@dataclass(frozen=True, repr=False)
class AgentConfig:
    clickhouse_url: str
    database: str
    user: str
    password: str
    poll_interval_s: int
    batch_size: int
    revision_policy: str
    heartbeat_path: str
    provider: str
    provider_base_url: Optional[str]
    provider_model: Optional[str]
    provider_api_key: Optional[str]
    provider_allow_external: bool
    provider_timeout_s: int

    def __repr__(self) -> str:
        # The secrets are replaced by a fixed marker, so a repr reveals neither the values nor whether a key is set.
        shown = {
            "clickhouse_url": self.clickhouse_url,
            "database": self.database,
            "user": self.user,
            "password": _REDACTED,
            "poll_interval_s": self.poll_interval_s,
            "batch_size": self.batch_size,
            "revision_policy": self.revision_policy,
            "heartbeat_path": self.heartbeat_path,
            "provider": self.provider,
            "provider_base_url": self.provider_base_url,
            "provider_model": self.provider_model,
            "provider_api_key": _REDACTED,
            "provider_allow_external": self.provider_allow_external,
            "provider_timeout_s": self.provider_timeout_s,
        }
        fields = ", ".join(f"{name}={value if value == _REDACTED else repr(value)}" for name, value in shown.items())
        return f"AgentConfig({fields})"

    __str__ = __repr__


def _optional(env: Mapping[str, str], name: str) -> Optional[str]:
    """The value, or None when it is absent or empty. Compose passes an empty string for an unset reference."""
    value = env.get(name)
    return value if value else None


def _required(env: Mapping[str, str], name: str) -> str:
    value = _optional(env, name)
    if value is None:
        raise ConfigError(name, "is required")
    return value


def _bounded_int(env: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    raw = _optional(env, name)
    if raw is None:
        return default
    # ASCII digits only: no sign, no space, no decimal point, no exponent, no other script's digits.
    if not (raw.isascii() and raw.isdigit()):
        raise ConfigError(name, f"must be an integer from {low} to {high}")
    value = int(raw)
    if not low <= value <= high:
        raise ConfigError(name, f"must be an integer from {low} to {high}")
    return value


def _http_url(name: str, raw: str):
    """Parse an http(s) URL with a host and no embedded credentials. Returns the split result."""
    try:
        parts = urlsplit(raw)
        host = parts.hostname
        parts.port  # noqa: B018 - raises ValueError for a malformed port
    except ValueError:
        raise ConfigError(name, "must be an http or https URL") from None
    if parts.scheme not in ("http", "https") or not host or any(ch.isspace() for ch in raw):
        raise ConfigError(name, "must be an http or https URL")
    if parts.username is not None or parts.password is not None:
        raise ConfigError(name, "must not contain credentials")
    return parts


def _choice(env: Mapping[str, str], name: str, default: str, allowed) -> str:
    raw = _optional(env, name)
    if raw is None:
        return default
    if raw not in allowed:
        raise ConfigError(name, "must be one of: " + ", ".join(allowed))
    return raw


def _yes_no(env: Mapping[str, str], name: str) -> bool:
    raw = _optional(env, name)
    if raw is None:
        return False
    if raw not in ("yes", "no"):
        raise ConfigError(name, "must be yes or no")
    return raw == "yes"


def load(env: Mapping[str, str]) -> AgentConfig:
    """Build and validate the configuration from a mapping. Raises ConfigError on the first problem."""
    clickhouse_url = _required(env, "CLICKHOUSE_URL")
    _http_url("CLICKHOUSE_URL", clickhouse_url)
    user = _required(env, "CLICKHOUSE_USER")
    password = _required(env, "CLICKHOUSE_PASSWORD")
    database = _optional(env, "CLICKHOUSE_DATABASE") or DEFAULT_DATABASE

    poll_interval_s = _bounded_int(env, "AGENT_POLL_INTERVAL_S", DEFAULT_POLL_INTERVAL_S, 1, 60)
    batch_size = _bounded_int(env, "AGENT_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 20)
    revision_policy = _choice(env, "AGENT_REVISION_POLICY", "first-only", REVISION_POLICIES)
    heartbeat_path = _optional(env, "AGENT_HEARTBEAT_PATH") or DEFAULT_HEARTBEAT_PATH
    provider = _choice(env, "AGENT_PROVIDER", "deterministic", PROVIDERS)

    # Provider-specific settings are read only for the provider that uses them. The deterministic provider needs
    # none, so a stray or invalid value there is ignored rather than trusted or reported.
    provider_base_url: Optional[str] = None
    provider_model: Optional[str] = None
    provider_api_key: Optional[str] = None
    provider_allow_external = False
    provider_timeout_s = DEFAULT_PROVIDER_TIMEOUT_S

    if provider == "openai-compatible":
        provider_base_url = _required(env, "AGENT_PROVIDER_BASE_URL")
        provider_model = _required(env, "AGENT_PROVIDER_MODEL")
        parts = _http_url("AGENT_PROVIDER_BASE_URL", provider_base_url)
        provider_timeout_s = _bounded_int(env, "AGENT_PROVIDER_TIMEOUT_S", DEFAULT_PROVIDER_TIMEOUT_S, 1, 120)
        provider_allow_external = _yes_no(env, "AGENT_PROVIDER_ALLOW_EXTERNAL")
        provider_api_key = _optional(env, "AGENT_PROVIDER_API_KEY")
        if parts.hostname not in LOCAL_PROVIDER_HOSTS:
            if parts.scheme != "https":
                raise ConfigError("AGENT_PROVIDER_BASE_URL", "must use https unless the host is local")
            if not provider_allow_external:
                raise ConfigError("AGENT_PROVIDER_ALLOW_EXTERNAL", "must be yes to send evidence to a non-local host")
            if provider_api_key is None:
                raise ConfigError("AGENT_PROVIDER_API_KEY", "is required for a non-local host")

    return AgentConfig(
        clickhouse_url=clickhouse_url,
        database=database,
        user=user,
        password=password,
        poll_interval_s=poll_interval_s,
        batch_size=batch_size,
        revision_policy=revision_policy,
        heartbeat_path=heartbeat_path,
        provider=provider,
        provider_base_url=provider_base_url,
        provider_model=provider_model,
        provider_api_key=provider_api_key,
        provider_allow_external=provider_allow_external,
        provider_timeout_s=provider_timeout_s,
    )
