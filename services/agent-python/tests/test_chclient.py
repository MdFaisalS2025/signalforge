import http.server
import json
import socket
import threading
import unittest
import urllib.error
import urllib.parse

from signalforge_agent.chclient import (
    ClickHouseClient,
    ClickHouseRejected,
    ClickHouseTransient,
    HttpRequest,
    HttpResponse,
)

URL = "http://clickhouse:8123"
PASSWORD = "pw-SECRET-xyz-91"
USER = "agent_writer"


class FakeTransport:
    """Records every request and replays scripted responses or exceptions."""

    def __init__(self, *script):
        self.requests = []
        self._script = list(script)

    def __call__(self, request):
        self.requests.append(request)
        item = self._script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def ok(body=b"", status=200, headers=None):
    return HttpResponse(status=status, body=body, headers=headers or {})


def make(*script, timeout_s=5, url=URL):
    transport = FakeTransport(*script)
    client = ClickHouseClient(url, "signalforge", USER, PASSWORD, timeout_s, transport=transport)
    return client, transport


def query_string(request):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(request.url).query, keep_blank_values=True)


def parse_array_literal(text):
    """A reference decoder for the Array(String) literals the client writes: ['a','b'] with backslash escapes."""
    assert text.startswith("[") and text.endswith("]"), text
    items, i, body = [], 1, text[:-1]
    escapes = {"\\": "\\", "'": "'", "n": "\n", "t": "\t", "r": "\r", "0": "\0"}
    while i < len(body):
        assert body[i] == "'", f"expected a quote at {i} in {text!r}"
        i += 1
        out = []
        while body[i] != "'":
            if body[i] == "\\":
                out.append(escapes[body[i + 1]])
                i += 2
            else:
                out.append(body[i])
                i += 1
        items.append("".join(out))
        i += 1
        if i < len(body):
            assert body[i] == ",", f"expected a comma at {i} in {text!r}"
            i += 1
    return items


class QueryRequestTest(unittest.TestCase):
    def test_query_appends_exactly_format_jsoneachrow(self):
        client, transport = make(ok())
        client.query("SELECT 1 AS n")
        self.assertEqual(transport.requests[0].body.decode("utf-8"), "SELECT 1 AS n\nFORMAT JSONEachRow")

    def test_trailing_whitespace_in_the_statement_does_not_change_the_appended_format(self):
        client, transport = make(ok())
        client.query("SELECT 1 AS n  \n\n")
        self.assertEqual(transport.requests[0].body.decode("utf-8"), "SELECT 1 AS n\nFORMAT JSONEachRow")

    def test_the_request_is_a_post_to_the_configured_host_with_the_database_and_nothing_else(self):
        client, transport = make(ok())
        client.query("SELECT 1 AS n")
        request = transport.requests[0]
        self.assertIsInstance(request, HttpRequest)
        self.assertEqual(request.method, "POST")
        parts = urllib.parse.urlsplit(request.url)
        self.assertEqual((parts.scheme, parts.hostname, parts.port, parts.path), ("http", "clickhouse", 8123, "/"))
        self.assertEqual(query_string(request), {"database": ["signalforge"]})

    def test_credentials_travel_only_in_the_clickhouse_headers(self):
        client, transport = make(ok())
        client.query("SELECT 1 AS n")
        request = transport.requests[0]
        self.assertEqual(request.headers["X-ClickHouse-User"], USER)
        self.assertEqual(request.headers["X-ClickHouse-Key"], PASSWORD)
        self.assertNotIn(PASSWORD, request.url)
        self.assertNotIn(PASSWORD, request.body.decode("utf-8"))
        self.assertNotIn("Authorization", request.headers)

    def test_the_timeout_is_enforced_on_every_request(self):
        client, transport = make(ok(), ok(), timeout_s=7)
        client.query("SELECT 1 AS n")
        client.insert("diagnoses", [{"a": 1}])
        self.assertEqual([r.timeout_s for r in transport.requests], [7, 7])

    def test_a_trailing_slash_on_the_base_url_is_harmless(self):
        client, transport = make(ok(), url="http://clickhouse:8123/")
        client.query("SELECT 1 AS n")
        self.assertEqual(urllib.parse.urlsplit(transport.requests[0].url).path, "/")

    def test_query_only_accepts_select_statements(self):
        client, transport = make()
        for sql in ("INSERT INTO diagnoses VALUES (1)", "DROP TABLE diagnoses", "ALTER TABLE diagnoses DELETE WHERE 1",
                    "TRUNCATE TABLE diagnoses", "SYSTEM FLUSH LOGS", "", "   ", "-- SELECT\nDROP TABLE x"):
            with self.subTest(sql=sql):
                with self.assertRaises(ValueError):
                    client.query(sql)
        self.assertEqual(transport.requests, [])

    def test_a_second_statement_is_rejected(self):
        client, transport = make()
        for sql in ("SELECT 1 AS n; DROP TABLE diagnoses", "SELECT 1 AS n;", "SELECT ';' AS n"):
            with self.subTest(sql=sql):
                with self.assertRaises(ValueError):
                    client.query(sql)
        self.assertEqual(transport.requests, [])

    def test_select_may_follow_leading_whitespace(self):
        client, transport = make(ok())
        client.query("\n  select 1 AS n")
        self.assertEqual(len(transport.requests), 1)


