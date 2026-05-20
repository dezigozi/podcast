// メインWorker — APIエンドポイント + フロントエンドUI + Cron Trigger
// Queueの代わりに ctx.waitUntil() でバックグラウンド生成を実行

import { PERSONAS, PERSONA_IDS } from "./personas";
import { fetchNewsForPersona, buildNewsPromptForPersona } from "./collector";
import { generateScript } from "./script-generator";
import { generateAudio } from "./audio-generator";

function getPersonaSourceLabels(feeds: string[]): string {
  return feeds.length <= 4
    ? feeds.join(" · ")
    : feeds.slice(0, 4).join(" · ") + ` +${feeds.length - 4}`;
}

export interface Env {
  OPENAI_API_KEY: string;
  PODCAST_BUCKET: R2Bucket;
  PODCAST_KV: KVNamespace;
}

export interface GenerateJob {
  jobId: string;
  persona: string;
  noAudio?: boolean;
  createdAt: string;
}

export interface JobStatus {
  status: "queued" | "running" | "done" | "error";
  persona: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  results?: Array<{
    personaId: string;
    personaName: string;
    scriptKey: string;
    audioKey?: string;
    audioUrl?: string;
    scriptLength: number;
    error?: string;
  }>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ルーティング
    if (url.pathname === "/" || url.pathname === "") {
      return serveUI();
    }
    if (url.pathname === "/api/generate" && request.method === "POST") {
      return handleGenerate(request, env, ctx);
    }
    if (url.pathname.startsWith("/api/status/")) {
      const jobId = url.pathname.split("/api/status/")[1];
      return handleStatus(jobId, env);
    }
    if (url.pathname === "/api/episodes") {
      return handleEpisodes(env);
    }
    if (url.pathname === "/api/cron-status") {
      return handleCronStatus(env);
    }
    if (url.pathname.startsWith("/audio/")) {
      const key = url.pathname.replace("/audio/", "");
      return handleAudio(key, env, request);
    }
    if (url.pathname.startsWith("/api/episodes/") && request.method === "DELETE") {
      const jobId = url.pathname.split("/api/episodes/")[1];
      return handleDeleteEpisode(jobId, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  // Cron Trigger — 毎週月曜 09:00 JST に全キャスター自動生成
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const jobId = `cron-${Date.now()}`;
    const job: GenerateJob = {
      jobId,
      persona: "all",
      noAudio: false,
      createdAt: new Date().toISOString(),
    };
    const queuedStatus: JobStatus = {
      status: "queued",
      persona: "all",
      createdAt: job.createdAt,
    };
    await env.PODCAST_KV.put(`job:${jobId}`, JSON.stringify(queuedStatus), {
      expirationTtl: 86400 * 7,
    });
    // 最終 cron 実行の jobId を記録（UI から確認できるようにする）
    await env.PODCAST_KV.put("cron:last-job-id", jobId, { expirationTtl: 86400 * 30 });
    // バックグラウンドで生成処理を実行
    ctx.waitUntil(processJob(job, env));
  },
};



// ─── Queue処理（ポッドキャスト生成パイプライン）───────────────────────────
async function processJob(job: GenerateJob, env: Env): Promise<void> {
  const dateStr = new Date().toISOString().split("T")[0];

  const runningStatus: JobStatus = {
    status: "running",
    persona: job.persona,
    createdAt: job.createdAt,
    startedAt: new Date().toISOString(),
  };
  await env.PODCAST_KV.put(`job:${job.jobId}`, JSON.stringify(runningStatus), { expirationTtl: 86400 * 3 });

  try {
    const personaIds = job.persona === "all" ? [...PERSONA_IDS] : [job.persona];
    const results: NonNullable<JobStatus["results"]> = [];

    for (const personaId of personaIds) {
      const persona = PERSONAS[personaId];
      if (!persona) continue;

      try {
        // キャスターの expertise に合わせた専用ソースからニュースを取得
        const newsItems = await fetchNewsForPersona(persona);
        const newsPrompt = buildNewsPromptForPersona(newsItems, persona.expertise);

        const script = await generateScript(newsPrompt, persona, env.OPENAI_API_KEY);

        const scriptKey = `${dateStr}/${personaId}_script.txt`;
        await env.PODCAST_BUCKET.put(scriptKey, script, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });

        const result: NonNullable<JobStatus["results"]>[number] = {
          personaId,
          personaName: persona.name,
          scriptKey,
          scriptLength: script.length,
        };

        if (!job.noAudio) {
          const audioBytes = await generateAudio(script, persona.voice, env.OPENAI_API_KEY);
          const audioKey = `${dateStr}/${personaId}.mp3`;
          await env.PODCAST_BUCKET.put(audioKey, audioBytes, {
            httpMetadata: { contentType: "audio/mpeg" },
          });
          result.audioKey = audioKey;
          result.audioUrl = `/audio/${audioKey}`;
        }
        results.push(result);
      } catch (personaErr) {
        // 1キャスターのエラーで全体を止めない
        console.error(`[${personaId}] 生成エラー:`, personaErr);
        results.push({
          personaId,
          personaName: persona.name,
          scriptKey: "",
          scriptLength: 0,
          error: String(personaErr),
        });
      }
    }

    const successCount = results.filter((r) => !r.error).length;
    const doneStatus: JobStatus = {
      status: successCount > 0 ? "done" : "error",
      persona: job.persona,
      createdAt: job.createdAt,
      startedAt: runningStatus.startedAt,
      completedAt: new Date().toISOString(),
      results,
      error: successCount === 0 ? "全キャスターの生成に失敗しました" : undefined,
    };
    await env.PODCAST_KV.put(`job:${job.jobId}`, JSON.stringify(doneStatus), { expirationTtl: 86400 * 7 });

    // 成功したキャスターがいる場合のみエピソードリストに追加
    if (successCount > 0) {
      const allEpisodesJson = await env.PODCAST_KV.get("episodes:all");
      const allEpisodes = allEpisodesJson ? JSON.parse(allEpisodesJson) : [];
      allEpisodes.unshift({ jobId: job.jobId, date: dateStr, results: results.filter((r) => !r.error) });
      await env.PODCAST_KV.put("episodes:all", JSON.stringify(allEpisodes.slice(0, 50)));
    }
  } catch (err) {
    const errorStatus: JobStatus = {
      status: "error",
      persona: job.persona,
      createdAt: job.createdAt,
      startedAt: runningStatus.startedAt,
      error: String(err),
    };
    await env.PODCAST_KV.put(`job:${job.jobId}`, JSON.stringify(errorStatus), { expirationTtl: 86400 * 7 });
    throw err;
  }
}



