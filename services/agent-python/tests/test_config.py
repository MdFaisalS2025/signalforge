import dataclasses
import os
import unittest

from signalforge_agent.config import AgentConfig, ConfigError, load

BASE = {
    "CLICKHOUSE_URL": "http://clickhouse:8123",
    "CLICKHOUSE_USER": "agent_writer",
    "CLICKHOUSE_PASSWORD": "pw-secret-1",
}

PROVIDER = {
    "AGENT_PROVIDER": "openai-compatible",
    "AGENT_PROVIDER_BASE_URL": "https://api.example.test/v1",
    "AGENT_PROVIDER_MODEL": "some-model",
    "AGENT_PROVIDER_API_KEY": "key-secret-2",
    "AGENT_PROVIDER_ALLOW_EXTERNAL": "yes",
}


def env(**overrides):
    merged = dict(BASE)
    merged.update(overrides)
    return merged


def provider_env(**overrides):
    merged = dict(BASE)
    merged.update(PROVIDER)
    merged.update(overrides)
    return merged


class DefaultsTest(unittest.TestCase):
    def test_defaults(self):
        cfg = load(BASE)
        self.assertEqual(cfg.clickhouse_url, "http://clickhouse:8123")
        self.assertEqual(cfg.database, "signalforge")
        self.assertEqual(cfg.user, "agent_writer")
        self.assertEqual(cfg.password, "pw-secret-1")
        self.assertEqual(cfg.poll_interval_s, 2)
        self.assertEqual(cfg.batch_size, 5)
        self.assertEqual(cfg.revision_policy, "first-only")
        self.assertEqual(cfg.heartbeat_path, "/tmp/agent-heartbeat")
        self.assertEqual(cfg.provider, "deterministic")
        self.assertIsNone(cfg.provider_base_url)
        self.assertIsNone(cfg.provider_model)
        self.assertIsNone(cfg.provider_api_key)
        self.assertFalse(cfg.provider_allow_external)
        self.assertEqual(cfg.provider_timeout_s, 20)

    def test_explicit_values_are_used(self):
        cfg = load(
            env(
                CLICKHOUSE_DATABASE="other",
                AGENT_POLL_INTERVAL_S="7",
                AGENT_BATCH_SIZE="9",
                AGENT_REVISION_POLICY="on-analyzer-change",
                AGENT_HEARTBEAT_PATH="/tmp/hb",
            )
        )
        self.assertEqual(
            (cfg.database, cfg.poll_interval_s, cfg.batch_size, cfg.revision_policy, cfg.heartbeat_path),
            ("other", 7, 9, "on-analyzer-change", "/tmp/hb"),
        )

    def test_empty_optional_values_fall_back_to_defaults(self):
        # Compose passes an empty string for an unset ${VAR:-} reference.
        cfg = load(
            env(
                AGENT_POLL_INTERVAL_S="",
                AGENT_BATCH_SIZE="",
                AGENT_REVISION_POLICY="",
                AGENT_PROVIDER="",
                AGENT_PROVIDER_BASE_URL="",
                AGENT_PROVIDER_MODEL="",
                AGENT_PROVIDER_API_KEY="",
                AGENT_PROVIDER_ALLOW_EXTERNAL="",
            )
        )
        self.assertEqual((cfg.poll_interval_s, cfg.batch_size), (2, 5))
        self.assertEqual((cfg.revision_policy, cfg.provider), ("first-only", "deterministic"))

    def test_fields_are_exactly_the_specified_interface(self):
        names = [f.name for f in dataclasses.fields(AgentConfig)]
        self.assertEqual(
            names,
            [
                "clickhouse_url",
                "database",
                "user",
                "password",
                "poll_interval_s",
                "batch_size",
                "revision_policy",
                "heartbeat_path",
                "provider",
                "provider_base_url",
                "provider_model",
                "provider_api_key",
                "provider_allow_external",
                "provider_timeout_s",
            ],
        )