class ParameterTest(unittest.TestCase):
    def test_parameters_travel_only_as_param_name_values(self):
        client, transport = make(ok())
        client.query("SELECT {limit:UInt32} AS a, {name:String} AS b", {"limit": 5, "name": "deterministic"})
        found = query_string(transport.requests[0])
        self.assertEqual(found["param_limit"], ["5"])
        self.assertEqual(found["param_name"], ["deterministic"])
        self.assertEqual(sorted(found), ["database", "param_limit", "param_name"])
        self.assertNotIn("5", transport.requests[0].body.decode("utf-8").replace("{limit:UInt32}", ""))

    def test_values_never_enter_the_sql_text(self):
        client, transport = make(ok())
        client.query("SELECT {id:String} AS a", {"id": "SENTINEL-VALUE'; DROP TABLE x --"})
        self.assertNotIn("SENTINEL", transport.requests[0].body.decode("utf-8"))

    def test_array_of_strings_renders_as_a_quoted_literal(self):
        client, transport = make(ok())
        client.query("SELECT {ids:Array(String)} AS a", {"ids": ["abc", "def"]})
        self.assertEqual(query_string(transport.requests[0])["param_ids"], ["['abc','def']"])

    def test_an_empty_array_is_a_valid_literal(self):
        client, transport = make(ok())
        client.query("SELECT {ids:Array(String)} AS a", {"ids": []})
        self.assertEqual(query_string(transport.requests[0])["param_ids"], ["[]"])

    def test_quotes_and_backslashes_in_array_elements_are_escaped_and_round_trip(self):
        tricky = ["it's", "back\\slash", "both\\'", "'", "\\", "a,b", "[x]", "tab\there", "line\nbreak", "cr\rhere",
                  "'); DROP TABLE x; --", "unicode é中", ""]
        client, transport = make(ok())
        client.query("SELECT {ids:Array(String)} AS a", {"ids": tricky})
        literal = query_string(transport.requests[0])["param_ids"][0]
        self.assertEqual(parse_array_literal(literal), tricky)
        self.assertNotIn("\n", literal)
        self.assertNotIn("\t", literal)
        self.assertNotIn("\r", literal)

    def test_a_tuple_is_accepted_as_an_array(self):
        client, transport = make(ok())
        client.query("SELECT {ids:Array(String)} AS a", {"ids": ("x", "y")})
        self.assertEqual(query_string(transport.requests[0])["param_ids"], ["['x','y']"])

    def test_scalar_strings_with_special_characters_are_escaped_for_the_url_text_format(self):
        client, transport = make(ok())
        client.query("SELECT {s:String} AS a", {"s": "a\\b\tc\nd"})
        self.assertEqual(query_string(transport.requests[0])["param_s"], ["a\\\\b\\tc\\nd"])

    def test_integers_are_decimal_text(self):
        client, transport = make(ok())
        client.query("SELECT {n:UInt32} AS a", {"n": 20})
        self.assertEqual(query_string(transport.requests[0])["param_n"], ["20"])

    def test_unsupported_value_types_are_rejected(self):
        for value in (True, False, 1.5, None, {"a": 1}, b"x", object(), [1, 2], ["a", 1], [["a"]]):
            with self.subTest(value=value):
                client, transport = make()
                with self.assertRaises(TypeError):
                    client.query("SELECT {p:String} AS a", {"p": value})
                self.assertEqual(transport.requests, [])

    def test_parameter_names_must_be_safe_identifiers(self):
        for name in ("Bad", "a-b", "1a", "a b", "a;b", "", "param_x"):
            with self.subTest(name=name):
                client, transport = make()
                with self.assertRaises(ValueError):
                    client.query("SELECT 1 AS a", {name: "x"})
                self.assertEqual(transport.requests, [])

    def test_placeholders_and_parameters_must_match_exactly(self):
        client, transport = make()
        with self.assertRaises(ValueError):
            client.query("SELECT {a:String} AS x, {b:String} AS y", {"a": "1"})  # b missing
        with self.assertRaises(ValueError):
            client.query("SELECT {a:String} AS x", {"a": "1", "b": "2"})  # b is not a placeholder
        with self.assertRaises(ValueError):
            client.query("SELECT {a:String} AS x")  # no parameters at all
        with self.assertRaises(ValueError):
            client.query("SELECT 1 AS x", {"a": "1"})  # nothing to bind
        self.assertEqual(transport.requests, [])

    def test_a_repeated_placeholder_needs_one_parameter(self):
        client, transport = make(ok())
        client.query("SELECT {a:String} AS x, {a:String} AS y", {"a": "1"})
        self.assertEqual(query_string(transport.requests[0])["param_a"], ["1"])

    def test_typed_placeholders_with_parentheses_are_recognized(self):
        client, transport = make(ok())
        client.query("SELECT {ids:Array(String)} AS a, {t:DateTime64(3, 'UTC')} AS b", {"ids": ["x"], "t": "2026-10-07 21:49:41.208"})
        self.assertEqual(sorted(query_string(transport.requests[0])), ["database", "param_ids", "param_t"])


