"""Keep the model's prompt suggestions on screen while the user types, until the message is sent.

Open WebUI v0.13.3 fuzzy-searches the suggestions against the typed text and removes them when
nothing matches. The Acme start screen keeps every suggestion instead. The build fails when the
compiled filter is not found exactly once, so an Open WebUI upgrade cannot skip this silently.
"""

from pathlib import Path
import sys

FILTER = (
    "if(Q.length>500)m(H,[]);else{"
    "const W=Q.trim()&&e(ie)?e(ie).search(Q.trim()).map(E=>E.item):e(v);"
)
ALL_SUGGESTIONS = "{const W=e(v);"


def patch_source(source: str) -> str:
    """Return the chunk with the typed-text filter replaced by the full suggestion list."""
    if source.count(FILTER) != 1:
        raise ValueError("The Open WebUI suggestion filter was not found exactly once.")
    return source.replace(FILTER, ALL_SUGGESTIONS)


def patch_build(chunks: Path) -> Path:
    """Patch the one compiled chunk that holds the filter and drop its stale compressed copies."""
    matches = [path for path in sorted(chunks.glob("*.js")) if FILTER in path.read_text(encoding="utf-8")]
    if len(matches) != 1:
        raise ValueError(f"Expected one chunk with the suggestion filter, found {len(matches)}.")
    chunk = matches[0]
    chunk.write_text(patch_source(chunk.read_text(encoding="utf-8")), encoding="utf-8")
    for suffix in (".gz", ".br"):
        chunk.with_name(chunk.name + suffix).unlink(missing_ok=True)
    return chunk


if __name__ == "__main__":
    print(f"Kept suggestions while typing: {patch_build(Path(sys.argv[1])).name}")