class RequiredTest(unittest.TestCase):
    def test_missing_required_variables_are_rejected_by_name(self):
        for name in ("CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD"):
            with self.subTest(name=name):
                missing = {k: v for k, v in BASE.items() if k != name}
                with self.assertRaises(ConfigError) as ctx:
                    load(missing)
                self.assertEqual(ctx.exception.variable, name)
                self.assertIn(name, str(ctx.exception))

    def test_empty_required_variables_are_rejected(self):
        for name in ("CLICKHOUSE_URL", "CLICKHOUSE_USER", "CLICKHOUSE_PASSWORD"):
            with self.subTest(name=name):
                with self.assertRaises(ConfigError) as ctx:
                    load(env(**{name: ""}))
                self.assertEqual(ctx.exception.variable, name)

    def test_clickhouse_url_must_be_http_with_a_host_and_no_credentials(self):
        for bad in ("clickhouse:8123", "ftp://clickhouse:8123", "http://", "not a url"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as ctx:
                    load(env(CLICKHOUSE_URL=bad))
                self.assertEqual(ctx.exception.variable, "CLICKHOUSE_URL")
        with self.assertRaises(ConfigError) as ctx:
            load(env(CLICKHOUSE_URL="http://user:url-secret-3@clickhouse:8123"))
        self.assertEqual(ctx.exception.variable, "CLICKHOUSE_URL")
        self.assertNotIn("url-secret-3", str(ctx.exception))
        self.assertEqual(
            load(env(CLICKHOUSE_URL="https://ch.example.test:8443")).clickhouse_url,
            "https://ch.example.test:8443",
        )


class BoundsTest(unittest.TestCase):
    def test_poll_interval_accepts_only_1_to_60(self):
        self.assertEqual(load(env(AGENT_POLL_INTERVAL_S="1")).poll_interval_s, 1)
        self.assertEqual(load(env(AGENT_POLL_INTERVAL_S="60")).poll_interval_s, 60)
        for bad in ("0", "61", "-1", "abc", "2.5", " 2", "+2", "1e1", "٢"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as ctx:
                    load(env(AGENT_POLL_INTERVAL_S=bad))
                self.assertEqual(ctx.exception.variable, "AGENT_POLL_INTERVAL_S")

    def test_batch_size_accepts_only_1_to_20(self):
        self.assertEqual(load(env(AGENT_BATCH_SIZE="1")).batch_size, 1)
        self.assertEqual(load(env(AGENT_BATCH_SIZE="20")).batch_size, 20)
        for bad in ("0", "21", "-5", "many", "5.0"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as ctx:
                    load(env(AGENT_BATCH_SIZE=bad))
                self.assertEqual(ctx.exception.variable, "AGENT_BATCH_SIZE")

    def test_unknown_revision_policy_is_rejected(self):
        for bad in ("always", "First-Only", "on_analyzer_change"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as ctx:
                    load(env(AGENT_REVISION_POLICY=bad))
                self.assertEqual(ctx.exception.variable, "AGENT_REVISION_POLICY")

    def test_unknown_provider_is_rejected(self):
        with self.assertRaises(ConfigError) as ctx:
            load(env(AGENT_PROVIDER="anthropic"))
        self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER")

    def test_provider_timeout_accepts_only_1_to_120(self):
        self.assertEqual(load(provider_env(AGENT_PROVIDER_TIMEOUT_S="1")).provider_timeout_s, 1)
        self.assertEqual(load(provider_env(AGENT_PROVIDER_TIMEOUT_S="120")).provider_timeout_s, 120)
        for bad in ("0", "121", "x"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as ctx:
                    load(provider_env(AGENT_PROVIDER_TIMEOUT_S=bad))
                self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_TIMEOUT_S")


class ProviderTest(unittest.TestCase):
    def test_openai_compatible_requires_base_url_and_model(self):
        for name in ("AGENT_PROVIDER_BASE_URL", "AGENT_PROVIDER_MODEL"):
            with self.subTest(name=name):
                missing = {k: v for k, v in provider_env().items() if k != name}
                with self.assertRaises(ConfigError) as ctx:
                    load(missing)
                self.assertEqual(ctx.exception.variable, name)
                with self.assertRaises(ConfigError) as ctx:
                    load(provider_env(**{name: ""}))
                self.assertEqual(ctx.exception.variable, name)

    def test_a_valid_external_provider_is_accepted(self):
        cfg = load(provider_env(AGENT_PROVIDER_TIMEOUT_S="30"))
        self.assertEqual(cfg.provider, "openai-compatible")
        self.assertEqual(cfg.provider_base_url, "https://api.example.test/v1")
        self.assertEqual(cfg.provider_model, "some-model")
        self.assertEqual(cfg.provider_api_key, "key-secret-2")
        self.assertTrue(cfg.provider_allow_external)
        self.assertEqual(cfg.provider_timeout_s, 30)

    def test_http_to_a_non_local_host_is_rejected(self):
        with self.assertRaises(ConfigError) as ctx:
            load(provider_env(AGENT_PROVIDER_BASE_URL="http://api.example.test/v1"))
        self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_BASE_URL")

    def test_local_http_hosts_are_allowed_without_a_key_or_consent(self):
        for url in ("http://localhost:8000", "http://host.docker.internal:8000", "http://127.0.0.1:8000/v1"):
            with self.subTest(url=url):
                cfg = load(
                    env(
                        AGENT_PROVIDER="openai-compatible",
                        AGENT_PROVIDER_BASE_URL=url,
                        AGENT_PROVIDER_MODEL="local-model",
                    )
                )
                self.assertEqual(cfg.provider_base_url, url)
                self.assertIsNone(cfg.provider_api_key)
                self.assertFalse(cfg.provider_allow_external)

    def test_a_local_host_may_still_carry_a_key(self):
        cfg = load(
            env(
                AGENT_PROVIDER="openai-compatible",
                AGENT_PROVIDER_BASE_URL="http://localhost:8000",
                AGENT_PROVIDER_MODEL="local-model",
                AGENT_PROVIDER_API_KEY="key-secret-2",
            )
        )
        self.assertEqual(cfg.provider_api_key, "key-secret-2")

    def test_lookalike_hosts_are_not_local(self):
        for url in (
            "http://localhost.example.test:8000",
            "http://127.0.0.1.example.test",
            "http://localhost@evil.example.test",
            "http://notlocalhost:8000",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ConfigError) as ctx:
                    load(
                        env(
                            AGENT_PROVIDER="openai-compatible",
                            AGENT_PROVIDER_BASE_URL=url,
                            AGENT_PROVIDER_MODEL="m",
                        )
                    )
                self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_BASE_URL")

    def test_credentials_in_the_provider_url_are_rejected_without_echoing_them(self):
        with self.assertRaises(ConfigError) as ctx:
            load(provider_env(AGENT_PROVIDER_BASE_URL="https://user:url-secret-4@api.example.test/v1"))
        self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_BASE_URL")
        self.assertNotIn("url-secret-4", str(ctx.exception))

    def test_non_local_https_requires_explicit_consent(self):
        omitted = provider_env()
        del omitted["AGENT_PROVIDER_ALLOW_EXTERNAL"]
        candidates = {"omitted": omitted, "no": provider_env(AGENT_PROVIDER_ALLOW_EXTERNAL="no"), "empty": provider_env(AGENT_PROVIDER_ALLOW_EXTERNAL="")}
        for label, config in candidates.items():
            with self.subTest(label=label):
                with self.assertRaises(ConfigError) as ctx:
                    load(config)
                self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_ALLOW_EXTERNAL")
        for bad in ("true", "YES", "1"):
            with self.subTest(bad=bad):
                with self.assertRaises(ConfigError) as ctx:
                    load(provider_env(AGENT_PROVIDER_ALLOW_EXTERNAL=bad))
                self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_ALLOW_EXTERNAL")

    def test_non_local_provider_requires_an_api_key(self):
        merged = provider_env()
        del merged["AGENT_PROVIDER_API_KEY"]
        with self.assertRaises(ConfigError) as ctx:
            load(merged)
        self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_API_KEY")
        with self.assertRaises(ConfigError) as ctx:
            load(provider_env(AGENT_PROVIDER_API_KEY=""))
        self.assertEqual(ctx.exception.variable, "AGENT_PROVIDER_API_KEY")

    def test_deterministic_ignores_invalid_provider_variables(self):
        cfg = load(
            env(
                AGENT_PROVIDER="deterministic",
                AGENT_PROVIDER_BASE_URL="http://evil.example.test",
                AGENT_PROVIDER_MODEL="",
                AGENT_PROVIDER_API_KEY="key-secret-2",
                AGENT_PROVIDER_ALLOW_EXTERNAL="banana",
                AGENT_PROVIDER_TIMEOUT_S="999",
            )
        )
        self.assertEqual(cfg.provider, "deterministic")
        self.assertIsNone(cfg.provider_base_url)
        self.assertIsNone(cfg.provider_model)
        self.assertIsNone(cfg.provider_api_key)
        self.assertFalse(cfg.provider_allow_external)
        self.assertEqual(cfg.provider_timeout_s, 20)

    def test_omitted_provider_is_deterministic_and_ignores_provider_variables(self):
        cfg = load(env(AGENT_PROVIDER_BASE_URL="http://evil.example.test", AGENT_PROVIDER_API_KEY="key-secret-2"))
        self.assertEqual(cfg.provider, "deterministic")
        self.assertIsNone(cfg.provider_api_key)


class SecrecyTest(unittest.TestCase):
    def test_error_messages_name_the_variable_but_never_repeat_a_value(self):
        sentinel = "SENTINEL-value-9"
        cases = [
            ("AGENT_POLL_INTERVAL_S", env(AGENT_POLL_INTERVAL_S=sentinel)),
            ("AGENT_BATCH_SIZE", env(AGENT_BATCH_SIZE=sentinel)),
            ("AGENT_REVISION_POLICY", env(AGENT_REVISION_POLICY=sentinel)),
            ("AGENT_PROVIDER", env(AGENT_PROVIDER=sentinel)),
            ("CLICKHOUSE_URL", env(CLICKHOUSE_URL=sentinel)),
            ("AGENT_PROVIDER_BASE_URL", provider_env(AGENT_PROVIDER_BASE_URL=sentinel)),
            ("AGENT_PROVIDER_ALLOW_EXTERNAL", provider_env(AGENT_PROVIDER_ALLOW_EXTERNAL=sentinel)),
            ("AGENT_PROVIDER_TIMEOUT_S", provider_env(AGENT_PROVIDER_TIMEOUT_S=sentinel)),
        ]
        for name, config in cases:
            with self.subTest(name=name):
                with self.assertRaises(ConfigError) as ctx:
                    load(config)
                message = str(ctx.exception)
                self.assertIn(name, message)
                self.assertNotIn(sentinel, message)
                self.assertNotIn(sentinel, repr(ctx.exception))

    def test_errors_never_contain_the_password_or_key_even_when_another_value_is_bad(self):
        with self.assertRaises(ConfigError) as ctx:
            load(provider_env(AGENT_POLL_INTERVAL_S="0"))
        for secret in ("pw-secret-1", "key-secret-2"):
            self.assertNotIn(secret, str(ctx.exception))
            self.assertNotIn(secret, repr(ctx.exception))

    def test_repr_and_str_redact_both_secrets(self):
        cfg = load(provider_env())
        for text in (repr(cfg), str(cfg), f"{cfg}", "%r" % (cfg,)):
            self.assertNotIn("pw-secret-1", text)
            self.assertNotIn("key-secret-2", text)
            self.assertIn("agent_writer", text, "non-secret fields stay visible")

    def test_repr_uses_a_fixed_marker_whether_or_not_a_key_is_set(self):
        with_key = repr(load(provider_env()))
        without_key = repr(load(BASE))
        self.assertIn("<redacted>", with_key)
        self.assertIn("<redacted>", without_key)


class PurityTest(unittest.TestCase):
    def test_config_is_frozen(self):
        cfg = load(BASE)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            cfg.batch_size = 99  # type: ignore[misc]
        with self.assertRaises(dataclasses.FrozenInstanceError):
            cfg.password = "other"  # type: ignore[misc]

    def test_load_reads_only_the_mapping_it_is_given(self):
        before = dict(os.environ)
        os.environ["CLICKHOUSE_URL"] = "http://from-process-environment:8123"
        try:
            self.assertEqual(load(BASE).clickhouse_url, "http://clickhouse:8123")
            with self.assertRaises(ConfigError):
                load({})
        finally:
            os.environ.clear()
            os.environ.update(before)


if __name__ == "__main__":
    unittest.main()
