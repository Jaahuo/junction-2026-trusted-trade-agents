from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import keep_suggestions as keep

CHUNK = "const xe=Q=>{" + keep.FILTER + "Z(e(H),W)||m(H,W)}};"


class KeepSuggestionsTests(unittest.TestCase):
    def test_typed_text_no_longer_filters_the_suggestions(self):
        patched = keep.patch_source(CHUNK)
        self.assertNotIn(".search(", patched)
        self.assertIn("{const W=e(v);Z(e(H),W)||m(H,W)}", patched)

    def test_a_changed_open_webui_build_fails_instead_of_skipping(self):
        with self.assertRaises(ValueError):
            keep.patch_source("const xe=Q=>{}")
        with self.assertRaises(ValueError):
            keep.patch_source(CHUNK + CHUNK)

    def test_the_build_patches_one_chunk_and_drops_its_compressed_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            chunks = Path(directory)
            (chunks / "other.js").write_text("const a=1;", encoding="utf-8")
            target = chunks / "target.js"
            target.write_text(CHUNK, encoding="utf-8")
            (chunks / "target.js.gz").write_bytes(b"stale")
            (chunks / "target.js.br").write_bytes(b"stale")

            self.assertEqual(keep.patch_build(chunks), target)
            self.assertNotIn(".search(", target.read_text(encoding="utf-8"))
            self.assertFalse((chunks / "target.js.gz").exists())
            self.assertFalse((chunks / "target.js.br").exists())

    def test_the_build_fails_when_no_chunk_holds_the_filter(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "other.js").write_text("const a=1;", encoding="utf-8")
            with self.assertRaises(ValueError):
                keep.patch_build(Path(directory))


if __name__ == "__main__":
    unittest.main()
