"""
音声生成モジュール

Gemini TTS または OpenAI TTS でスクリプトをMP3音声ファイルに変換する。
provider 設定で切替可能。長いスクリプトは自然な区切りでチャンク分割して連結する。
"""

import io
import os
import logging
import re
import time
import wave
from pathlib import Path
from typing import List

logger = logging.getLogger(__name__)

# Geminiの503/429に対するリトライ設定（指数バックオフ）
GEMINI_RETRY_DELAYS = [10, 30, 60, 120, 240]  # 計 7分40秒 まで待つ

# pydub に imageio-ffmpeg 同梱の ffmpeg バイナリを使わせる
# （Render等のサーバにffmpegが入っていなくても動くようにするため）
try:
    import imageio_ffmpeg
    from pydub import AudioSegment as _AS
    _AS.converter = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    pass

# TTS の1リクエストあたり最大文字数
# Gemini TTS は長文で後半が早口/機械化する現象があるため、短めに分割して品質を均一に保つ。
# OpenAI tts-1 は4096文字制限があり、長文でも品質劣化しないので3500文字でOK。
CHUNK_MAX_CHARS_GEMINI = 1200
CHUNK_MAX_CHARS_OPENAI = 3500


class AudioGenerator:
    def __init__(self, settings: dict):
        self.tts_cfg = settings.get("tts", {})
        self.provider = self.tts_cfg.get("provider", "gemini").lower()

        if self.provider == "gemini":
            from google import genai
            api_key = os.getenv("GEMINI_API_KEY")
            if not api_key:
                raise ValueError("GEMINI_API_KEY が設定されていません")
            self.client = genai.Client(api_key=api_key)
        elif self.provider == "openai":
            from openai import OpenAI
            self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        else:
            raise ValueError(f"未対応の provider です: {self.provider}")

    def generate(self, script: str, voice: str, output_path: Path, style: str = "") -> Path:
        """スクリプトを音声ファイルに変換して output_path に保存する。
        style: Geminiに渡すトーン指示（例: "落ち着いた、信頼感のあるトーンで"）。OpenAIでは無視される。
        """
        chunk_max = CHUNK_MAX_CHARS_GEMINI if self.provider == "gemini" else CHUNK_MAX_CHARS_OPENAI
        chunks = self._split_script(script, chunk_max)
        logger.info(f"音声生成: {len(chunks)} チャンク / provider={self.provider} / voice={voice}")

        if self.provider == "gemini":
            audio_bytes = self._generate_gemini(chunks, voice, style)
        else:
            audio_bytes = self._generate_openai(chunks, voice)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(audio_bytes)

        size_mb = len(audio_bytes) / 1024 / 1024
        logger.info(f"音声ファイル保存: {output_path} ({size_mb:.1f} MB)")
        return output_path

    # ------------------------------------------------------------------
    # Gemini TTS
    # ------------------------------------------------------------------

    def _generate_gemini(self, chunks: List[str], voice: str, style: str = "") -> bytes:
        """Gemini TTS で生成したPCMチャンクを連結し、MP3に変換して返す。
        style があれば各チャンクの冒頭にスタイル指示を埋め込み、後半の話速暴走を防ぐ。
        """
        from google.genai import types

        model = self.tts_cfg.get("model", "gemini-2.5-flash-preview-tts")

        # スタイル指示プレフィックス（毎チャンクの冒頭に注入してトーンを維持する）
        if style:
            prefix = f"次の文章を、{style}でゆっくり丁寧に読み上げてください：\n\n"
        else:
            prefix = "次の文章を、落ち着いた、信頼感のあるニュースキャスターのトーンで、ゆっくり丁寧に読み上げてください：\n\n"

        pcm_parts: List[bytes] = []
        for i, chunk in enumerate(chunks, 1):
            logger.info(f"  チャンク {i}/{len(chunks)} を変換中... ({len(chunk)} 文字)")
            input_text = prefix + chunk
            pcm_data = self._gemini_tts_one_chunk(model, input_text, voice, types)
            pcm_parts.append(pcm_data)

        # PCMを連結してMP3に変換
        combined_pcm = b"".join(pcm_parts)
        return self._pcm_to_mp3(combined_pcm)

    def _gemini_tts_one_chunk(self, model: str, chunk: str, voice: str, types) -> bytes:
        """1チャンク分のTTS呼び出し。503/429時はリトライする"""
        from google.genai.errors import ServerError, ClientError

        last_err = None
        for attempt, delay in enumerate([0] + GEMINI_RETRY_DELAYS):
            if delay > 0:
                logger.warning(f"    Gemini TTS混雑のため {delay}s 待機して再試行（{attempt}/{len(GEMINI_RETRY_DELAYS)}）")
                time.sleep(delay)
            try:
                response = self.client.models.generate_content(
                    model=model,
                    contents=chunk,
                    config=types.GenerateContentConfig(
                        response_modalities=["AUDIO"],
                        speech_config=types.SpeechConfig(
                            voice_config=types.VoiceConfig(
                                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                    voice_name=voice,
                                )
                            )
                        ),
                    ),
                )
                return response.candidates[0].content.parts[0].inline_data.data
            except (ServerError, ClientError) as e:
                code = getattr(e, "code", None) or getattr(e, "status_code", None)
                if code not in (429, 503):
                    raise
                last_err = e

        raise RuntimeError(f"Gemini TTS が継続的に過負荷状態です。OpenAIへの一時切替を検討してください: {last_err}")

    def _pcm_to_mp3(self, pcm_data: bytes, sample_rate: int = 24000) -> bytes:
        """Gemini TTS の生PCM (24kHz 16bit mono) を MP3 に変換"""
        from pydub import AudioSegment

        # まずWAV形式のバイト列を作る
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16bit
            wf.setframerate(sample_rate)
            wf.writeframes(pcm_data)
        wav_buf.seek(0)

        # pydub でMP3に変換
        audio = AudioSegment.from_wav(wav_buf)
        mp3_buf = io.BytesIO()
        audio.export(mp3_buf, format="mp3", bitrate="128k")
        return mp3_buf.getvalue()

    # ------------------------------------------------------------------
    # OpenAI TTS
    # ------------------------------------------------------------------

    def _generate_openai(self, chunks: List[str], voice: str) -> bytes:
        model = self.tts_cfg.get("openai_model", "tts-1")
        speed = float(self.tts_cfg.get("speed", 1.0))

        audio_parts: List[bytes] = []
        for i, chunk in enumerate(chunks, 1):
            logger.info(f"  チャンク {i}/{len(chunks)} を変換中... ({len(chunk)} 文字)")
            response = self.client.audio.speech.create(
                model=model,
                voice=voice,
                input=chunk,
                speed=speed,
            )
            audio_parts.append(response.content)

        return b"".join(audio_parts)

    # ------------------------------------------------------------------
    # スクリプト分割
    # ------------------------------------------------------------------

    def _split_script(self, script: str, chunk_max: int) -> List[str]:
        """スクリプトを句点・改行で自然に分割してチャンクリストを返す"""
        if len(script) <= chunk_max:
            return [script]

        sentences = re.split(r"(?<=[。！？\n])", script)
        sentences = [s for s in sentences if s.strip()]

        chunks: List[str] = []
        current = ""

        for sentence in sentences:
            if len(current) + len(sentence) > chunk_max and current:
                chunks.append(current.strip())
                current = sentence
            else:
                current += sentence

        if current.strip():
            chunks.append(current.strip())

        return chunks