// POST /api/generate
async function handleGenerate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: { persona?: string; no_audio?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // JSON解析失敗は無視しデフォルト値を使う
  }

  const persona = body.persona ?? "all";
  const noAudio = body.no_audio ?? false;

  // バリデーション
  if (persona !== "all" && !PERSONA_IDS.includes(persona as typeof PERSONA_IDS[number])) {
    return jsonResponse({ error: `不明なペルソナID: ${persona}` }, 400);
  }

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: GenerateJob = {
    jobId,
    persona,
    noAudio,
    createdAt: new Date().toISOString(),
  };

  // KVにキューステータスを保存
  const queuedStatus: JobStatus = {
    status: "queued",
    persona,
    createdAt: job.createdAt,
  };
  await env.PODCAST_KV.put(`job:${jobId}`, JSON.stringify(queuedStatus), {
    expirationTtl: 86400 * 7,
  });

  // バックグラウンドで生成処理を実行（ctx.waitUntil でレスポンス後も継続）
  ctx.waitUntil(processJob(job, env));

  return jsonResponse({ jobId, status: "queued", message: "生成ジョブを受け付けました。数分後に完了します。" });
}

// GET /api/status/:jobId
async function handleStatus(jobId: string, env: Env): Promise<Response> {
  if (!jobId) return jsonResponse({ error: "jobId が必要です" }, 400);
  const data = await env.PODCAST_KV.get(`job:${jobId}`);
  if (!data) return jsonResponse({ error: "ジョブが見つかりません" }, 404);
  return jsonResponse(JSON.parse(data));
}

