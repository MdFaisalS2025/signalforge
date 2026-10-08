"""Command line entry point.

    python -m signalforge_agent run          the diagnosis loop (exit 0 after a stop, 2 for a bad setting, 3 if the table never appears)
    python -m signalforge_agent healthcheck  exit 0 only while the heartbeat file is fresh, else 1

Exactly these two commands exist. The CLI is the one place the process environment is read. A configuration error names
the variable and never its value, and is written as a single JSON line, like every other log line.
"""

from __future__ import annotations

import json
import os
import re
import signal
import sys
import threading
from typing import Callable, Mapping, Optional, Sequence, TextIO

from .config import AgentConfig, ConfigError, load
from .health import heartbeat_is_fresh
from .orchestrator import run

USAGE = "usage: python -m signalforge_agent {run|healthcheck}"

_VARIABLE = re.compile(r"[A-Z][A-Z0-9_]*")


def _install_signal_handlers(stop: threading.Event) -> None:
    """SIGTERM and SIGINT ask the loop to stop after the incident in progress."""
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda _signum, _frame: stop.set())


def _default_healthcheck(config: AgentConfig) -> int:
    return 0 if heartbeat_is_fresh(config.heartbeat_path, config.poll_interval_s) else 1


def _report_configuration_error(error: ConfigError, stderr: TextIO) -> None:
    variable = error.variable if _VARIABLE.fullmatch(error.variable or "") else ""
    message = f"invalid configuration: {variable}" if variable else "invalid configuration"
    stderr.write(json.dumps({"level": "error", "message": message, "error_class": "ConfigError"}, separators=(",", ":")) + "\n")


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    env: Optional[Mapping[str, str]] = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
    run_fn: Optional[Callable[[AgentConfig, threading.Event], int]] = None,
    healthcheck_fn: Optional[Callable[[AgentConfig], int]] = None,
    install_signals: bool = True,
) -> int:
    """Dispatch one command. stdout is accepted for symmetry and unused: the CLI itself writes only to stderr."""
    err = stderr if stderr is not None else sys.stderr
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 1 or arguments[0] not in ("run", "healthcheck"):
        err.write(USAGE + "\n")
        return 2
    command = arguments[0]

    try:
        config = load(os.environ if env is None else env)
    except ConfigError as error:
        _report_configuration_error(error, err)
        # A bad setting stops `run` with 2. For a health check it simply means unhealthy.
        return 2 if command == "run" else 1

    if command == "healthcheck":
        return (healthcheck_fn or _default_healthcheck)(config)

    stop = threading.Event()
    if install_signals:
        _install_signal_handlers(stop)
    return (run_fn or run)(config, stop)


if __name__ == "__main__":
    sys.exit(main())
