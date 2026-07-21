#!/usr/bin/env python3
"""Print AGP versions that have not been imported yet."""

from __future__ import annotations

import argparse
import re
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


METADATA_URL = (
    "https://dl.google.com/dl/android/maven2/"
    "com/android/tools/build/gradle/maven-metadata.xml"
)
AGP_VERSION = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(\d+))?$"
)
QUALIFIER_ORDER = {"alpha": 0, "beta": 1, "rc": 2, None: 3}


def version_key(version: str) -> tuple[int, int, int, int, int]:
    match = AGP_VERSION.fullmatch(version)
    if not match:
        raise ValueError(f"Invalid AGP version: {version}")
    major, minor, patch, qualifier, qualifier_number = match.groups()
    return (
        int(major),
        int(minor),
        int(patch),
        QUALIFIER_ORDER[qualifier],
        int(qualifier_number or 0),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default="3.0.0-alpha1")
    parser.add_argument("--state-file", default=".agp-version")
    args = parser.parse_args()

    state_file = Path(args.state_file)
    current = state_file.read_text().strip() if state_file.exists() else None
    lower_bound = version_key(current or args.baseline)

    with urllib.request.urlopen(METADATA_URL, timeout=30) as response:
        root = ET.fromstring(response.read())

    versions = {
        node.text
        for node in root.findall("./versioning/versions/version")
        if node.text and AGP_VERSION.fullmatch(node.text)
    }
    pending = sorted(
        (
            version
            for version in versions
            if version_key(version) > lower_bound
            or (current is None and version_key(version) == lower_bound)
        ),
        key=version_key,
    )
    print(" ".join(pending))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