// GET /api/episodes
async function handleEpisodes(env: Env): Promise<Response> {
  try {
    const data = await env.PODCAST_KV.get("episodes:all");
    const episodes = data ? JSON.parse(data) : [];
    return jsonResponse({ episodes });
  } catch (err) {
    return jsonResponse({ episodes: [], error: String(err) }, 200);
  }
}

// GET /api/cron-status — 最終 cron 実行状況
async function handleCronStatus(env: Env): Promise<Response> {
  const lastJobId = await env.PODCAST_KV.get("cron:last-job-id");
  if (!lastJobId) return jsonResponse({ status: "never", message: "cron はまだ実行されていません" });
  const data = await env.PODCAST_KV.get(`job:${lastJobId}`);
  if (!data) return jsonResponse({ status: "expired", jobId: lastJobId, message: "実行記録が期限切れです" });
  return jsonResponse({ jobId: lastJobId, ...JSON.parse(data) });
}

// DELETE /api/episodes/:jobId
async function handleDeleteEpisode(jobId: string, env: Env): Promise<Response> {
  if (!jobId) return jsonResponse({ error: "jobId が必要です" }, 400);

  try {
    // KVからエピソード一覧を取得
    const data = await env.PODCAST_KV.get("episodes:all");
    const episodes = data ? JSON.parse(data) : [];

    // 対象エピソードを探す
    const episodeIndex = episodes.findIndex((ep: any) => ep.jobId === jobId);
    if (episodeIndex === -1) {
      return jsonResponse({ error: "エピソードが見つかりません" }, 404);
    }

    const episode = episodes[episodeIndex];

    // R2 から関連ファイルを削除
    if (episode.results && Array.isArray(episode.results)) {
      for (const result of episode.results) {
        // scriptKey と audioKey を削除
        if (result.scriptKey) {
          try {
            await env.PODCAST_BUCKET.delete(result.scriptKey);
          } catch (e) {
            console.warn(`Failed to delete script: ${result.scriptKey}`, e);
          }
        }
        if (result.audioKey) {
          try {
            await env.PODCAST_BUCKET.delete(result.audioKey);
          } catch (e) {
            console.warn(`Failed to delete audio: ${result.audioKey}`, e);
          }
        }
      }
    }

    // エピソードリストから削除
    episodes.splice(episodeIndex, 1);
    await env.PODCAST_KV.put("episodes:all", JSON.stringify(episodes));

    return jsonResponse({ success: true, message: "エピソードを削除しました" });
  } catch (err) {
    console.error("Delete error:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
}

// GET /audio/:key — R2からMP3を配信（Range リクエスト対応）
async function handleAudio(key: string, env: Env, request: Request): Promise<Response> {
  const rangeHeader = request.headers.get("Range");

  const object = rangeHeader
    ? await env.PODCAST_BUCKET.get(key, { range: request.headers })
    : await env.PODCAST_BUCKET.get(key);

  if (!object) return new Response("Not Found", { status: 404 });

  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Cache-Control": "public, max-age=86400",
    "Accept-Ranges": "bytes",
  });

  if (rangeHeader && object.range) {
    const range = object.range as { offset?: number; length?: number; suffix?: number };
    const offset = "suffix" in range && range.suffix !== undefined
      ? object.size - range.suffix
      : (range.offset ?? 0);
    const length = range.suffix !== undefined
      ? range.suffix
      : (range.length ?? object.size - offset);
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

// フロントエンドUI
function serveUI(): Response {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>知のわんこそば 🍜</title>
  <style>
    :root {
      --bg: #0f0f13;
      --surface: #1a1a24;
      --border: #2a2a3a;
      --accent: #7c6aff;
      --accent2: #ff6aaa;
      --text: #e8e8f0;
      --text-dim: #888899;
      --success: #4ade80;
      --error: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      padding: 0 0 80px;
    }
    header {
      background: linear-gradient(135deg, #1a1a2e, #16213e);
      padding: 32px 20px 24px;
      text-align: center;
      border-bottom: 1px solid var(--border);
    }
    header h1 { font-size: 1.8rem; font-weight: 700; letter-spacing: -0.02em; }
    header h1 span { color: var(--accent); }
    header p { color: var(--text-dim); margin-top: 6px; font-size: 0.9rem; }
    .container { max-width: 600px; margin: 0 auto; padding: 24px 16px; }
    h2 { font-size: 1rem; font-weight: 600; color: var(--text-dim); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .persona-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    .persona-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 12px;
      cursor: pointer;
      text-align: left;
      transition: all 0.2s;
      color: var(--text);
    }
    .persona-btn:hover { border-color: var(--accent); background: #1e1e30; transform: translateY(-1px); }
    .persona-btn.selected { border-color: var(--accent); background: rgba(124, 106, 255, 0.15); }
    .persona-btn .name { font-weight: 600; font-size: 0.95rem; }
    .persona-btn .title { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }
    .persona-btn .sources { font-size: 0.65rem; color: var(--text-dim); margin-top: 5px; opacity: 0.7; line-height: 1.4; }
    .all-btn {
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border: none;
      border-radius: 12px;
      padding: 14px 12px;
      cursor: pointer;
      text-align: center;
      color: white;
      font-weight: 700;
      font-size: 1rem;
      width: 100%;
      margin-bottom: 24px;
      transition: all 0.2s;
    }
    .all-btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .generate-btn {
      width: 100%;
      padding: 16px;
      background: var(--accent);
      color: white;
      font-size: 1.05rem;
      font-weight: 700;
      border: none;
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.2s;
      margin-top: 16px;
    }
    .generate-btn:hover:not(:disabled) { background: #6b59ee; transform: translateY(-1px); }
    .generate-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .status-box {
      margin-top: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
      display: none;
    }
    .status-box.visible { display: block; }
    .status-label { font-size: 0.85rem; color: var(--text-dim); margin-bottom: 8px; }
    .status-text { font-weight: 600; font-size: 1rem; }
    .spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .result-item {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      margin-top: 10px;
    }
    .result-item .caster-name { font-weight: 600; margin-bottom: 8px; }
    audio { width: 100%; margin-top: 8px; border-radius: 8px; }
    .script-link { font-size: 0.8rem; color: var(--accent); text-decoration: none; margin-top: 4px; display: inline-block; }
    .episodes-section { margin-top: 40px; }
    .episode-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .episode-date { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .episode-date-text { flex: 1; }
    .delete-btn {
      background: var(--error);
      color: white;
      border: none;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .delete-btn:hover { opacity: 0.8; }
    .divider { height: 1px; background: var(--border); margin: 28px 0; }
  </style>
</head>
<body>
  <header>
    <h1>知のわんこそば <span>🍜</span></h1>
    <p>AIキャスターが今週のニュースを語るポッドキャスト</p>
  </header>

  <div class="container">
    <div style="margin-bottom: 24px;">
      <h2 style="margin-bottom: 12px;">キャスターを選ぶ</h2>
      <button class="all-btn" onclick="selectPersona('all')">🎙️ 全員分まとめて生成</button>
      <div class="persona-grid" id="personaGrid">
        ${Object.entries(PERSONAS).map(([id, p]) =>
          `<button class="persona-btn${id === "philosopher" ? " selected" : ""}" id="btn-${id}" onclick="selectPersona('${id}')">`
          + `<div class="name">${p.name}</div>`
          + `<div class="title">${p.title}</div>`
          + `<div class="sources">📡 ${getPersonaSourceLabels(p.feeds)}</div>`
          + `</button>`
        ).join("")}
      </div>
      <button class="generate-btn" id="generateBtn" onclick="startGenerate()">選択したキャスターで生成する</button>
    </div>

    <div class="status-box" id="statusBox">
      <div class="status-label">生成ステータス</div>
      <div class="status-text" id="statusText"></div>
      <div id="resultsArea"></div>
    </div>

    <div class="divider"></div>

    <div style="margin-bottom: 24px;">
      <h2>スケジュール実行状況</h2>
      <div id="cronStatus" style="font-size:0.85rem;color:var(--text-dim);">確認中...</div>
    </div>

    <div class="episodes-section">
      <h2>過去のエピソード</h2>
      <div id="episodesList"><div style="color: var(--text-dim); font-size: 0.9rem;">読み込み中...</div></div>
    </div>
  </div>

  <script>
    function escapeHtml(text) {
      const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      };
      return text.replace(/[&<>"']/g, (char) => map[char]);
    }

    let selectedPersona = 'philosopher';
    let currentJobId = null;
    let pollInterval = null;

    function selectPersona(id) {
      selectedPersona = id;
      document.querySelectorAll('.persona-btn').forEach(b => b.classList.remove('selected'));
      const btn = document.getElementById('btn-' + id);
      if (btn) btn.classList.add('selected');
    }

    async function startGenerate() {
      const btn = document.getElementById('generateBtn');
      btn.disabled = true;
      const statusBox = document.getElementById('statusBox');
      const statusText = document.getElementById('statusText');
      statusBox.classList.add('visible');
      statusText.innerHTML = '<span class="spinner"></span>生成ジョブを送信中...';
      document.getElementById('resultsArea').innerHTML = '';

      try {
        const resp = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona: selectedPersona }),
        });
        const data = await resp.json();
        currentJobId = data.jobId;
        statusText.innerHTML = '<span class="spinner"></span>生成受付完了 — 数分後に完了します...';

        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(pollStatus, 4000);
      } catch (e) {
        statusText.innerHTML = '<span style="color:var(--error)">❌ エラー: ' + escapeHtml(e.message) + '</span>';
        btn.disabled = false;
      }
    }

    async function pollStatus() {
      if (!currentJobId) return;
      try {
        const resp = await fetch('/api/status/' + currentJobId);
        const data = await resp.json();
        const statusText = document.getElementById('statusText');

        if (data.status === 'done') {
          clearInterval(pollInterval);
          statusText.innerHTML = '✅ 生成完了！';
          renderResults(data.results ?? []);
          document.getElementById('generateBtn').disabled = false;
          loadEpisodes();
        } else if (data.status === 'error') {
          clearInterval(pollInterval);
          statusText.innerHTML = '<span style="color:var(--error)">❌ エラー: ' + escapeHtml(data.error ?? '不明なエラー') + '</span>';
          document.getElementById('generateBtn').disabled = false;
        } else if (data.status === 'running') {
          statusText.innerHTML = '<span class="spinner"></span>生成中... しばらくお待ちください';
        }
      } catch (_e) {
        // ポーリングエラーは無視
      }
    }

    function renderResults(results) {
      const area = document.getElementById('resultsArea');
      area.innerHTML = results.map(r => {
        const audioHtml = r.audioUrl
          ? '<audio controls src="' + escapeHtml(r.audioUrl) + '"></audio>'
          : '<div style="color:var(--text-dim);font-size:0.8rem;margin-top:6px;">（音声なし）</div>';
        return '<div class="result-item">'
          + '<div class="caster-name">🎙️ ' + escapeHtml(r.personaName) + '</div>'
          + audioHtml
          + '</div>';
      }).join('');
    }

    async function loadEpisodes() {
      const list = document.getElementById('episodesList');
      if (!list) return;
      try {
        const resp = await fetch('/api/episodes', { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) {
          list.innerHTML = '<div style="color:var(--error)">サーバーエラー: HTTP ' + escapeHtml(resp.status.toString()) + '</div>';
          return;
        }
        const data = await resp.json();
        if (!data.episodes || data.episodes.length === 0) {
          list.innerHTML = '<div style="color:var(--text-dim);font-size:0.9rem;">まだエピソードがありません</div>';
          return;
        }
        list.innerHTML = data.episodes.slice(0, 10).map(ep => {
          const resultsHtml = (ep.results ?? []).map(r =>
            '<div style="margin-top:8px;">'
            + '<div style="font-size:0.85rem;font-weight:600;margin-bottom:4px;">🎙️ ' + escapeHtml(r.personaName) + '</div>'
            + (r.audioUrl ? '<audio controls src="' + escapeHtml(r.audioUrl) + '" style="width:100%"></audio>' : '')
            + '</div>'
          ).join('');
          return '<div class="episode-card">'
            + '<div class="episode-date">'
            + '<span class="episode-date-text">📅 ' + escapeHtml(ep.date) + '</span>'
            + '<button class="delete-btn" data-job-id="' + escapeHtml(ep.jobId) + '" onclick="deleteEpisode(this.dataset.jobId)">削除</button>'
            + '</div>'
            + resultsHtml
            + '</div>';
        }).join('');
      } catch (e) {
        list.innerHTML = '<div style="color:var(--error)">読み込みエラー: ' + escapeHtml(e.message) + '</div>';
      }
    }

    async function deleteEpisode(jobId) {
      if (!confirm('このエピソードを削除してもよろしいですか？')) {
        return;
      }
      try {
        const resp = await fetch('/api/episodes/' + jobId, { method: 'DELETE' });
        const data = await resp.json();
        if (resp.ok) {
          loadEpisodes();
        } else {
          alert('削除失敗: ' + (data.error ?? '不明なエラー'));
        }
      } catch (e) {
        alert('削除エラー: ' + (e instanceof Error ? e.message : '不明なエラー'));
      }
    }

    async function loadCronStatus() {
      try {
        const resp = await fetch('/api/cron-status');
        const data = await resp.json();
        const el = document.getElementById('cronStatus');
        if (data.status === 'never') {
          el.innerHTML = '⏰ 毎週月曜 09:00 JST に自動生成 — まだ実行されていません';
        } else if (data.status === 'expired') {
          el.innerHTML = '⏰ 毎週月曜 09:00 JST に自動生成 — 最終実行記録は期限切れです';
        } else if (data.status === 'done') {
          const successCount = (data.results ?? []).filter(r => !r.error).length;
          const errorCount = (data.results ?? []).filter(r => r.error).length;
          const dateStr = new Date(data.completedAt).toLocaleString('ja-JP');
          const errNote = errorCount > 0 ? ' <span style="color:var(--error)">（' + errorCount + 'キャスター失敗）</span>' : '';
          el.innerHTML = '✅ 最終実行: ' + escapeHtml(dateStr) + ' — ' + successCount + 'キャスター成功' + errNote;
          if (errorCount > 0) {
            const errors = (data.results ?? []).filter(r => r.error).map(r =>
              '<div style="margin-top:4px;color:var(--error);font-size:0.8rem;">❌ ' + escapeHtml(r.personaName) + ': ' + escapeHtml(r.error) + '</div>'
            ).join('');
            el.innerHTML += errors;
          }
        } else if (data.status === 'error') {
          const dateStr = data.startedAt ? new Date(data.startedAt).toLocaleString('ja-JP') : '不明';
          el.innerHTML = '<span style="color:var(--error)">❌ 最終実行: ' + escapeHtml(dateStr) + ' — エラー: ' + escapeHtml(data.error ?? '不明') + '</span>';
        } else if (data.status === 'running' || data.status === 'queued') {
          el.innerHTML = '<span class="spinner"></span>現在生成中...';
        }
      } catch (_e) {
        document.getElementById('cronStatus').innerHTML = '⏰ 毎週月曜 09:00 JST に自動生成';
      }
    }

    loadEpisodes();
    loadCronStatus();
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
