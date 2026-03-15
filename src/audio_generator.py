"""
音声生成モジュール

OpenAI TTS API を使ってスクリプトをMP3音声ファイルに変換する。
長いスクリプトは自然な区切りでチャンク分割して連結する。
"""

import os
import logging
import re
from pathlib import Path
from typing import List

from openai import OpenAI

logger = logging.getLogger(__name__)

# OpenAI TTS の1リクエストあたり最大文字数（余裕を持って3500文字）
CHUNK_MAX_CHARS = 3500


class AudioGenerator:
    def __init__(self, settings: dict):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.tts_cfg = settings.get("tts", {})

    def generate(self, script: str, voice: str, output_path: Path) -> Path:
        """スクリプトを音声ファイルに変換して output_path に保存する"""
        model = self.tts_cfg.get("model", "tts-1")
        speed = float(self.tts_cfg.get("speed", 1.0))

        chunks = self._split_script(script)
        logger.info(f"音声生成: {len(chunks)} チャンク / voice={voice} / model={model}")

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

        combined = b"".join(audio_parts)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(combined)

        size_mb = len(combined) / 1024 / 1024
        logger.info(f"音声ファイル保存: {output_path} ({size_mb:.1f} MB)")
        return output_path

    def _split_script(self, script: str) -> List[str]:
        """スクリプトを句点・改行で自然に分割してチャンクリストを返す"""
        if len(script) <= CHUNK_MAX_CHARS:
            return [script]

        # 句点・感嘆符・疑問符の後で分割
        sentences = re.split(r"(?<=[。！？\n])", script)
        sentences = [s for s in sentences if s.strip()]

        chunks: List[str] = []
        current = ""

        for sentence in sentences:
            if len(current) + len(sentence) > CHUNK_MAX_CHARS and current:
                chunks.append(current.strip())
                current = sentence
            else:
                current += sentence

        if current.strip():
            chunks.append(current.strip())

        return chunks
