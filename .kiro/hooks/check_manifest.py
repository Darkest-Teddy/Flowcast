#!/usr/bin/env python3
"""Hook: report saved snapshots whose checksum no longer matches output/manifest.json.

build_map_data.py refuses to run on a mismatch, so catching it right after an edit saves a
confusing failure later. Prints nothing when everything matches.
"""
import hashlib
import json
from pathlib import Path

output = Path(__file__).resolve().parents[2] / "data-pipeline" / "output"
manifest = json.loads((output / "manifest.json").read_text())
for item in manifest.get("datasets", []):
    path = output / item["path"]
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
        print(f"Snapshot {item['path']} changed but manifest.json still has the old checksum; update its entry.")
