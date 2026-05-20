// ニュース収集モジュール — src/collector.py をTypeScriptに移植

import { RSS_FEEDS, FEEDS_BY_CATEGORY, PODCAST_CONFIG, CATEGORY_LABELS, type RssFeed } from "./rss-feeds";
import type { Persona } from "./personas";

export interface NewsItem {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: Date;
  category: string;
  language: string;
}

export async function collectNews(): Promise<NewsItem[]> {
  const items: NewsItem[] = [];
  const cutoff = new Date(Date.now() - PODCAST_CONFIG.daysBack * 24 * 60 * 60 * 1000);

  // RSS フィードを並行取得
  const rssResults = await Promise.allSettled(
    RSS_FEEDS.map((feed) => fetchRss(feed))
  );
  for (const result of rssResults) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    }
  }

  // Hacker News
  try {
    const hnItems = await fetchHackerNews(PODCAST_CONFIG.hackernewsStories);
    items.push(...hnItems);
  } catch {
    // HN取得失敗は無視
  }

  // 期間フィルタ
  const recent = items.filter((i) => i.publishedAt >= cutoff);

  // 重複除去
  const deduped = deduplicate(recent);

  // 時系列降順
  deduped.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  return deduped.slice(0, PODCAST_CONFIG.maxTopics);
}

/**
 * 複数キャスターが同じ週のネタで被らないよう、ニュースをラウンドロビンで割り当てる。
 * items は時系列降順を想定（先頭ほど新しい）。
 */
export function partitionNewsAmongPersonas(
  items: NewsItem[],
  personaIds: readonly string[]
): Record<string, NewsItem[]> {
  const buckets: Record<string, NewsItem[]> = {};
  for (const id of personaIds) buckets[id] = [];
  if (personaIds.length === 0) return buckets;

  for (let i = 0; i < items.length; i++) {
    const id = personaIds[i % personaIds.length];
    buckets[id].push(items[i]);
  }
  return buckets;
}

