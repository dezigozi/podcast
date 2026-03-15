# 知のわんこそば — AIポッドキャスト生成システム

## これは何？

**「架空のポッドキャスターが架空の放送を永遠に生産し続ける」** パーソナルポッドキャストシステム。
視聴者は自分だけ。自分のためだけに、AIが毎週新しいエピソードを作り続ける。

### 仕組み

```
① ニュース収集（自動）
   NHK・BBC・Reuters・WIRED・MIT Tech Review・Hacker News など
   10以上のソースから今週のホットトピックを自動収集
        ↓
② スクリプト生成（GPT-4o）
   5人のAIキャスターがそれぞれの「立場・性格・得意技」で
   トピックを解説するラジオスクリプトを生成（約6000〜8000文字）
   ※ 単なる要約ではなく、意外なつながりや深掘りを含む
        ↓
③ 音声合成（OpenAI TTS）
   スクリプトをMP3音声に変換（15〜20分 / エピソード）
        ↓
④ 出力
   MP3ファイル → ランニング中などに再生
   feed.xml   → ポッドキャストアプリに登録
```

### ニュースは毎回更新される？

**はい。実行するたびに最新情報を取りに行きます。**

スクリプトを実行した瞬間のRSSフィード・Hacker Newsをリアルタイムで収集するため、
月曜に実行すれば「その週のニュース」が素材になる。
前回と同じ日に実行しても、ニュースが変わっていれば内容も変わる。

### なぜおもしろいのか

- **5人が同じニュースを語る**のに、政治的スタンスが違うので全然違う視点になる
- 単なるニュース要約ではなく、**意外な接続**を作る（株価指数→テセウスの船のパラドックス、など）
- 難しい専門用語も **ランニング中に聴いて分かるレベル** に噛み砕いてくれる
- 自分の興味・ペースに合わせて、好きなキャスターだけ聴けばいい

---

毎週のホットトピックスを5人のAIキャスターがそれぞれの立場で解説するポッドキャストを自動生成するシステム。
スクリプト生成（GPT-4o）+ 音声合成（OpenAI TTS）で、MP3ファイルとして出力する。

---

## キャスター一覧

| ID | 名前 | スタンス | 得意技 |
|---|---|---|---|
| `centrist` | 山田一郎 | 中道・バランス重視 | 対立する意見の共通点を掘り下げる |
| `progressive` | 田中美咲 | 革新・左派、社会的公正重視 | マクロ問題を個人の体験に落とし込む |
| `conservative` | 鈴木健一 | 保守・右派、歴史と現実主義 | 現代の問題を歴史的失敗・成功と対照させる |
| `tech_optimist` | 橋本ケン | テック楽観主義 | 10年後から逆算して現在を語る |
| `philosopher` | 西村哲 | 超党派・哲学的 | ニュースを古代哲学・思考実験と結びつける |

---

## セットアップ（初回のみ）

### 1. OpenAI APIキーを用意する

