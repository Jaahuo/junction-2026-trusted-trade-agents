from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import trust_app_reads as trust

HANDLER = """async function call(server, name, accept) {
const o=()=>({server_id:server}), $=name, Z={orderId:"ord_test"}, ae=new AbortController().signal;
const n=()=>({t:value=>value}); let confirmations=0;
const y=async()=>{confirmations++; return accept};
const """ + trust.ORIGINAL + """
return {confirmations, name:$, arguments:Z};
}
"""


class TrustAppReadsTests(unittest.TestCase):
    def test_only_named_reads_from_the_trusted_server_skip_confirmation(self):
        source = trust.patch_source(HANDLER) + """
import assert from 'node:assert/strict';
for (const name of ['get_order_status', 'get_mandate', 'list_pending_approvals']) {
  assert.deepEqual(await call('trusted-trade', name, false), {
    confirmations:0, name, arguments:{orderId:'ord_test'}
  });
}
for (const [server, name] of [
  ['other-server','get_order_status'], ['trusted-trade-copy','get_mandate'],
  ['trusted-trade','decide_approval'], ['trusted-trade','register_mandate'],
  ['trusted-trade','revoke_mandate'], ['trusted-trade','place_order'],
  ['trusted-trade','unknown_read'], ['trusted-trade','get_order_status_extra']
]) {
  await assert.rejects(call(server, name, false), /Tool call cancelled/);
  assert.deepEqual(await call(server, name, true), {
    confirmations:1, name, arguments:{orderId:'ord_test'}
  });
}
"""
        result = subprocess.run(["bun", "--eval", source], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_upstream_change_or_duplicate_fails_closed(self):
        for source in ("", HANDLER.replace('Tool call', 'Changed'), HANDLER + HANDLER):
            with self.subTest(source=source), self.assertRaises(ValueError):
                trust.patch_source(source)

    def test_build_removes_stale_compressed_chunks_and_rejects_repatching(self):
        with tempfile.TemporaryDirectory() as directory:
            chunks = Path(directory)
            target = chunks / "app.js"
            target.write_text(HANDLER, encoding="utf-8")
            for suffix in (".gz", ".br"):
                target.with_name(target.name + suffix).write_bytes(b"stale")
            trust.patch_build(chunks)
            self.assertFalse(target.with_name("app.js.gz").exists())
            self.assertFalse(target.with_name("app.js.br").exists())
            with self.assertRaises(ValueError):
                trust.patch_build(chunks)


if __name__ == "__main__":
    unittest.main()
