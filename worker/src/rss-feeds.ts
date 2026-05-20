// RSSフィード一覧 — config/settings.yaml をTypeScript定数に移植

export interface RssFeed {
  url: string;
  category: string;
  language: string;
  label: string;
}

// カテゴリ別フィードマップ — キャスターの expertise に合わせて専用ソースを取得するために使用
export const FEEDS_BY_CATEGORY: Record<string, RssFeed[]> = {
  tech: [
    { url: "https://www.technologyreview.com/feed/", category: "tech", language: "en", label: "MIT Technology Review" },
    { url: "https://www.wired.com/feed/rss", category: "tech", language: "en", label: "WIRED" },
    { url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", category: "tech", language: "en", label: "NYT Technology" },
    { url: "https://feeds.arstechnica.com/arstechnica/index", category: "tech", language: "en", label: "Ars Technica" },
    { url: "https://techcrunch.com/feed/", category: "tech", language: "en", label: "TechCrunch" },
    { url: "https://www.theverge.com/rss/index.xml", category: "tech", language: "en", label: "The Verge" },
    { url: "https://feeds.feedburner.com/venturebeat/SZYF", category: "tech", language: "en", label: "VentureBeat" },
  ],
  science: [
    { url: "https://www.nature.com/nature.rss", category: "science", language: "en", label: "Nature" },
    { url: "https://www.sciencedaily.com/rss/all.xml", category: "science", language: "en", label: "Science Daily" },
    { url: "https://phys.org/rss-feed/", category: "science", language: "en", label: "Phys.org" },
    { url: "http://export.arxiv.org/rss/cs.AI", category: "science", language: "en", label: "arXiv AI" },
    { url: "http://export.arxiv.org/rss/cs.LG", category: "science", language: "en", label: "arXiv ML" },
  ],
  japan: [
    { url: "https://www3.nhk.or.jp/rss/news/cat0.xml", category: "japan", language: "ja", label: "NHKニュース" },
    { url: "https://www.japantimes.co.jp/feed/", category: "japan", language: "en", label: "Japan Times" },
    { url: "https://english.kyodonews.net/rss/all.xml", category: "japan", language: "en", label: "共同通信（英語）" },
    { url: "https://asia.nikkei.com/rss/feed/nar", category: "japan", language: "en", label: "Nikkei Asia" },
  ],
  international: [
    { url: "https://feeds.bbci.co.uk/japanese/rss.xml", category: "international", language: "ja", label: "BBC News Japan" },
    { url: "https://feeds.reuters.com/reuters/topNews", category: "international", language: "en", label: "Reuters Top News" },
    { url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", category: "international", language: "en", label: "NYT World" },
    { url: "https://www.aljazeera.com/xml/rss/all.xml", category: "international", language: "en", label: "Al Jazeera" },
    { url: "https://www.theguardian.com/world/rss", category: "international", language: "en", label: "The Guardian World" },
    { url: "https://foreignpolicy.com/feed/", category: "international", language: "en", label: "Foreign Policy" },
  ],
};

// 後方互換性のため全フィードを結合したリスト（collectNews() で使用）
export const RSS_FEEDS: RssFeed[] = Object.values(FEEDS_BY_CATEGORY).flat();

export const PODCAST_CONFIG = {
  title: "知のわんこそば",
  description: "毎週、世の中のホットトピックスをAIが解説するポッドキャスト。",
  language: "ja",
  maxTopics: 25,
  daysBack: 7,
  hackernewsStories: 20,
  llm: {
    model: "gpt-4o",
    maxTokens: 4096,
    temperature: 0.85,
  },
  tts: {
    model: "tts-1",
    speed: 1.0,
    chunkMaxChars: 3500,
  },
} as const;

export const CATEGORY_LABELS: Record<string, string> = {
  tech: "🔬 テクノロジー",
  japan: "🗾 日本",
  international: "🌍 国際",
  science: "🔭 科学",
  general: "📰 一般",
};
