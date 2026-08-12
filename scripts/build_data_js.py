#!/usr/bin/env python3
# build_data_js.py - inline the static data JSON files into classic <script>
# files so the page works from file:// (browsers block fetch() on local files,
# but classic <script> tags load fine). Regenerate whenever data/*.json change:
#   python3 scripts/build_data_js.py
#
# Outputs two files:
#   * data/data.js  - regions + measured matrices (small, needed at boot)
#   * data/world.js - the world-atlas TopoJSON (~108KB, not needed until the
#                     map's landmass renders, so it loads asynchronously)
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

CORE_FILES = [
    ("measured", "locations_measured.json"),
    ("regions", "regions.json"),
]
WORLD_FILES = [
    ("world", "countries-110m.json"),
]

def emit(dest, files, prune=None):
    lines = ["(function(){", "var D=window.VML_DATA=window.VML_DATA||{};"]
    for var, fname in files:
        with open(os.path.join(DATA, fname)) as f:
            raw = f.read()
        # compact the JSON (the pretty-printed sources are kept for humans)
        obj = json.loads(raw)
        if prune and callable(prune):
            obj = prune(obj)
        lines.append("D.%s=%s;" % (var, json.dumps(obj, separators=(",", ":"))))
    lines.append("document.dispatchEvent(new Event('vml-" + os.path.splitext(dest)[0] + "'));")
    lines.append("})();")
    with open(os.path.join(DATA, dest), "w") as f:
        f.write("".join(lines) + "\n")
    print("wrote %s" % os.path.join(DATA, dest))

def prune_world(obj):
    # only `objects.countries` is used (the map draws land from it); the `land`
    # object just duplicates the arcs and is never referenced
    if "objects" in obj and "land" in obj.get("objects", {}):
        del obj["objects"]["land"]
    return obj

def main():
    emit("data.js", CORE_FILES)
    emit("world.js", WORLD_FILES, prune=prune_world)

if __name__ == "__main__":
    main()