// RSSフィードを取得してNewsItemリストを返す
async function fetchRss(feed: RssFeed): Promise<NewsItem[]> {
  const resp = await fetch(feed.url, {
    headers: { "User-Agent": "PodcastBot/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return [];

  const xml = await resp.text();
  return parseRss(xml, feed);
}

function parseRss(xml: string, feed: RssFeed): NewsItem[] {
  const items: NewsItem[] = [];

  // <item> タグを抽出
  const itemMatches = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];

  for (const itemXml of itemMatches.slice(0, 15)) {
    const title = extractTag(itemXml, "title");
    if (!title) continue;

    const description = cleanHtml(
      extractTag(itemXml, "description") ?? extractTag(itemXml, "summary") ?? ""
    ).slice(0, 400);

    const url =
      extractTag(itemXml, "link") ??
      extractAttr(itemXml, "enclosure", "url") ??
      "";

    const pubDate =
      extractTag(itemXml, "pubDate") ??
      extractTag(itemXml, "published") ??
      extractTag(itemXml, "dc:date") ??
      "";

    const publishedAt = pubDate ? new Date(pubDate) : new Date();

    items.push({
      title: title.trim(),
      description,
      url,
      source: feed.label,
      publishedAt: isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
      category: feed.category,
      language: feed.language,
    });
  }

  return items;
}

interface HNStory {
  id: number;
  type: string;
  title: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  time?: number;
}

// Hacker News API からトップストーリーを取得
async function fetchHackerNews(n: number): Promise<NewsItem[]> {
  const idsResp = await fetch(
    "https://hacker-news.firebaseio.com/v0/topstories.json",
    { signal: AbortSignal.timeout(8000) }
  );
  const ids: number[] = await idsResp.json();
  const targetIds = ids.slice(0, n);

  const storyResults = await Promise.allSettled(
    targetIds.map((id) =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.json() as Promise<HNStory>)
    )
  );

  const items: NewsItem[] = [];
  for (const result of storyResults) {
    if (result.status !== "fulfilled") continue;
    const story = result.value;
    if (!story || story.type !== "story" || !story.title) continue;

    const score = story.score ?? 0;
    const comments = story.descendants ?? 0;
    const description = cleanHtml(story.text ?? `Score: ${score} | Comments: ${comments}`).slice(0, 400);

    items.push({
      title: story.title,
      description,
      url: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
      source: "Hacker News",
      publishedAt: new Date((story.time ?? Date.now() / 1000) * 1000),
      category: "tech",
      language: "en",
    });
  }

  return items;
}

// ユーティリティ
function extractTag(xml: string, tag: string): string | null {
  const patterns = [
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"),
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function extractAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

function cleanHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function deduplicate(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.slice(0, 30).toLowerCase().replace(/\s+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface DevToArticle {
  title: string;
  url: string;
  description: string;
  published_at: string;
}

// Dev.to API からテック記事を取得（APIキー不要）
async function fetchDevToArticles(): Promise<NewsItem[]> {
  try {
    const resp = await fetch("https://dev.to/api/articles?top=7&per_page=20", {
      headers: { "User-Agent": "PodcastBot/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const articles: DevToArticle[] = await resp.json();
    return articles.map((a) => ({
      title: a.title,
      description: (a.description ?? "").slice(0, 400),
      url: a.url,
      source: "Dev.to",
      publishedAt: a.published_at ? new Date(a.published_at) : new Date(),
      category: "tech",
      language: "en",
    }));
  } catch {
    return [];
  }
}

/**
 * キャスターの expertise に合わせた専用ニュースを取得する。
 * 各キャスターが異なるソースから記事を取得するため、放送回ごとのトピック被りを防ぐ。
 */
export async function fetchNewsForPersona(persona: Persona): Promise<NewsItem[]> {
  const cutoff = new Date(Date.now() - PODCAST_CONFIG.daysBack * 24 * 60 * 60 * 1000);
  const items: NewsItem[] = [];

  // expertise に合致するカテゴリのフィードのみ取得
  const targetFeeds: RssFeed[] = persona.expertise.flatMap(
    (cat) => FEEDS_BY_CATEGORY[cat] ?? []
  );

  const rssResults = await Promise.allSettled(
    targetFeeds.map((feed) => fetchRss(feed))
  );
  for (const result of rssResults) {
    if (result.status === "fulfilled") items.push(...result.value);
  }

  // tech カテゴリのキャスターには Hacker News + Dev.to を追加
  if (persona.expertise.includes("tech")) {
    try {
      const hnItems = await fetchHackerNews(PODCAST_CONFIG.hackernewsStories);
      items.push(...hnItems);
    } catch { /* HN取得失敗は無視 */ }

    const devToItems = await fetchDevToArticles();
    items.push(...devToItems);
  }

  const recent = items.filter((i) => i.publishedAt >= cutoff);
  const deduped = deduplicate(recent);
  deduped.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  return deduped.slice(0, PODCAST_CONFIG.maxTopics);
}

export interface BuildNewsPromptOptions {
  /** 真のとき：他キャスターと題材が被らない専用割当である旨を明示 */
  exclusiveAssignment?: boolean;
}

// ニュースをカテゴリ別にまとめてプロンプト用テキストに変換
export function buildNewsPrompt(items: NewsItem[], options?: BuildNewsPromptOptions): string {
  const exclusive = options?.exclusiveAssignment ?? false;

  const byCategory: Record<string, NewsItem[]> = {};
  for (const item of items) {
    (byCategory[item.category] ??= []).push(item);
  }

  const lines: string[] = [];

  if (exclusive) {
    lines.push(
      "【担当割当トピック】同一天に収録される他キャスターと題材が被らないよう、あなた専用に振り分けられたニュースだけをリストしています。",
      "・このリストに含まれるニュースだけを、本編の主要トピックとして取り上げてください（イントロのひと言の比喩として他を触れてもよいが、本題は割当分のみ）。",
      "・リスト外の「今週の大きな出来事」に便乗した重複解説はしないでください。",
      ""
    );
  }

  lines.push(
    "今週のニュースリストです。以下を参考に、今週のエピソードを作成してください。",
    exclusive
      ? "（上記のルールに従い、このリストの中から3〜4件程度を選び、深く語ってください。件数が少ない場合はリスト内のすべてを扱ってください）"
      : "（すべてを取り上げる必要はありません。最も興味深いものを自由に選んでください）"
  );

  for (const [category, catItems] of Object.entries(byCategory)) {
    const label = CATEGORY_LABELS[category] ?? category;
    lines.push("", label, "─".repeat(30));
    for (const item of catItems.slice(0, 8)) {
      const langNote = item.language === "en" ? "（英語記事）" : "";
      lines.push(`・${item.title}${langNote}`);
      if (item.description) lines.push(`  → ${item.description.slice(0, 200)}`);
      lines.push(`  出典: ${item.source}`);
    }
  }

  lines.push("", "", "それでは、エピソードのスクリプトを作成してください。");
  return lines.join("\n");
}

// キャスター専用：得意分野に応じたニュースプロンプトを生成
export function buildNewsPromptForPersona(items: NewsItem[], expertiseCategories: string[]): string {
  const byCategory: Record<string, NewsItem[]> = {};
  for (const item of items) {
    (byCategory[item.category] ??= []).push(item);
  }

  const lines: string[] = [
    "今週のニュースリストです。",
    `あなたの得意分野は【${expertiseCategories.map(c => CATEGORY_LABELS[c] ?? c).join("、")}】です。`,
    "これらの分野を特に重視しながら、以下を参考に今週のエピソードを作成してください。",
    "（すべてを取り上げる必要はありません。得意分野から最も興味深いものを優先的に選んでください）",
  ];

  // 得意分野を先に表示
  for (const category of expertiseCategories) {
    if (byCategory[category]) {
      const label = CATEGORY_LABELS[category] ?? category;
      lines.push("", `★ ${label} （あなたの得意分野）`, "─".repeat(30));
      for (const item of byCategory[category].slice(0, 8)) {
        const langNote = item.language === "en" ? "（英語記事）" : "";
        lines.push(`・${item.title}${langNote}`);
        if (item.description) lines.push(`  → ${item.description.slice(0, 200)}`);
        lines.push(`  出典: ${item.source}`);
      }
    }
  }

  // その他のカテゴリを表示
  for (const [category, catItems] of Object.entries(byCategory)) {
    if (!expertiseCategories.includes(category)) {
      const label = CATEGORY_LABELS[category] ?? category;
      lines.push("", label, "─".repeat(30));
      for (const item of catItems.slice(0, 8)) {
        const langNote = item.language === "en" ? "（英語記事）" : "";
        lines.push(`・${item.title}${langNote}`);
        if (item.description) lines.push(`  → ${item.description.slice(0, 200)}`);
        lines.push(`  出典: ${item.source}`);
      }
    }
  }

  lines.push("", "", "それでは、エピソードのスクリプトを作成してください。");
  return lines.join("\n");
}
