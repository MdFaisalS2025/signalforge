#!/usr/bin/env python3
"""Validate each sample event in contracts/events/samples against its schema.

Usage: python3 scripts/validate-schemas.py
"""
import json
import sys
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parent.parent
EVENTS_DIR = ROOT / "contracts" / "events"
SAMPLES_DIR = EVENTS_DIR / "samples"


def main() -> int:
    failures = []
    samples = sorted(SAMPLES_DIR.glob("*.sample.json"))
    if not samples:
        print("No sample files found in", SAMPLES_DIR)
        return 1

    for sample_path in samples:
        schema_name = sample_path.name.replace(".sample.json", ".schema.json")
        schema_path = EVENTS_DIR / schema_name
        if not schema_path.exists():
            failures.append(f"{sample_path.name}: no matching schema {schema_name}")
            continue

        schema = json.loads(schema_path.read_text())
        instance = json.loads(sample_path.read_text())

        try:
            jsonschema.validate(instance=instance, schema=schema)
            print(f"OK   {sample_path.name} validates against {schema_name}")
        except jsonschema.ValidationError as exc:
            failures.append(f"{sample_path.name}: {exc.message}")

    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(" -", failure)
        return 1

    print(f"\nAll {len(samples)} sample events validate against their schemas.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