class ResponseTest(unittest.TestCase):
    def test_jsoneachrow_parses_into_a_list_of_dictionaries(self):
        body = b'{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n'
        client, _ = make(ok(body))
        self.assertEqual(client.query("SELECT 1 AS n"), [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}])

    def test_an_empty_body_is_an_empty_list_and_blank_lines_are_ignored(self):
        client, _ = make(ok(b""), ok(b'\n{"a":1}\n\n'))
        self.assertEqual(client.query("SELECT 1 AS n"), [])
        self.assertEqual(client.query("SELECT 1 AS n"), [{"a": 1}])

    def test_unicode_survives(self):
        client, _ = make(ok('{"a":"café"}\n'.encode("utf-8")))
        self.assertEqual(client.query("SELECT 1 AS n"), [{"a": "café"}])

    def test_a_malformed_or_non_object_line_is_a_transient_failure(self):
        for body in (b"not json\n", b"[1,2]\n", b'{"a":1}\n{"a":\n', b'"text"\n', b"\xff\xfe\n"):
            with self.subTest(body=body):
                client, _ = make(ok(body))
                with self.assertRaises(ClickHouseTransient):
                    client.query("SELECT 1 AS n")

    def test_server_errors_are_transient(self):
        for status in (500, 502, 503, 504, 599):
            with self.subTest(status=status):
                client, _ = make(ok(b"Code: 999. DB::Exception: boom", status=status))
                with self.assertRaises(ClickHouseTransient):
                    client.query("SELECT 1 AS n")

    def test_timeouts_and_connection_failures_are_transient(self):
        failures = [
            socket.timeout("timed out"),
            TimeoutError("timed out"),
            ConnectionRefusedError("refused"),
            ConnectionResetError("reset"),
            urllib.error.URLError("unreachable"),
            OSError("network down"),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                client, _ = make(failure)
                with self.assertRaises(ClickHouseTransient):
                    client.query("SELECT 1 AS n")

    def test_an_unknown_table_404_is_a_rejection_with_its_code(self):
        body = b"Code: 60. DB::Exception: Table signalforge.diagnoses does not exist. (UNKNOWN_TABLE)\n"
        client, _ = make(ok(body, status=404))
        with self.assertRaises(ClickHouseRejected) as ctx:
            client.query("SELECT 1 AS n")
        self.assertEqual(ctx.exception.code, 60)

    def test_other_client_errors_are_rejections_with_their_codes(self):
        cases = [
            (403, b"Code: 497. DB::Exception: agent_writer: Not enough privileges. (ACCESS_DENIED)", 497),
            (401, b"Code: 516. DB::Exception: Authentication failed (AUTHENTICATION_FAILED)", 516),
            (400, b"Code: 62. DB::Exception: Syntax error (SYNTAX_ERROR)", 62),
        ]
        for status, body, code in cases:
            with self.subTest(status=status):
                client, _ = make(ok(body, status=status))
                with self.assertRaises(ClickHouseRejected) as ctx:
                    client.query("SELECT 1 AS n")
                self.assertEqual(ctx.exception.code, code)

    def test_the_exception_code_header_is_preferred_when_present(self):
        client, _ = make(ok(b"something unparseable", status=404, headers={"X-ClickHouse-Exception-Code": "81"}))
        with self.assertRaises(ClickHouseRejected) as ctx:
            client.query("SELECT 1 AS n")
        self.assertEqual(ctx.exception.code, 81)

    def test_a_client_error_without_a_code_has_code_none(self):
        client, _ = make(ok(b"Bad Request", status=400))
        with self.assertRaises(ClickHouseRejected) as ctx:
            client.query("SELECT 1 AS n")
        self.assertIsNone(ctx.exception.code)

    def test_an_exception_written_into_a_200_body_is_a_rejection(self):
        client, _ = make(ok(b"Code: 159. DB::Exception: Timeout exceeded (TIMEOUT_EXCEEDED)\n", status=200))
        with self.assertRaises(ClickHouseRejected) as ctx:
            client.query("SELECT 1 AS n")
        self.assertEqual(ctx.exception.code, 159)

    def test_redirects_and_other_statuses_are_rejections_and_never_followed(self):
        for status in (301, 302, 307, 100):
            with self.subTest(status=status):
                client, transport = make(ok(b"", status=status, headers={"Location": "http://evil.example/"}))
                with self.assertRaises(ClickHouseRejected):
                    client.query("SELECT 1 AS n")
                self.assertEqual(len(transport.requests), 1)

    def test_an_oversized_response_is_rejected_not_parsed(self):
        client, _ = make(ok(b'{"a":"' + b"x" * (5 * 1024 * 1024) + b'"}\n'))
        with self.assertRaises(ClickHouseRejected):
            client.query("SELECT 1 AS n")


class CredentialRedactionTest(unittest.TestCase):
    def assert_clean(self, text):
        self.assertNotIn(PASSWORD, text)
        self.assertNotIn("X-ClickHouse-Key", text)

    def test_no_error_text_reveals_the_password_or_the_server_body(self):
        body = b"Code: 497. DB::Exception: user agent_writer pw-SECRET-xyz-91 SELECT secret_column FROM t (ACCESS_DENIED)"
        scripted = [
            ok(body, status=403),
            ok(body, status=500),
            ConnectionRefusedError(f"cannot connect with {PASSWORD}"),
            ok(b"not json " + PASSWORD.encode()),
        ]
        for item in scripted:
            client, _ = make(item)
            with self.assertRaises((ClickHouseRejected, ClickHouseTransient)) as ctx:
                client.query("SELECT 1 AS n")
            for text in (str(ctx.exception), repr(ctx.exception), repr(ctx.exception.args)):
                self.assert_clean(text)
                self.assertNotIn("secret_column", text)
                self.assertNotIn("SELECT", text)

    def test_the_underlying_exception_text_is_not_chained_into_the_error(self):
        client, _ = make(ConnectionRefusedError(f"cannot connect with {PASSWORD}"))
        with self.assertRaises(ClickHouseTransient) as ctx:
            client.query("SELECT 1 AS n")
        self.assertIsNone(ctx.exception.__cause__)
        self.assertTrue(ctx.exception.__suppress_context__ or ctx.exception.__context__ is None)

    def test_the_client_repr_never_reveals_the_password(self):
        client, _ = make()
        for text in (repr(client), str(client)):
            self.assert_clean(text)
            self.assertIn("<redacted>", text)

    def test_credentials_embedded_in_the_url_are_rejected_without_echo(self):
        with self.assertRaises(ValueError) as ctx:
            ClickHouseClient("http://user:url-secret-7@clickhouse:8123", "signalforge", USER, PASSWORD, 5)
        self.assertNotIn("url-secret-7", str(ctx.exception))
        self.assertNotIn("user:", str(ctx.exception))

    def test_other_malformed_construction_is_rejected(self):
        for args in (("clickhouse:8123", "d", "u", "p", 5), ("ftp://clickhouse:8123", "d", "u", "p", 5),
                     ("http://", "d", "u", "p", 5), (URL, "", "u", "p", 5), (URL, "d", "", "p", 5),
                     (URL, "d", "u", "p", 0), (URL, "d", "u", "p", -1), (URL, "d", "u", "p", True), (URL, "d", "u", None, 5)):
            with self.subTest(args=args):
                with self.assertRaises(ValueError):
                    ClickHouseClient(*args)


class InsertTest(unittest.TestCase):
    def test_insert_emits_jsoneachrow_with_one_compact_line_per_row(self):
        client, transport = make(ok())
        rows = [{"a": 1, "b": "x", "c": "café"}, {"a": 2, "b": 'quote"and\\slash', "c": ""}]
        self.assertIsNone(client.insert("diagnoses", rows))
        body = transport.requests[0].body.decode("utf-8")
        head, _, data = body.partition("\n")
        self.assertEqual(head, "INSERT INTO diagnoses FORMAT JSONEachRow")
        lines = data.strip("\n").split("\n")
        self.assertEqual([json.loads(line) for line in lines], rows)
        self.assertIn("café", data)
        self.assertNotIn("\\u00e9", data)
        self.assertTrue(body.endswith("\n"))
        self.assertEqual(transport.requests[0].method, "POST")
        self.assertEqual(query_string(transport.requests[0]), {"database": ["signalforge"]})
        self.assertEqual(transport.requests[0].headers["X-ClickHouse-User"], USER)

    def test_a_multiline_value_stays_on_one_line_in_the_data(self):
        client, transport = make(ok())
        client.insert("diagnoses", [{"document": "line1\nline2"}])
        data = transport.requests[0].body.decode("utf-8").partition("\n")[2]
        self.assertEqual(len(data.strip("\n").split("\n")), 1)
        self.assertEqual(json.loads(data)["document"], "line1\nline2")

    def test_only_a_safe_literal_table_identifier_is_accepted(self):
        for table in ("signalforge.diagnoses", "diagnoses; DROP TABLE x", "diagnoses FORMAT", "", "Diagnoses", "1table",
                      "dia gnoses", "diagnoses--", "`diagnoses`", "dia\ngnoses", None, 5):
            with self.subTest(table=table):
                client, transport = make()
                with self.assertRaises((ValueError, TypeError)):
                    client.insert(table, [{"a": 1}])  # type: ignore[arg-type]
                self.assertEqual(transport.requests, [])

    def test_rows_must_be_a_non_empty_sequence_of_mappings(self):
        for rows in ([], (), None, "abc", [1], [["a"]], [{"a": 1}, "x"]):
            with self.subTest(rows=rows):
                client, transport = make()
                with self.assertRaises((ValueError, TypeError)):
                    client.insert("diagnoses", rows)  # type: ignore[arg-type]
                self.assertEqual(transport.requests, [])

    def test_a_row_that_cannot_be_serialized_is_a_type_error_and_sends_nothing(self):
        client, transport = make()
        with self.assertRaises(TypeError):
            client.insert("diagnoses", [{"a": object()}])
        self.assertEqual(transport.requests, [])

    def test_insert_failures_are_classified_like_query_failures(self):
        client, _ = make(ok(b"boom", status=503))
        with self.assertRaises(ClickHouseTransient):
            client.insert("diagnoses", [{"a": 1}])
        client, _ = make(ok(b"Code: 497. DB::Exception: no (ACCESS_DENIED)", status=403))
        with self.assertRaises(ClickHouseRejected) as ctx:
            client.insert("diagnoses", [{"a": 1}])
        self.assertEqual(ctx.exception.code, 497)
        client, _ = make(socket.timeout("t"))
        with self.assertRaises(ClickHouseTransient):
            client.insert("diagnoses", [{"a": 1}])

    def test_insert_text_contains_no_credentials(self):
        client, transport = make(ok())
        client.insert("diagnoses", [{"a": 1}])
        self.assertNotIn(PASSWORD, transport.requests[0].url)
        self.assertNotIn(PASSWORD, transport.requests[0].body.decode("utf-8"))


class _Handler(http.server.BaseHTTPRequestHandler):
    """A tiny real HTTP server so the default urllib transport is exercised without any mock."""

    seen = []
    behavior = {"status": 200, "body": b"", "sleep": 0.0, "headers": {}}

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        type(self).seen.append({"path": self.path, "headers": dict(self.headers), "body": body})
        behavior = type(self).behavior
        if behavior["sleep"]:
            threading.Event().wait(behavior["sleep"])
        try:
            self.send_response(behavior["status"])
            for key, value in behavior["headers"].items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(behavior["body"])))
            self.end_headers()
            self.wfile.write(behavior["body"])
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class DefaultTransportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        _Handler.seen = []
        _Handler.behavior = {"status": 200, "body": b'{"n":1}\n', "sleep": 0.0, "headers": {}}

    def client(self, timeout_s=5):
        return ClickHouseClient(f"http://127.0.0.1:{self.port}", "signalforge", USER, PASSWORD, timeout_s)

    def test_a_real_request_carries_the_statement_parameters_and_credential_headers(self):
        rows = self.client().query("SELECT {x:String} AS n", {"x": "v"})
        self.assertEqual(rows, [{"n": 1}])
        seen = _Handler.seen[0]
        self.assertEqual(seen["body"], b"SELECT {x:String} AS n\nFORMAT JSONEachRow")
        self.assertIn("database=signalforge", seen["path"])
        self.assertIn("param_x=v", seen["path"])
        received = {key.lower(): value for key, value in seen["headers"].items()}  # header names are case-insensitive
        self.assertEqual(received["x-clickhouse-user"], USER)
        self.assertEqual(received["x-clickhouse-key"], PASSWORD)
        self.assertNotIn(PASSWORD, seen["path"])

    def test_a_real_500_is_transient_and_a_real_404_is_a_rejection_with_its_code(self):
        _Handler.behavior.update(status=500, body=b"Code: 999. boom")
        with self.assertRaises(ClickHouseTransient):
            self.client().query("SELECT 1 AS n")
        _Handler.behavior.update(status=404, body=b"Code: 60. DB::Exception: no table (UNKNOWN_TABLE)")
        with self.assertRaises(ClickHouseRejected) as ctx:
            self.client().query("SELECT 1 AS n")
        self.assertEqual(ctx.exception.code, 60)

    def test_a_slow_server_hits_the_timeout_and_is_transient(self):
        _Handler.behavior.update(sleep=1.5)
        with self.assertRaises(ClickHouseTransient):
            self.client(timeout_s=0.3).query("SELECT 1 AS n")

    def test_a_closed_port_is_transient(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        client = ClickHouseClient(f"http://127.0.0.1:{port}", "signalforge", USER, PASSWORD, 2)
        with self.assertRaises(ClickHouseTransient):
            client.query("SELECT 1 AS n")

    def test_a_redirect_is_never_followed_and_credentials_are_never_forwarded(self):
        _Handler.behavior.update(status=302, body=b"", headers={"Location": f"http://127.0.0.1:{self.port}/elsewhere"})
        with self.assertRaises(ClickHouseRejected):
            self.client().query("SELECT 1 AS n")
        self.assertEqual(len(_Handler.seen), 1)

    def test_a_real_insert_sends_the_data_in_the_body(self):
        _Handler.behavior.update(body=b"")
        self.client().insert("diagnoses", [{"a": 1}])
        self.assertEqual(_Handler.seen[0]["body"], b'INSERT INTO diagnoses FORMAT JSONEachRow\n{"a":1}\n')


if __name__ == "__main__":
    unittest.main()
