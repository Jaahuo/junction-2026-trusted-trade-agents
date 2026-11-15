import json
from pathlib import Path
import sys

TOOLS = ("get_order_status", "get_mandate", "list_pending_approvals")
CONTEXT = 'se=`${o().server_id}: ${$}\n${JSON.stringify(Z??{},null,2)}`;'
CONFIRM = 'if(!await y(n().t("Tool call"),se,ae))throw new Error("Tool call cancelled");'
ORIGINAL = CONTEXT + CONFIRM
TRUSTED = 'o().server_id==="trusted-trade"&&' + json.dumps(TOOLS) + '.includes($)'
REPLACEMENT = CONTEXT + CONFIRM.replace('if(!await', f'if(!({TRUSTED})&&!await')


def patch_source(source: str) -> str:
    if source.count(ORIGINAL) != 1:
        raise ValueError("The Open WebUI app tool confirmation was not found exactly once.")
    return source.replace(ORIGINAL, REPLACEMENT)


def patch_build(chunks: Path) -> Path:
    matches = [path for path in sorted(chunks.glob("*.js")) if ORIGINAL in path.read_text(encoding="utf-8")]
    if len(matches) != 1:
        raise ValueError(f"Expected one chunk with the app tool confirmation, found {len(matches)}.")
    chunk = matches[0]
    chunk.write_text(patch_source(chunk.read_text(encoding="utf-8")), encoding="utf-8")
    for suffix in (".gz", ".br"):
        chunk.with_name(chunk.name + suffix).unlink(missing_ok=True)
    return chunk


if __name__ == "__main__":
    print(f"Trusted read-only app tools: {patch_build(Path(sys.argv[1])).name}")
