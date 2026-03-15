// RSSフィード一覧 — config/settings.yaml をTypeScript定数に移植

export interface RssFeed {
  url: string;
  category: string;
  language: string;
  label: string;
}

export const RSS_FEEDS: RssFeed[] = [
  // 日本語ニュース
  {
    url: "https://www3.nhk.or.jp/rss/news/cat0.xml",
    category: "japan",
    language: "ja",
    label: "NHKニュース",
  },
  {
    url: "https://feeds.bbci.co.uk/japanese/rss.xml",
    category: "international",
    language: "ja",
    label: "BBC News Japan",
  },
  // 英語テクノロジー
  {
    url: "https://www.technologyreview.com/feed/",
    category: "tech",
    language: "en",
    label: "MIT Technology Review",
  },
  {
    url: "https://www.wired.com/feed/rss",
    category: "tech",
    language: "en",
    label: "WIRED",
  },
  // 英語国際ニュース
  {
    url: "https://feeds.reuters.com/reuters/topNews",
    category: "international",
    language: "en",
    label: "Reuters Top News",
  },
  {
    url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
    category: "tech",
    language: "en",
    label: "NYT Technology",
  },
  {
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    category: "international",
    language: "en",
    label: "NYT World",
  },
  // 科学・学術
  {
    url: "https://www.nature.com/nature.rss",
    category: "science",
    language: "en",
    label: "Nature",
  },
];

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
