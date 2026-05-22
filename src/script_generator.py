"""
スクリプト生成モジュール

ペルソナと今週のニュースを受け取り、Gemini または OpenAI でポッドキャストスクリプトを生成する。
provider 設定で切替可能。
"""

import os
import logging
import time
from typing import List, Dict

from .collector import NewsItem, CATEGORY_LABELS

logger = logging.getLogger(__name__)

# Geminiの503/429に対するリトライ設定（指数バックオフ）
GEMINI_RETRY_DELAYS = [10, 30, 60, 120, 240]  # 計 7分40秒 まで待つ


class ScriptGenerator:
    def __init__(self, settings: dict, personas: dict):
        self.llm_cfg = settings.get("llm", {})
        self.personas = personas
        self.provider = self.llm_cfg.get("provider", "gemini").lower()

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

    def generate(
        self,
        items: List[NewsItem],
        persona_id: str,
        *,
        exclusive_assignment: bool = False,
    ) -> str:
        """指定ペルソナで今週のポッドキャストスクリプトを生成して返す"""
        persona = self.personas.get(persona_id)
        if not persona:
            raise ValueError(f"ペルソナが見つかりません: {persona_id}")

        system_prompt = self._build_system_prompt(persona, exclusive_assignment)
        user_prompt = self._build_user_prompt(items, exclusive_assignment)

        if self.provider == "gemini":
            return self._generate_gemini(system_prompt, user_prompt, persona)
        else:
            return self._generate_openai(system_prompt, user_prompt, persona)

    def _generate_gemini(self, system_prompt: str, user_prompt: str, persona: dict) -> str:
        from google.genai import types
        from google.genai.errors import ServerError, ClientError

        model = self.llm_cfg.get("model", "gemini-2.5-flash")
        logger.info(f"スクリプト生成中（Gemini）: {persona['name']} / モデル: {model}")

        # Gemini 2.5 Flash の Thinking モードを無効化（max_tokens を全て出力に使うため）
        thinking_config = types.ThinkingConfig(thinking_budget=0)

        last_err = None
        for attempt, delay in enumerate([0] + GEMINI_RETRY_DELAYS):
            if delay > 0:
                logger.warning(f"  Gemini混雑のため {delay}s 待機して再試行（{attempt}/{len(GEMINI_RETRY_DELAYS)}）")
                time.sleep(delay)
            try:
                response = self.client.models.generate_content(
                    model=model,
                    contents=user_prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=system_prompt,
                        max_output_tokens=self.llm_cfg.get("max_tokens", 4096),
                        temperature=self.llm_cfg.get("temperature", 0.85),
                        thinking_config=thinking_config,
                    ),
                )
                # finish_reason が MAX_TOKENS なら警告（max_tokens を上げる必要あり）
                if response.candidates:
                    fr = response.candidates[0].finish_reason
                    if fr and str(fr).endswith("MAX_TOKENS"):
                        logger.warning(f"  出力が max_tokens に達しました。台本が途中で切れている可能性あり: {fr}")
                return response.text or ""
            except (ServerError, ClientError) as e:
                # 503 (overloaded) / 429 (rate limit) のみリトライ。他は即raise
                code = getattr(e, "code", None) or getattr(e, "status_code", None)
                if code not in (429, 503):
                    raise
                last_err = e

        # リトライ尽きた
        raise RuntimeError(f"Gemini が継続的に過負荷状態です。OpenAIへの一時切替を検討してください: {last_err}")

    def _generate_openai(self, system_prompt: str, user_prompt: str, persona: dict) -> str:
        model = self.llm_cfg.get("openai_model", "gpt-4o")
        logger.info(f"スクリプト生成中（OpenAI）: {persona['name']} / モデル: {model}")

        response = self.client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=self.llm_cfg.get("max_tokens", 4096),
            temperature=self.llm_cfg.get("temperature", 0.85),
        )
        return response.choices[0].message.content or ""

    # ------------------------------------------------------------------
    # Prompt builders
    # ------------------------------------------------------------------

    def _build_system_prompt(self, persona: dict, exclusive: bool) -> str:
        exclusive_block = ""
        if exclusive:
            exclusive_block = """
━━━━━━━━━━━━━━━━━━━━━━━━━━
【週次シリーズの掟：題材の分担】
━━━━━━━━━━━━━━━━━━━━━━━━━━
今回渡されるニュースリストは「あなた担当の題材」に限定されています。他の4名のキャスターは別のニュースを担当します。
・リストにない出来事をメインの論点にしないでください。
・同一週に他キャスターと同じニュース・同一事件を主トピックにしないでください。

"""
        return f"""あなたは{persona["name"]}（{persona["title"]}）です。

━━━━━━━━━━━━━━━━━━━━━━━━━━
【キャラクター設定】
━━━━━━━━━━━━━━━━━━━━━━━━━━
{persona["description"]}

【政治・哲学的スタンス】
{persona["stance"]}

【話し方・スタイル】
{persona["style"]}

【キャッチフレーズ】
{persona["catchphrase"]}

【シグネチャームーブ（得意技）】
{persona["signature_move"]}
{exclusive_block}
━━━━━━━━━━━━━━━━━━━━━━━━━━
【エピソードの構成】
━━━━━━━━━━━━━━━━━━━━━━━━━━

以下の構成でポッドキャストスクリプトを作成してください。
セクションタイトル（「イントロ」「トピック」等）は本文に書かないこと。
自然に流れる、話し言葉のテキストにすること。

1. イントロ（約30秒〜1分 / 約300文字）
   - 意外な問い・逆説・印象的な事実・哲学的命題などで開幕する
   - 「今週は〜について話します」と直接言わず、リスナーを引き込む
   - あなたらしいキャラクターとトーンを最初の一文で確立する

2. 今週のトピック解説（約4〜5分 / 約1500文字）
   - 提供されたニュースリストから、最も面白いと感じる2〜3件を選ぶ
   - 各トピックをあなたのスタンスと独自の視点で簡潔に解説する
   - 専門用語・略語は必ず平易な言葉に言い換えて説明する
   - トピック同士の意外なつながりを積極的に見つけて語る
   - 英語のニュースも日本語で自然に紹介すること

3. 深掘りコーナー（約2分 / 約800文字）
   - 1件のトピックを選び、あなたのシグネチャームーブを使って深掘りする
   - 歴史・哲学・科学・経済など、意外な分野との接続を見せる
   - リスナーに「なるほど！そういう見方があったか！」という驚きを与える

4. アウトロ（約30秒〜1分 / 約400文字）
   - 今週のエピソード全体に流れるテーマを一言で言い表す
   - リスナーへの問いかけ、または来週への軽い予告
   - あなたのキャッチフレーズで締める

━━━━━━━━━━━━━━━━━━━━━━━━━━
【制作上の絶対ルール】
━━━━━━━━━━━━━━━━━━━━━━━━━━
- 合計 7〜9分相当（約3000文字）で書くこと。長すぎず短すぎず、必ず最後まで書ききること
- 完全に日本語で書くこと（英語の固有名詞はカタカナ化・説明を添える）
- ラジオ放送として声に出して読まれることを意識した「話し言葉」で書く
- セクション見出し・箇条書き・マークダウン記号は一切使わない
- 必ず少なくとも1つの「意外なつながり」を含めること
- 自分のスタンスを体現しつつ、独断的すぎず知的好奇心を刺激すること
"""

    def _build_user_prompt(self, items: List[NewsItem], exclusive: bool) -> str:
        lines = []
        if exclusive:
            lines.extend(
                [
                    "【担当割当トピック】同一天に収録される他キャスターと題材が被らないよう、あなた専用に振り分けられたニュースだけをリストしています。",
                    "・このリストに含まれるニュースだけを、本編の主要トピックとして取り上げてください（イントロのひと言の比喩として他を触れてもよいが、本題は割当分のみ）。",
                    "・リスト外の「今週の大きな出来事」に便乗した重複解説はしないでください。",
                    "",
                ]
            )
        lines.append("今週のニュースリストです。以下を参考に、今週のエピソードを作成してください。\n")
        if exclusive:
            lines.append(
                "（上記のルールに従い、このリストの中から3〜4件程度を選び、深く語ってください。件数が少ない場合はリスト内のすべてを扱ってください）\n"
            )
        else:
            lines.append("（すべてを取り上げる必要はありません。最も興味深いものを自由に選んでください）\n")

        by_category: Dict[str, List[NewsItem]] = {}
        for item in items:
            by_category.setdefault(item.category, []).append(item)

        for category, cat_items in by_category.items():
            label = CATEGORY_LABELS.get(category, category)
            lines.append(f"\n{label}")
            lines.append("─" * 30)

            for item in cat_items[:8]:
                lang_note = "（英語記事）" if item.language == "en" else ""
                lines.append(f"・{item.title}{lang_note}")
                if item.description:
                    lines.append(f"  → {item.description[:200]}")
                lines.append(f"  出典: {item.source}")

        lines.append("\n\nそれでは、エピソードのスクリプトを作成してください。")
        return "\n".join(lines)
