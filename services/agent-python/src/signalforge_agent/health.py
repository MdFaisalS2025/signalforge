"""The heartbeat file and the health check built on it.

The loop touches the file at the end of every cycle, including a cycle that found no work. The container health check
(`python -m signalforge_agent healthcheck`) reports healthy only while the file's modification time is at most
max(10, 3 x poll interval) seconds from now, so a stalled or crashed loop turns unhealthy within a few polls.
"""

from __future__ import annotations

import os
import time
from typing import Optional

MIN_FRESH_SECONDS = 10


def touch_heartbeat(path: str) -> None:
    """Create the file if needed and set its modification time to now."""
    with open(path, "a"):
        pass
    os.utime(path, None)


def heartbeat_is_fresh(path: str, poll_interval_s: int, now: Optional[float] = None) -> bool:
    """True when the file exists and its age is at most max(10, 3 * poll_interval_s) seconds.

    A timestamp that far in the future is not trusted either, so the comparison is on the absolute difference.
    """
    try:
        modified = os.stat(path).st_mtime
    except OSError:
        return False
    current = time.time() if now is None else now
    return abs(current - modified) <= max(MIN_FRESH_SECONDS, 3 * poll_interval_s)
