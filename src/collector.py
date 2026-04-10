"""
ニュース収集モジュール

RSS フィードと Hacker News API から今週のホットトピックスを収集する。
"""

import re
import time
import logging
import requests
import feedparser
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

CATEGORY_LABELS = {
    "tech": "🔬 テクノロジー",
    "japan": "🗾 日本",
    "international": "🌍 国際",
    "science": "🔭 科学",
    "general": "📰 一般",
}


def partition_news_among_personas(
    items: List[NewsItem],
    persona_ids: Sequence[str],
) -> Dict[str, List[NewsItem]]:
    """複数キャスターが同週のネタで被らないよう、ニュースをラウンドロビンで割り当てる。"""
    buckets: Dict[str, List[NewsItem]] = {pid: [] for pid in persona_ids}
    if not persona_ids:
        return buckets
    n = len(persona_ids)
    for i, item in enumerate(items):
        pid = persona_ids[i % n]
        buckets[pid].append(item)
    return buckets


@dataclass
class NewsItem:
    title: str
    description: str
    url: str
    source: str
    published_at: datetime
    category: str = "general"
    language: str = "ja"


class NewsCollector:
    def __init__(self, settings: dict):
        self.news_cfg = settings.get("news", {})
        self.max_topics = settings.get("podcast", {}).get("max_topics", 25)

    def collect(self) -> List[NewsItem]:
        """全ソースからニュースを収集し、重複除去・時系列ソートして返す"""
        items: List[NewsItem] = []
        days_back = self.news_cfg.get("days_back", 7)

        for feed_cfg in self.news_cfg.get("rss_feeds", []):
            try:
                fetched = self._fetch_rss(feed_cfg)
                items.extend(fetched)
                logger.info(f"RSS [{feed_cfg.get('label', feed_cfg['url'])}]: {len(fetched)} 件取得")
            except Exception as e:
                logger.warning(f"RSS 取得失敗 [{feed_cfg.get('label', feed_cfg['url'])}]: {e}")

        if self.news_cfg.get("use_hackernews", True):
            try:
                hn = self._fetch_hackernews()
                items.extend(hn)
                logger.info(f"Hacker News: {len(hn)} 件取得")
            except Exception as e:
                logger.warning(f"Hacker News 取得失敗: {e}")

        cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
        items = [i for i in items if i.published_at >= cutoff]

        items = self._deduplicate(items)
        items.sort(key=lambda x: x.published_at, reverse=True)

        logger.info(f"合計 {len(items)} 件（上限 {self.max_topics} 件）")
        return items[: self.max_topics]

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _fetch_rss(self, feed_cfg: dict) -> List[NewsItem]:
        feed = feedparser.parse(feed_cfg["url"])
        items = []

        for entry in feed.entries[:15]:
            published_at = self._parse_date(entry)
            description = self._clean_html(
                getattr(entry, "summary", "") or getattr(entry, "description", "")
            )[:400]

            title = entry.get("title", "").strip()
            if not title:
                continue

            items.append(
                NewsItem(
                    title=title,
                    description=description,
                    url=entry.get("link", ""),
                    source=feed.feed.get("title", feed_cfg.get("label", "")),
                    published_at=published_at,
                    category=feed_cfg.get("category", "general"),
                    language=feed_cfg.get("language", "ja"),
                )
            )

        return items

    def _fetch_hackernews(self) -> List[NewsItem]:
        n = self.news_cfg.get("hackernews_stories", 30)
        resp = requests.get(
            "https://hacker-news.firebaseio.com/v0/topstories.json", timeout=10
        )
        story_ids = resp.json()[:n]

        items = []
        for sid in story_ids[:20]:
            try:
                story = requests.get(
                    f"https://hacker-news.firebaseio.com/v0/item/{sid}.json", timeout=5
                ).json()

                if not story or story.get("type") != "story" or not story.get("title"):
                    continue

                published_at = datetime.fromtimestamp(
                    story.get("time", time.time()), tz=timezone.utc
                )
                score = story.get("score", 0)
                comments = story.get("descendants", 0)
                description = story.get("text", "") or f"Score: {score} | Comments: {comments}"
                description = self._clean_html(description)[:400]

                items.append(
                    NewsItem(
                        title=story["title"],
                        description=description,
                        url=story.get("url", f"https://news.ycombinator.com/item?id={sid}"),
                        source="Hacker News",
                        published_at=published_at,
                        category="tech",
                        language="en",
                    )
                )
            except Exception:
                pass

        return items

    def _parse_date(self, entry) -> datetime:
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            try:
                return datetime.fromtimestamp(
                    time.mktime(entry.published_parsed), tz=timezone.utc
                )
            except Exception:
                pass
        if hasattr(entry, "updated_parsed") and entry.updated_parsed:
            try:
                return datetime.fromtimestamp(
                    time.mktime(entry.updated_parsed), tz=timezone.utc
                )
            except Exception:
                pass
        return datetime.now(timezone.utc)

    def _clean_html(self, text: str) -> str:
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def _deduplicate(self, items: List[NewsItem]) -> List[NewsItem]:
        seen: set = set()
        unique = []
        for item in items:
            key = re.sub(r"\s+", "", item.title[:30]).lower()
            if key and key not in seen:
                seen.add(key)
                unique.append(item)
        return unique