[platform.openai.com/api-keys](https://platform.openai.com/api-keys) でAPIキーを作成する。`sk-` で始まる文字列。

### 2. .envファイルを作る

```bash
cd "/Users/dezigozigmail.com/Dropbox/会社/仕事/マイドキュメント/Ｍ／G/生産性向上(働き方改革)/AI/■PB/ポッドキャスト"
cp .env.example .env
open .env
```

テキストエディタが開くので、`sk-xxxxxxx...` の部分を自分のAPIキーに書き換えて保存。

```
OPENAI_API_KEY=sk-ここに自分のキーを貼る
PODCAST_BASE_URL=http://localhost:8000
```

### 3. 依存パッケージのインストール（初回のみ）

```bash
pip3 install -r requirements.txt --user
```

---

## 使い方

### ターミナルでこのフォルダに移動

```bash
cd "/Users/dezigozigmail.com/Dropbox/会社/仕事/マイドキュメント/Ｍ／G/生産性向上(働き方改革)/AI/■PB/ポッドキャスト"
```

---

### パターン A：まずスクリプトだけ試す（音声なし・無料確認）

初めて使うときはここから。音声生成なしで動作確認できる。

```bash
python3 generate_episode.py --no-audio -p philosopher
```

→ `output/YYYY-MM-DD/philosopher_script.txt` にスクリプトが生成される。内容を確認してから音声生成へ。

---

### パターン B：1人だけ音声つきで生成

```bash
python3 generate_episode.py -p philosopher
```

お気に入りのキャスターIDを指定する（`centrist` / `progressive` / `conservative` / `tech_optimist` / `philosopher`）。

---

### パターン C：全キャスター5人分を一括生成

```bash
python3 generate_episode.py
```

時間がかかる（10〜20分程度）が、5人分のスクリプト＋音声が一気に揃う。

---

### ペルソナ一覧を確認する

```bash
python3 generate_episode.py --list-personas
```

---

## 出力ファイル

実行後、`output/YYYY-MM-DD/` フォルダに以下が生成される。

```
output/
└── 2026-03-14/
    ├── topics.json                  # 収集したニュース一覧（確認用）
    ├── philosopher_script.txt       # 西村哲のスクリプト全文
    ├── philosopher.mp3              # 西村哲の音声（← これを聴く）
    ├── centrist_script.txt
    ├── centrist.mp3
    ├── progressive_script.txt
    ├── progressive.mp3
    └── episodes.json                # メタデータ
```

---

## MP3の聴き方

### Finderから直接再生

`output/YYYY-MM-DD/` フォルダを Finder で開いて、MP3をダブルクリック → QuickTimeで再生。

### iPhoneで聴く

このフォルダはDropbox内にあるので、iPhoneのDropboxアプリかファイルアプリから直接再生できる。

### ランニング中に聴く（おすすめ）

生成したMP3をApple ミュージック・Overcast・その他のポッドキャストアプリに手動で追加する。
または `feed.xml`（音声生成時に自動生成）をポッドキャストアプリに登録すると、自動で新エピソードが届く。

---

## 毎週自動実行（cron設定）

毎週月曜の朝7時に自動生成したい場合：

```bash
crontab -e
```

以下を追加して保存（`i` で編集モード、`:wq` で保存）：

```
0 7 * * 1 cd "/Users/dezigozigmail.com/Dropbox/会社/仕事/マイドキュメント/Ｍ／G/生産性向上(働き方改革)/AI/■PB/ポッドキャスト" && python3 generate_episode.py >> output/cron.log 2>&1
```

---

## コマンドオプション一覧

| オプション | 説明 | 例 |
|---|---|---|
| `-p` / `--persona` | キャスターを指定（デフォルト: all） | `-p philosopher` |
| `--no-audio` | スクリプトのみ生成（音声なし） | `--no-audio` |
| `-o` / `--output-dir` | 出力先フォルダを変更 | `-o ~/Desktop/podcast` |
| `--list-personas` | キャスター一覧を表示して終了 | `--list-personas` |

---

## コスト目安

1エピソード（約15〜20分）あたりの概算：

| 処理 | モデル | コスト |
|---|---|---|
| スクリプト生成 | GPT-4o | 約 $0.05〜0.10 |
| 音声生成 | TTS-1 | 約 $0.10〜0.15 |
| **1キャスター合計** | | **約 $0.15〜0.25** |
| **5人全員分** | | **約 $0.75〜1.25** |

月4回（毎週）全員生成した場合：**約 $3〜5/月**

---

## カスタマイズ

### キャスターの性格を変える

`config/personas.yaml` を編集する。`description`（人物設定）、`stance`（スタンス）、`style`（話し方）を書き換えるだけでキャラが変わる。

### ニュースソースを追加・変更する

`config/settings.yaml` の `rss_feeds` リストにRSSのURLを追加する。

### 話す速度を変える

`config/settings.yaml` の `tts.speed` を変更する（`1.0` = 標準、`1.15` くらいが聴きやすい）。

### モデルを変える

`config/settings.yaml` の `llm.model` を `gpt-4o-mini` にするとコストが約1/10になる（品質は少し落ちる）。

---

## トラブルシューティング

**`OPENAI_API_KEY が設定されていません` と出る**
→ `.env` ファイルが存在するか確認。`.env.example` をコピーして `.env` を作ったか確認。

**ニュースが0件と出る**
→ ネットワーク接続を確認。RSSフィードのURLが変わっている可能性があるので `config/settings.yaml` を見直す。

**音声ファイルが途中で切れる**
→ `config/settings.yaml` の `llm.max_tokens` を `4096` より小さくするか、`tts.speed` を上げて文字数を減らす。

---

*作成日: 2026-03-14*
