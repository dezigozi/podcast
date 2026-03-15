"""
スクリプト生成モジュール

ペルソナと今週のニュースを受け取り、GPT-4o でポッドキャストスクリプトを生成する。
"""

import os
import logging
from typing import List, Dict

from openai import OpenAI

from .collector import NewsItem, CATEGORY_LABELS

logger = logging.getLogger(__name__)


class ScriptGenerator:
    def __init__(self, settings: dict, personas: dict):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self.llm_cfg = settings.get("llm", {})
        self.personas = personas

    def generate(self, items: List[NewsItem], persona_id: str) -> str:
        """指定ペルソナで今週のポッドキャストスクリプトを生成して返す"""
        persona = self.personas.get(persona_id)
        if not persona:
            raise ValueError(f"ペルソナが見つかりません: {persona_id}")

        system_prompt = self._build_system_prompt(persona)
        user_prompt = self._build_user_prompt(items)

        model = self.llm_cfg.get("model", "gpt-4o")
        logger.info(f"スクリプト生成中: {persona['name']} / モデル: {model}")

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

    def _build_system_prompt(self, persona: dict) -> str:
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

━━━━━━━━━━━━━━━━━━━━━━━━━━
【エピソードの構成】
━━━━━━━━━━━━━━━━━━━━━━━━━━

以下の構成でポッドキャストスクリプトを作成してください。
セクションタイトル（「イントロ」「トピック」等）は本文に書かないこと。
自然に流れる、話し言葉のテキストにすること。

1. イントロ（約2〜3分）
   - 意外な問い・逆説・印象的な事実・哲学的命題などで開幕する
   - 「今週は〜について話します」と直接言わず、リスナーを引き込む
   - あなたらしいキャラクターとトーンを最初の一文で確立する

2. 今週のトピック解説（約10〜12分）
   - 提供されたニュースリストから、最も面白いと感じる3〜4件を選ぶ
   - 各トピックをあなたのスタンスと独自の視点で解説する
   - 専門用語・略語は必ず平易な言葉に言い換えて説明する
   - トピック同士の意外なつながりを積極的に見つけて語る
   - 英語のニュースも日本語で自然に紹介すること

3. 深掘りコーナー（約4〜5分）
   - 1件のトピックを選び、あなたのシグネチャームーブを使って深掘りする
   - 歴史・哲学・科学・経済など、意外な分野との接続を見せる
   - リスナーに「なるほど！そういう見方があったか！」という驚きを与える
   - （例：株価指数の話→テセウスの船のパラドックス、のような飛躍を恐れない）

4. アウトロ（約2〜3分）
   - 今週のエピソード全体に流れるテーマを一言で言い表す
   - リスナーへの問いかけ、または来週への軽い予告
   - あなたのキャッチフレーズで締める

━━━━━━━━━━━━━━━━━━━━━━━━━━
【制作上の絶対ルール】
━━━━━━━━━━━━━━━━━━━━━━━━━━
- 合計 15〜20分相当（約6000〜8000文字）で書くこと
- 完全に日本語で書くこと（英語の固有名詞はカタカナ化・説明を添える）
- ラジオ放送として声に出して読まれることを意識した「話し言葉」で書く
- セクション見出し・箇条書き・マークダウン記号は一切使わない
- 必ず少なくとも1つの「意外なつながり」を含めること
- 自分のスタンスを体現しつつ、独断的すぎず知的好奇心を刺激すること
"""

    def _build_user_prompt(self, items: List[NewsItem]) -> str:
        lines = ["今週のニュースリストです。以下を参考に、今週のエピソードを作成してください。\n"]
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
