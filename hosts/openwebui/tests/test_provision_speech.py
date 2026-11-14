import contextlib
import copy
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import provision_speech as speech

KEY = "invented-elevenlabs-key"


def stored_config():
    return {
        "tts": {
            "OPENAI_API_BASE_URL": "https://inference.example.invalid/v1", "OPENAI_API_KEY": "invented-inference-key",
            "OPENAI_PARAMS": {}, "API_KEY": "", "ENGINE": "", "MODEL": "tts-1", "VOICE": "alloy",
            "REALTIME_TTS_PROMPT_TEMPLATE": None, "SPLIT_ON": "punctuation",
            "AZURE_SPEECH_REGION": "", "AZURE_SPEECH_BASE_URL": "",
            "AZURE_SPEECH_OUTPUT_FORMAT": "audio-24khz-160kbitrate-mono-mp3",
            "MISTRAL_API_KEY": "", "MISTRAL_API_BASE_URL": "https://api.mistral.ai/v1",
        },
        "stt": {"ENGINE": "", "MODEL": "", "WHISPER_MODEL": "base", "ALLOWED_EXTENSIONS": ["mp3", "wav"]},
        "realtime": {"ENABLED": False},
    }


class ProvisionSpeechTests(unittest.TestCase):
    def configure(self, key, config):
        self.config = config
        self.writes = []
        self.output = io.StringIO()

        def request(path, payload=None, token=None, *, allow_missing=False, timeout=60):
            if path == "/api/v1/audio/config":
                return copy.deepcopy(self.config)
            self.writes.append((path, copy.deepcopy(payload), token, timeout))
            for section in ("tts", "stt"):
                self.config[section].update(payload[section])
            return copy.deepcopy(self.config)

        with patch.dict(os.environ, {"ELEVENLABS_API_KEY": key}), contextlib.redirect_stdout(self.output):
            speech.configure(request, "invented-session")

    def test_without_a_key_the_audio_settings_are_not_read_or_changed(self):
        self.configure("  ", None)
        self.assertEqual(self.writes, [])
        self.assertEqual(self.output.getvalue(), "")

    def test_an_existing_volume_gets_elevenlabs_and_keeps_local_speech_to_text(self):
        before = stored_config()
        self.configure(KEY, copy.deepcopy(before))
        self.assertEqual(len(self.writes), 1)
        path, payload, token, timeout = self.writes[0]
        self.assertEqual(path, "/api/v1/audio/config/update")
        self.assertEqual(token, "invented-session")
        self.assertGreater(timeout, 60)
        self.assertEqual(payload["stt"], before["stt"])
        self.assertNotIn("realtime", payload)
        self.assertEqual(payload["tts"], {
            **before["tts"],
            "ENGINE": "elevenlabs", "API_KEY": KEY,
            "MODEL": "eleven_multilingual_v2", "VOICE": "EXAVITQu4vr4xnSDxMaL",
        })

    def test_a_second_run_changes_nothing(self):
        self.configure(KEY, stored_config())
        self.writes.clear()
        self.configure(KEY, self.config)
        self.assertEqual(self.writes, [])

    def test_a_rotated_key_replaces_the_stored_key(self):
        self.configure(KEY, stored_config())
        self.configure("invented-rotated-key", self.config)
        self.assertEqual(self.writes[0][1]["tts"]["API_KEY"], "invented-rotated-key")

    def test_the_key_is_never_printed(self):
        self.configure(KEY, stored_config())
        self.assertNotIn(KEY, self.output.getvalue())
        self.configure(KEY, self.config)
        self.assertNotIn(KEY, self.output.getvalue())


if __name__ == "__main__":
    unittest.main()
