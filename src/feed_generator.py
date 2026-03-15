"""
RSSフィード生成モジュール

生成されたエピソードを標準的なポッドキャストRSSフィード（iTunes互換）として出力する。
出力された feed.xml をポッドキャストアプリに登録して使う。
"""

import os
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List
import xml.etree.ElementTree as ET

logger = logging.getLogger(__name__)


class FeedGenerator:
    def __init__(self, settings: dict, output_dir: Path):
        self.podcast_cfg = settings.get("podcast", {})
        self.output_dir = output_dir
        self.base_url = os.getenv("PODCAST_BASE_URL", "http://localhost:8000")

    def generate(self, episodes: List[Dict[str, Any]]) -> Path:
        """エピソードリストからRSSフィードを生成・保存する"""
        ET.register_namespace("itunes", "http://www.itunes.com/dtds/podcast-1.0.dtd")
        ET.register_namespace("atom", "http://www.w3.org/2005/Atom")

        rss = ET.Element("rss", {
            "version": "2.0",
            "xmlns:itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
            "xmlns:atom": "http://www.w3.org/2005/Atom",
        })

        channel = ET.SubElement(rss, "channel")

        # チャンネルメタデータ
        ET.SubElement(channel, "title").text = self.podcast_cfg.get("title", "知のわんこそば")
        ET.SubElement(channel, "description").text = self.podcast_cfg.get("description", "")
        ET.SubElement(channel, "language").text = self.podcast_cfg.get("language", "ja")
        ET.SubElement(channel, "link").text = self.base_url
        ET.SubElement(channel, "{http://www.itunes.com/dtds/podcast-1.0.dtd}author").text = "AI Podcast System"
        ET.SubElement(channel, "{http://www.itunes.com/dtds/podcast-1.0.dtd}explicit").text = "no"
        cat = ET.SubElement(channel, "{http://www.itunes.com/dtds/podcast-1.0.dtd}category")
        cat.set("text", "Technology")

        # エピソードを新しい順に追加
        sorted_eps = sorted(
            episodes,
            key=lambda x: x.get("date", datetime.min) if isinstance(x.get("date"), datetime) else datetime.min,
            reverse=True,
        )

        for ep in sorted_eps:
            if not ep.get("audio_path") and not ep.get("audio_url"):
                continue

            item = ET.SubElement(channel, "item")
            ET.SubElement(item, "title").text = ep.get("title", "エピソード")
            ET.SubElement(item, "description").text = ep.get("description", "")

            pub_date = ep.get("date", datetime.now())
            if isinstance(pub_date, datetime):
                ET.SubElement(item, "pubDate").text = pub_date.strftime(
                    "%a, %d %b %Y %H:%M:%S +0000"
                )

            audio_url = ep.get("audio_url", "")
            ET.SubElement(item, "guid", {"isPermaLink": "false"}).text = audio_url

            if audio_url:
                enc = ET.SubElement(item, "enclosure")
                enc.set("url", audio_url)
                enc.set("type", "audio/mpeg")
                enc.set("length", str(ep.get("audio_size", 0)))

        # インデント整形（Python 3.9+）
        try:
            ET.indent(rss, space="  ")
        except AttributeError:
            pass

        tree = ET.ElementTree(rss)
        feed_path = self.output_dir / "feed.xml"
        tree.write(str(feed_path), encoding="utf-8", xml_declaration=True)

        logger.info(f"RSSフィード生成: {feed_path} ({len(sorted_eps)} エピソード)")
        return feed_path
