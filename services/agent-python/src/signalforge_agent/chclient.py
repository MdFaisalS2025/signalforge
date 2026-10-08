"""A small, bounded ClickHouse HTTP client built on the standard library only.

It speaks the ClickHouse HTTP interface (port 8123): the statement goes in the POST body with `FORMAT JSONEachRow`
appended, every external value travels as a typed `param_<name>` URL parameter and never inside the SQL text, and the
account is sent in the `X-ClickHouse-User` and `X-ClickHouse-Key` headers, never in the URL, the body, or any error text.

Failures split by what a caller should do. A refused connection, a timeout, an HTTP 5xx, or a malformed reply is
`ClickHouseTransient`: retry later. An HTTP 4xx, or any other status, is `ClickHouseRejected` with the ClickHouse error
code when there is one: retrying will not help. Error messages are fixed text. They never repeat a credential, a
statement, a parameter, or the server's reply, and the underlying exception is not chained into them.

No driver dependency, no logging, and no environment reads. See docs/specs/2026-10-07-evidence-cited-diagnosis.md,
sections 6, 8.3, and 8.4.
"""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Mapping, Optional, Sequence

# A reply larger than this is rejected unread. The agent's queries return a handful of small rows.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

_FORMAT = "\nFORMAT JSONEachRow"
_NAME = re.compile(r"[a-z][a-z0-9_]*")
_PLACEHOLDER = re.compile(r"\{([a-z][a-z0-9_]*):[^{}]+\}")
_TABLE = re.compile(r"[a-z_][a-z0-9_]*")
_ERROR_CODE = re.compile(r"Code:\s*(\d+)")
_EXCEPTION_CODE_HEADER = "x-clickhouse-exception-code"


class ClickHouseTransient(Exception):
    """The server could not be reached or failed on its side. The same request may succeed later."""


class ClickHouseRejected(Exception):
    """The server refused the request. code is the ClickHouse error code when one was given."""

    def __init__(self, message: str, code: Optional[int] = None, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class HttpRequest:
    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes
    timeout_s: float


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str] = field(default_factory=dict)


