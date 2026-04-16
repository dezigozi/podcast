# ポッドキャストAI — デプロイ作業メモ

> 作成日: 2026-03-16

---

## 今回やったこと（初回セットアップ）

### 1. OpenAI APIキーの設定

**ローカル開発用（.dev.vars）**
```
OPENAI_API_KEY=sk-proj-xxxxxx
```
- `worker/.dev.vars` に保存（GitHubには絶対にpushしない）
- `.gitignore` に `.dev.vars` を追加済み ✅

**本番Cloudflare Workers用**
```bash
echo "sk-proj-xxxxxx" | npx wrangler secret put OPENAI_API_KEY
```
- Cloudflareダッシュボードの Workers → podcast → Settings → Variables で確認可能

---

### 2. GitHub Actions 自動デプロイの設定

**.github/workflows/deploy.yml** を作成
- `main` ブランチにpushするたびに自動デプロイ（約44秒）

**GitHub Secrets に登録した情報**
| Secret名 | 説明 |
|---------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（Edit Cloudflare Workers権限） |
| `CLOUDFLARE_ACCOUNT_ID` | `823f1e10d0dfd3a8f849f6b61750a859` |

**GitHubトークンの権限**
- `repo` + `workflow` の両方が必要（classicトークンを使用）

---

### 3. 初回デプロイ完了

- GitHub Actions ✅ 成功（44秒）
- Cloudflare Workers に `podcast` Worker がデプロイ済み

---

## 次回からの作業（コード変更→デプロイ）

**たったこれだけ！**

```bash
git add .
git commit -m "変更内容のメモ"
git push origin main
```

→ GitHub Actionsが自動で起動し、約44秒でCloudflareに反映される。

---

## トラブルシューティング

### エラー: OpenAI API 401
**原因**: APIキーが設定されていない  
**対処**: `worker/.dev.vars` にキーを追加、またはCloudflare Secretsを確認

### GitHub pushが拒否される
**原因**: GitHubトークンに `workflow` スコープがない  
**対処**: https://github.com/settings/tokens でトークンを更新

### GitHub Actions が失敗する
**確認場所**: https://github.com/dezigozi/podcast/actions  
**よくある原因**: 
- `CLOUDFLARE_API_TOKEN` または `CLOUDFLARE_ACCOUNT_ID` が未設定
- → https://github.com/dezigozi/podcast/settings/secrets/actions で確認

---

## 重要なファイルとURL

| 項目 | 場所 |
|-----|------|
| ローカルAPIキー | `worker/.dev.vars` |
| デプロイ設定 | `.github/workflows/deploy.yml` |
| GitHub Actions | https://github.com/dezigozi/podcast/actions |
| GitHub Secrets | https://github.com/dezigozi/podcast/settings/secrets/actions |
| Cloudflare Dashboard | https://dash.cloudflare.com |
| OpenAI APIキー管理 | https://platform.openai.com/api-keys |

---

## セキュリティ注意事項

- ⚠️ `.dev.vars` はGitHubにpushしない（.gitignoreで除外済み）
- ⚠️ APIキーをチャットやメモに貼り付けない
- ⚠️ GitHubトークンは定期的に更新する（現在のトークン有効期限: 2026-06-14）
