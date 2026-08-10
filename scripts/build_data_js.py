#!/usr/bin/env python3
# build_data_js.py - inline the static data JSON files into data/data.js so the
# page works from file:// (browsers block fetch() on local files, but classic
# <script> tags load fine). Regenerate whenever data/*.json change:
#   python3 scripts/build_data_js.py
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

FILES = [
    ("measured", "locations_measured.json"),
    ("regions", "regions.json"),
    ("world", "countries-110m.json"),
]

def main():
    lines = ["(function () {", "  var D = window.VML_DATA = window.VML_DATA || {};"]
    for var, fname in FILES:
        with open(os.path.join(DATA, fname)) as f:
            raw = f.read()
        json.loads(raw)
        lines.append("  D.%s = %s;" % (var, raw))
    lines.append("})();")
    with open(os.path.join(DATA, "data.js"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote %s" % os.path.join(DATA, "data.js"))

if __name__ == "__main__":
    main()
