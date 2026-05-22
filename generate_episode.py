#!/usr/bin/env python3
"""
知のわんこそば - AIポッドキャスト生成システム

使い方:
  python generate_episode.py                     # 全ペルソナのエピソードを生成
  python generate_episode.py -p philosopher      # 特定ペルソナのみ
  python generate_episode.py --no-audio          # スクリプトのみ（音声なし）
  python generate_episode.py --list-personas     # ペルソナ一覧を表示
"""

import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

import click
import yaml
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

sys.path.insert(0, str(Path(__file__).parent))

from src.audio_generator import AudioGenerator
from src.collector import NewsCollector, partition_news_among_personas
from src.feed_generator import FeedGenerator
from src.script_generator import ScriptGenerator

load_dotenv()

console = Console()
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# Config loader
# ─────────────────────────────────────────────

def load_config():
    config_dir = Path(__file__).parent / "config"
    with open(config_dir / "settings.yaml", encoding="utf-8") as f:
        settings = yaml.safe_load(f)
    with open(config_dir / "personas.yaml", encoding="utf-8") as f:
        personas = yaml.safe_load(f).get("personas", {})
    return settings, personas


# ─────────────────────────────────────────────
# Helper: load all saved episodes for RSS feed
# ─────────────────────────────────────────────

def _load_all_saved_episodes(base_output: Path):
    all_eps = []
    for ep_file in sorted(base_output.rglob("episodes.json")):
        try:
            with open(ep_file, encoding="utf-8") as f:
                data = json.load(f)
            dir_name = ep_file.parent.name
            for ep in data:
                try:
                    ep["date"] = datetime.strptime(dir_name, "%Y-%m-%d")
                except ValueError:
                    ep["date"] = datetime.now()
                all_eps.append(ep)
        except Exception:
            pass
    return all_eps


# ─────────────────────────────────────────────
# Main CLI
# ─────────────────────────────────────────────