Transport = Callable[[HttpRequest], HttpResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: it could carry the credential headers to another host."""

    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


# No proxy is ever used, so the credential headers cannot be sent through one configured in the environment.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def _urllib_transport(request: HttpRequest) -> HttpResponse:
    """The default transport. HTTP error statuses are returned as responses, not raised."""
    outgoing = urllib.request.Request(request.url, data=request.body, headers=dict(request.headers), method=request.method)
    try:
        with _OPENER.open(outgoing, timeout=request.timeout_s) as response:
            return HttpResponse(response.status, response.read(MAX_RESPONSE_BYTES + 1), dict(response.headers.items()))
    except urllib.error.HTTPError as error:
        try:
            body = error.read(MAX_RESPONSE_BYTES + 1)
        finally:
            error.close()
        return HttpResponse(error.code, body, dict(error.headers.items()))


def _escape_scalar(value: str) -> str:
    """A String parameter is read in ClickHouse's escaped text format: backslash and control characters are escaped."""
    return (
        value.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r").replace("\0", "\\0")
    )


def _escape_quoted(value: str) -> str:
    """Inside a quoted array element, backslash and the quote are escaped, and so are the control characters."""
    return _escape_scalar(value).replace("'", "\\'")


def _encode_parameter(value: object) -> str:
    if isinstance(value, bool):
        raise TypeError("a boolean is not a supported parameter value")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _escape_scalar(value)
    if isinstance(value, (list, tuple)):
        if not all(isinstance(item, str) for item in value):
            raise TypeError("only an array of strings is a supported array parameter")
        return "[" + ",".join(f"'{_escape_quoted(item)}'" for item in value) + "]"
    raise TypeError("unsupported parameter value type")


class ClickHouseClient:
    def __init__(
        self,
        url: str,
        database: str,
        user: str,
        password: str,
        timeout_s: float,
        transport: Optional[Transport] = None,
    ) -> None:
        try:
            parts = urllib.parse.urlsplit(url)
            parts.port  # noqa: B018 - raises ValueError for a malformed port
            host = parts.hostname
        except (ValueError, AttributeError):
            raise ValueError("url must be an http or https URL") from None
        if parts.scheme not in ("http", "https") or not host:
            raise ValueError("url must be an http or https URL")
        if parts.username is not None or parts.password is not None:
            raise ValueError("url must not contain credentials")
        if parts.query or parts.fragment:
            raise ValueError("url must not contain a query or fragment")
        if not isinstance(database, str) or not database:
            raise ValueError("database must be a non-empty string")
        if not isinstance(user, str) or not user:
            raise ValueError("user must be a non-empty string")
        if not isinstance(password, str):
            raise ValueError("password must be a string")
        if isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float)) or timeout_s <= 0:
            raise ValueError("timeout_s must be a positive number")

        self._endpoint = f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}/"
        self._database = database
        self._user = user
        self._password = password
        self._timeout_s = timeout_s
        self._transport: Transport = transport or _urllib_transport

    def __repr__(self) -> str:
        return (
            f"ClickHouseClient(url={self._endpoint!r}, database={self._database!r}, user={self._user!r}, "
            f"password=<redacted>, timeout_s={self._timeout_s!r})"
        )

    __str__ = __repr__

    def query(self, sql: str, params: Optional[Mapping[str, object]] = None) -> list:
        """Run one SELECT and return its rows as a list of dictionaries. Values are bound, never interpolated."""
        if not isinstance(sql, str) or not re.match(r"\s*select\b", sql, re.IGNORECASE) or ";" in sql:
            raise ValueError("query accepts one SELECT statement only")
        bound = dict(params or {})
        for name in bound:
            if not isinstance(name, str) or not _NAME.fullmatch(name) or name.startswith("param_"):
                raise ValueError("a parameter name must be a lowercase identifier")
        if set(bound) != set(_PLACEHOLDER.findall(sql)):
            raise ValueError("the parameters must match the statement's placeholders exactly")
        encoded = {f"param_{name}": _encode_parameter(value) for name, value in bound.items()}
        body = (sql.rstrip() + _FORMAT).encode("utf-8")
        return self._parse_rows(self._send(body, encoded))

    def insert(self, table: str, rows: Sequence[Mapping]) -> None:
        """Insert rows as JSONEachRow. The table must be a literal lowercase identifier chosen by repository code."""
        if not isinstance(table, str) or not _TABLE.fullmatch(table):
            raise ValueError("table must be a literal lowercase identifier")
        if isinstance(rows, (str, bytes)) or not isinstance(rows, (list, tuple)) or not rows:
            raise ValueError("rows must be a non-empty list of mappings")
        lines = []
        for row in rows:
            if not isinstance(row, Mapping):
                raise TypeError("each row must be a mapping")
            lines.append(json.dumps(dict(row), separators=(",", ":"), ensure_ascii=False, allow_nan=False))
        body = (f"INSERT INTO {table} FORMAT JSONEachRow\n" + "\n".join(lines) + "\n").encode("utf-8")
        self._parse_rows(self._send(body, {}))

    def _send(self, body: bytes, parameters: Mapping[str, str]) -> HttpResponse:
        query = urllib.parse.urlencode({"database": self._database, **parameters}, quote_via=urllib.parse.quote)
        request = HttpRequest(
            method="POST",
            url=f"{self._endpoint}?{query}",
            headers={
                "X-ClickHouse-User": self._user,
                "X-ClickHouse-Key": self._password,
                "Content-Type": "text/plain; charset=utf-8",
            },
            body=body,
            timeout_s=self._timeout_s,
        )
        try:
            return self._transport(request)
        except (OSError, http.client.HTTPException):
            # The underlying text can name hosts and sockets, so it is not chained into the error.
            raise ClickHouseTransient("ClickHouse is unreachable or the request timed out") from None

    def _parse_rows(self, response: HttpResponse) -> list:
        if len(response.body) > MAX_RESPONSE_BYTES:
            raise ClickHouseRejected("ClickHouse sent a reply larger than the limit", None, response.status)
        if response.status >= 500:
            raise ClickHouseTransient("ClickHouse returned a server error")
        text = response.body.decode("utf-8", errors="replace")
        headers = {str(key).lower(): value for key, value in (response.headers or {}).items()}
        code = _exception_code(headers, text)
        if response.status != 200:
            raise _rejected(response.status, code)
        if text.lstrip().startswith("Code:"):
            # ClickHouse can report a failure in the body of a 200 reply once it has started streaming.
            raise _rejected(response.status, code)
        try:
            decoded = response.body.decode("utf-8")
        except UnicodeDecodeError:
            raise ClickHouseTransient("ClickHouse sent a malformed reply") from None
        rows = []
        for line in decoded.splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                raise ClickHouseTransient("ClickHouse sent a malformed reply") from None
            if not isinstance(row, dict):
                raise ClickHouseTransient("ClickHouse sent a malformed reply")
            rows.append(row)
        return rows


def _exception_code(headers: Mapping[str, str], text: str) -> Optional[int]:
    header = headers.get(_EXCEPTION_CODE_HEADER)
    if header is not None and str(header).strip().isdigit():
        return int(str(header).strip())
    match = _ERROR_CODE.search(text[:4096])
    return int(match.group(1)) if match else None


def _rejected(status: int, code: Optional[int]) -> ClickHouseRejected:
    shown = "no code" if code is None else f"code {code}"
    return ClickHouseRejected(f"ClickHouse rejected the request (HTTP {status}, {shown})", code, status)
