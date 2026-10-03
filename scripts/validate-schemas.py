#!/usr/bin/env python3
"""Validate contract samples against their schemas.

- contracts/events/samples/*.sample.json must validate. A sample named
  "<base>.<variant>.sample.json" (for example telemetry_event.metric.sample.json) validates
  against contracts/events/<base>.schema.json.
- contracts/events/samples/invalid/*.json must FAIL validation against the schema named by
  the part of the file name before the first dot. A sample that passes is an error, because
  it shows the contract no longer rejects a case it must reject.

Usage: python scripts/validate-schemas.py
"""
import json
import sys
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parent.parent
EVENTS_DIR = ROOT / "contracts" / "events"
SAMPLES_DIR = EVENTS_DIR / "samples"
INVALID_DIR = SAMPLES_DIR / "invalid"


def schema_for(file_name: str) -> Path:
    base = file_name.split(".")[0]
    return EVENTS_DIR / f"{base}.schema.json"


def load_schema(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    failures = []

    valid_samples = sorted(SAMPLES_DIR.glob("*.sample.json"))
    invalid_samples = sorted(INVALID_DIR.glob("*.json"))
    if not valid_samples:
        print("No valid sample files found in", SAMPLES_DIR)
        return 1
    if not invalid_samples:
        print("No invalid sample files found in", INVALID_DIR)
        return 1

    for sample_path in valid_samples:
        schema_path = schema_for(sample_path.name)
        if not schema_path.exists():
            failures.append(f"{sample_path.name}: no matching schema {schema_path.name}")
            continue
        instance = json.loads(sample_path.read_text(encoding="utf-8"))
        try:
            jsonschema.validate(instance=instance, schema=load_schema(schema_path))
            print(f"OK   {sample_path.name} validates against {schema_path.name}")
        except jsonschema.ValidationError as exc:
            failures.append(f"{sample_path.name}: {exc.message}")

    for sample_path in invalid_samples:
        schema_path = schema_for(sample_path.name)
        if not schema_path.exists():
            failures.append(f"{sample_path.name}: no matching schema {schema_path.name}")
            continue
        instance = json.loads(sample_path.read_text(encoding="utf-8"))
        try:
            jsonschema.validate(instance=instance, schema=load_schema(schema_path))
            failures.append(f"{sample_path.name}: invalid sample was accepted by {schema_path.name}")
        except jsonschema.ValidationError as exc:
            print(f"OK   {sample_path.name} rejected as expected: {exc.message}")

    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(" -", failure)
        return 1

    print(
        f"\nAll {len(valid_samples)} valid samples validate and "
        f"all {len(invalid_samples)} invalid samples are rejected."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