@click.command()
@click.option(
    "--persona", "-p",
    default="all",
    help="生成するペルソナ ID（all / centrist / progressive / conservative / tech_optimist / philosopher）",
)
@click.option(
    "--no-audio", is_flag=True, default=False,
    help="音声生成をスキップしてスクリプトのみ保存する",
)
@click.option(
    "--output-dir", "-o", default="output",
    help="出力ディレクトリ（デフォルト: output/）",
)
@click.option(
    "--list-personas", is_flag=True, default=False,
    help="利用可能なペルソナ一覧を表示して終了する",
)
def main(persona: str, no_audio: bool, output_dir: str, list_personas: bool):
    """知のわんこそば — 毎週のホットトピックをAIが解説するポッドキャストを生成する"""

    console.print(
        Panel.fit(
            "[bold cyan]知のわんこそば[/bold cyan]  [dim]AI Podcast Generator[/dim]",
            border_style="cyan",
        )
    )

    settings, personas = load_config()

    # ペルソナ一覧表示
    if list_personas:
        t = Table(title="利用可能なペルソナ", show_header=True, header_style="bold cyan")
        t.add_column("ID", style="yellow")
        t.add_column("名前", style="white")
        t.add_column("タイトル", style="dim")
        t.add_column("スタンス", style="green", max_width=40)
        for pid, p in personas.items():
            t.add_row(pid, p["name"], p["title"], p["stance"].split("。")[0])
        console.print(t)
        return

    # API キーチェック（provider設定に応じて）
    llm_provider = settings.get("llm", {}).get("provider", "gemini").lower()
    tts_provider = settings.get("tts", {}).get("provider", "gemini").lower()
    need_gemini = llm_provider == "gemini" or tts_provider == "gemini"
    need_openai = llm_provider == "openai" or tts_provider == "openai"

    if need_gemini and not os.getenv("GEMINI_API_KEY"):
        console.print("[bold red]エラー: GEMINI_API_KEY が設定されていません。[/bold red]")
        console.print(".env ファイルに GEMINI_API_KEY を設定してください。")
        sys.exit(1)
    if need_openai and not os.getenv("OPENAI_API_KEY"):
        console.print("[bold red]エラー: OPENAI_API_KEY が設定されていません。[/bold red]")
        console.print(".env ファイルに OPENAI_API_KEY を設定してください。")
        sys.exit(1)

    # ペルソナ選択
    if persona == "all":
        selected = list(personas.keys())
    else:
        if persona not in personas:
            console.print(f"[red]エラー: ペルソナ '{persona}' が存在しません。[/red]")
            console.print(f"利用可能: {', '.join(personas.keys())}")
            sys.exit(1)
        selected = [persona]

    # 出力ディレクトリ準備
    date_str = datetime.now().strftime("%Y-%m-%d")
    base_output = Path(output_dir)
    episode_dir = base_output / date_str
    episode_dir.mkdir(parents=True, exist_ok=True)

    # ─── ニュース収集 ───────────────────────────
    console.print("\n[bold]📰  ニュースを収集中...[/bold]")
    collector = NewsCollector(settings)
    with console.status("[green]RSS フィード・Hacker News を取得中...[/green]"):
        items = collector.collect()

    console.print(f"✅  {len(items)} 件のトピックを収集しました\n")

    # 収集したニュースの一覧表示
    t = Table(title="収集したトピック（上位10件）", show_header=True, header_style="bold")
    t.add_column("カテゴリ", style="cyan", width=14)
    t.add_column("タイトル", style="white", max_width=55)
    t.add_column("ソース", style="dim", width=18)
    for item in items[:10]:
        t.add_row(item.category, item.title[:55], item.source[:18])
    if len(items) > 10:
        t.add_row("…", f"他 {len(items) - 10} 件", "")
    console.print(t)
    console.print()

    # トピックを JSON 保存
    topics_json = [
        {
            "title": i.title,
            "description": i.description,
            "url": i.url,
            "source": i.source,
            "category": i.category,
            "language": i.language,
            "published_at": i.published_at.isoformat(),
        }
        for i in items
    ]
    with open(episode_dir / "topics.json", "w", encoding="utf-8") as f:
        json.dump(topics_json, f, ensure_ascii=False, indent=2)

    # ─── ジェネレーター初期化 ───────────────────
    generator = ScriptGenerator(settings, personas)
    audio_gen = AudioGenerator(settings) if not no_audio else None
    base_url = os.getenv("PODCAST_BASE_URL", "http://localhost:8000")

    episodes = []

    exclusive = len(selected) > 1
    items_by_persona = (
        partition_news_among_personas(items, selected) if exclusive else None
    )

    # ─── 各ペルソナのエピソード生成 ─────────────
    for persona_id in selected:
        p = personas[persona_id]
        console.print(f"[bold]🎙️  {p['name']}（{p['title']}）[/bold]")

        sub_items = items_by_persona[persona_id] if items_by_persona else items

        # スクリプト生成
        with console.status(f"[green]スクリプトを生成中...[/green]"):
            script = generator.generate(
                sub_items, persona_id, exclusive_assignment=exclusive
            )

        script_path = episode_dir / f"{persona_id}_script.txt"
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(f"# {p['name']} — {date_str}\n\n")
            f.write(script)

        console.print(f"  ✅  スクリプト保存: {script_path.name}  ({len(script):,} 文字)")

        # 音声生成
        audio_path = None
        audio_size = 0
        if audio_gen is not None:
            audio_path = episode_dir / f"{persona_id}.mp3"
            tts_label = "Gemini TTS" if tts_provider == "gemini" else "OpenAI TTS"
            voice = p["voices"][tts_provider]
            # tts_style があれば優先（読み上げ専用の固定指示）。無ければ style を流用。
            style_hint = (p.get("tts_style") or p.get("style") or "").replace("\n", " ").strip()
            with console.status(f"[green]音声を生成中（{tts_label}）...[/green]"):
                audio_gen.generate(script, voice, audio_path, style=style_hint)
            audio_size = audio_path.stat().st_size
            console.print(
                f"  🔊  音声ファイル: {audio_path.name}  ({audio_size / 1024 / 1024:.1f} MB)"
            )

        console.print()

        episodes.append(
            {
                "title": f"{p['name']}の知のわんこそば — {date_str}",
                "description": f"{p['title']}が今週のホットトピックスを解説",
                "persona_id": persona_id,
                "persona_name": p["name"],
                "script_path": str(script_path),
                "audio_path": str(audio_path) if audio_path else None,
                "audio_url": f"{base_url}/output/{date_str}/{persona_id}.mp3",
                "audio_size": audio_size,
            }
        )

    # エピソードメタデータを保存
    with open(episode_dir / "episodes.json", "w", encoding="utf-8") as f:
        json.dump(episodes, f, ensure_ascii=False, indent=2)

    # ─── RSS フィード更新 ───────────────────────
    if audio_gen is not None:
        console.print("[bold]📡  RSSフィードを更新中...[/bold]")
        all_eps = _load_all_saved_episodes(base_output)
        feed_gen = FeedGenerator(settings, base_output)
        feed_path = feed_gen.generate(all_eps)
        console.print(f"✅  RSSフィード: {feed_path}\n")

    # ─── 完了メッセージ ─────────────────────────
    audio_note = (
        "\n🎧  ポッドキャストアプリに feed.xml を登録するか、\n"
        "   [dim]python -m http.server[/dim] でローカルサーバを立てて聴けます"
        if audio_gen is not None
        else "\n📝  スクリプトのみ生成しました（--no-audio モード）"
    )

    console.print(
        Panel.fit(
            f"[bold green]✅  生成完了！[/bold green]\n\n"
            f"📁  出力: {episode_dir}\n"
            f"🎙️  エピソード数: {len(episodes)} 件"
            + audio_note,
            border_style="green",
        )
    )


if __name__ == "__main__":
    main()
