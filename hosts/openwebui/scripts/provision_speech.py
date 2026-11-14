import os

MODEL = "eleven_multilingual_v2"
# Premade voice "Sarah": free ElevenLabs plans return 402 for voice-library voices.
VOICE = "EXAVITQu4vr4xnSDxMaL"


def configure(request, token):
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        return
    config = request("/api/v1/audio/config", token=token)
    wanted = {"ENGINE": "elevenlabs", "API_KEY": key, "MODEL": MODEL, "VOICE": VOICE}
    tts = config["tts"]
    if all(tts.get(name) == value for name, value in wanted.items()):
        print("Text to speech: ElevenLabs is already configured.")
        return
    # Open WebUI reloads local Whisper when speech-to-text stays local, which can take minutes.
    request("/api/v1/audio/config/update", {"tts": {**tts, **wanted}, "stt": config["stt"]}, token, timeout=300)
    print(f"Text to speech: ElevenLabs {MODEL}, premade voice Sarah. Speech to text is unchanged.")
