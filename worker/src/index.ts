// メインWorker — APIエンドポイント + フロントエンドUI + Cron Trigger
// Queue で長時間の生成処理を実行（Worker 30秒制限を回避）

import { PERSONAS, PERSONA_IDS } from "./personas";
import { collectNews, buildNewsPrompt, partitionNewsAmongPersonas } from "./collector";
import { generateScript } from "./script-generator";
import { generateAudio } from "./audio-generator";

export interface Env {
  OPENAI_API_KEY: string;
  PODCAST_BUCKET: R2Bucket;
  PODCAST_KV: KVNamespace;
  PODCAST_QUEUE: Queue;
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
  }>;
}

/** KV `episodes:all` の1要素 */
export interface EpisodeEntry {
  jobId: string;
  date: string;
  results: JobStatus["results"];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return serveUI();
    }
    if (url.pathname === "/api/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }
    if (url.pathname.startsWith("/api/status/")) {
      const jobId = url.pathname.split("/api/status/")[1];
      return handleStatus(jobId, env);
    }
    if (url.pathname === "/api/episodes" && request.method === "GET") {
      return handleEpisodes(env);
    }
    if (url.pathname.startsWith("/api/episodes/") && request.method === "DELETE") {
      const jobId = decodeURIComponent(url.pathname.slice("/api/episodes/".length));
      return handleDeleteEpisode(jobId, env);
    }
    if (url.pathname.startsWith("/audio/")) {
      const key = url.pathname.replace("/audio/", "");
      return handleAudio(key, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
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
    await env.PODCAST_QUEUE.send(job);
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processJob(message.body as GenerateJob, env);
        message.ack();
      } catch (err) {
        message.retry();
      }
    }
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
    const newsItems = await collectNews();

    const personaIds = job.persona === "all" ? [...PERSONA_IDS] : [job.persona];
    const exclusiveTopics = personaIds.length > 1;
    const itemsByPersona = exclusiveTopics
      ? partitionNewsAmongPersonas(newsItems, personaIds)
      : null;

    const results: NonNullable<JobStatus["results"]> = [];

    for (const personaId of personaIds) {
      const persona = PERSONAS[personaId];
      if (!persona) continue;

      const itemsForPersona = itemsByPersona?.[personaId] ?? newsItems;
      const newsPrompt = buildNewsPrompt(itemsForPersona, {
        exclusiveAssignment: exclusiveTopics,
      });
      const script = await generateScript(newsPrompt, persona, env.OPENAI_API_KEY, exclusiveTopics);

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
    }

    const doneStatus: JobStatus = {
      status: "done",
      persona: job.persona,
      createdAt: job.createdAt,
      startedAt: runningStatus.startedAt,
      completedAt: new Date().toISOString(),
      results,
    };
    await env.PODCAST_KV.put(`job:${job.jobId}`, JSON.stringify(doneStatus), { expirationTtl: 86400 * 7 });

    const allEpisodesJson = await env.PODCAST_KV.get("episodes:all");
    const allEpisodes: EpisodeEntry[] = allEpisodesJson ? JSON.parse(allEpisodesJson) : [];
    allEpisodes.unshift({ jobId: job.jobId, date: dateStr, results });
    await env.PODCAST_KV.put("episodes:all", JSON.stringify(allEpisodes.slice(0, 50)));
  } catch (err) {
    const errorStatus: JobStatus = {
      status: "error",
      persona: job.persona,
      createdAt: job.createdAt,
      startedAt: runningStatus.startedAt,
      error: String(err),
    };
    await env.PODCAST_KV.put(`job:${job.jobId}`, JSON.stringify(errorStatus), { expirationTtl: 86400 });
    throw err;
  }
}

// POST /api/generate
async function handleGenerate(request: Request, env: Env): Promise<Response> {
  let body: { persona?: string; no_audio?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // JSON解析失敗は無視しデフォルト値を使う
  }

  const persona = body.persona ?? "all";
  const noAudio = body.no_audio ?? false;

  if (persona !== "all" && !PERSONA_IDS.includes(persona as (typeof PERSONA_IDS)[number])) {
    return jsonResponse({ error: `不明なペルソナID: ${persona}` }, 400);
  }

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: GenerateJob = {
    jobId,
    persona,
    noAudio,
    createdAt: new Date().toISOString(),
  };

  const queuedStatus: JobStatus = {
    status: "queued",
    persona,
    createdAt: job.createdAt,
  };
  await env.PODCAST_KV.put(`job:${jobId}`, JSON.stringify(queuedStatus), {
    expirationTtl: 86400 * 7,
  });

  await env.PODCAST_QUEUE.send(job);

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
  const data = await env.PODCAST_KV.get("episodes:all");
  const episodes: EpisodeEntry[] = data ? JSON.parse(data) : [];
  return jsonResponse({ episodes });
}

// DELETE /api/episodes/:jobId — 一覧から外し、R2 の音声・スクリプトも削除
async function handleDeleteEpisode(jobId: string, env: Env): Promise<Response> {
  if (!jobId) return jsonResponse({ error: "jobId が必要です" }, 400);

  const data = await env.PODCAST_KV.get("episodes:all");
  const allEpisodes: EpisodeEntry[] = data ? JSON.parse(data) : [];
  const idx = allEpisodes.findIndex((e) => e.jobId === jobId);
  if (idx === -1) return jsonResponse({ error: "エピソードが見つかりません" }, 404);

  const removed = allEpisodes[idx];
  for (const r of removed.results ?? []) {
    if (r.scriptKey) await env.PODCAST_BUCKET.delete(r.scriptKey);
    if (r.audioKey) await env.PODCAST_BUCKET.delete(r.audioKey);
  }

  allEpisodes.splice(idx, 1);
  await env.PODCAST_KV.put("episodes:all", JSON.stringify(allEpisodes));
  await env.PODCAST_KV.delete(`job:${jobId}`);

  return jsonResponse({ ok: true, deletedJobId: jobId });
}

// GET /audio/:key — R2からMP3を配信
async function handleAudio(key: string, env: Env): Promise<Response> {
  const object = await env.PODCAST_BUCKET.get(key);
  if (!object) return new Response("Not Found", { status: 404 });

  return new Response(object.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=86400",
      "Accept-Ranges": "bytes",
    },
  });
}

// フロントエンドUI
function serveUI(): Response {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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
    .episode-date { font-size: 0.8rem; color: var(--text-dim); }
    .episode-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .delete-ep-btn {
      background: transparent;
      border: 1px solid var(--error);
      color: var(--error);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 0.75rem;
      cursor: pointer;
      flex-shrink: 0;
    }
    .delete-ep-btn:hover { background: rgba(248, 113, 113, 0.12); }
    .episodes-hint { font-size: 0.8rem; color: var(--text-dim); margin: -6px 0 14px; line-height: 1.45; }
    .divider { height: 1px; background: var(--border); margin: 28px 0; }
  </style>
</head>
<body>
  <header>
    <h1>知のわんこそば 🍜</h1>
    <p>AIキャスターが今週のニュースを語るポッドキャスト</p>
  </header>
  <div class="container">
    <h2>キャスターを選ぶ</h2>
    <button type="button" class="all-btn" onclick="selectPersona('all')">🎙️ 全員分まとめて生成</button>
    <div id="personaGrid" class="persona-grid"></div>
    <button type="button" id="generateBtn" class="generate-btn" onclick="startGenerate()">選択したキャスターで生成する</button>

    <div id="statusBox" class="status-box">
      <div class="status-label">生成ステータス</div>
      <div id="statusText" class="status-text"></div>
      <div id="resultsArea"></div>
    </div>

    <div class="divider"></div>
    <h2>過去のエピソード</h2>
    <p class="episodes-hint">聴き終わった回は「この回を削除」でサーバー上の音声・台本を消せます（ポッドキャストアプリに既にダウンロード済みの場合は、アプリ側の削除は別途お願いします）。</p>
    <div id="episodesList">読み込み中...</div>
  </div>

  <script>
    const PERSONAS = ${JSON.stringify(
      Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, title: p.title }))
    )};

    let selectedPersona = 'philosopher';
    let currentJobId = null;
    let pollInterval = null;

    const grid = document.getElementById('personaGrid');
    PERSONAS.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'persona-btn' + (p.id === selectedPersona ? ' selected' : '');
      btn.id = 'btn-' + p.id;
      btn.innerHTML = '<span class="name">' + p.name + '</span><span class="title">' + p.title + '</span>';
      btn.onclick = () => selectPersona(p.id);
      grid.appendChild(btn);
    });

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
      statusText.innerHTML = '<span class="spinner"></span> 生成ジョブを送信中...';
      document.getElementById('resultsArea').innerHTML = '';

      try {
        const resp = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona: selectedPersona }),
        });
        const data = await resp.json();
        currentJobId = data.jobId;
        statusText.innerHTML = '<span class="spinner"></span> 生成受付完了 — 数分後に完了します...';

        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(pollStatus, 4000);
      } catch (e) {
        statusText.innerHTML = '<span style="color:var(--error)">❌ エラー: ' + e.message + '</span>';
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
          statusText.innerHTML = '<span style="color:var(--error)">❌ エラー: ' + (data.error ?? '不明なエラー') + '</span>';
          document.getElementById('generateBtn').disabled = false;
        } else if (data.status === 'running') {
          statusText.innerHTML = '<span class="spinner"></span> 生成中... しばらくお待ちください';
        }
      } catch (_e) {}
    }

    function renderResults(results) {
      const area = document.getElementById('resultsArea');
      area.innerHTML = results.map(r => {
        const audioHtml = r.audioUrl
          ? '<audio controls src="' + r.audioUrl + '"></audio>'
          : '<span class="text-dim">（音声なし）</span>';
        return '<div class="result-item"><div class="caster-name">🎙️ ' + r.personaName + '</div>' + audioHtml + '</div>';
      }).join('');
    }

    async function loadEpisodes() {
      try {
        const resp = await fetch('/api/episodes');
        const data = await resp.json();
        const list = document.getElementById('episodesList');
        if (!data.episodes || data.episodes.length === 0) {
          list.innerHTML = '<p class="text-dim">まだエピソードがありません</p>';
          return;
        }
        list.innerHTML = data.episodes.slice(0, 10).map(ep => {
          const resultsHtml = (ep.results ?? []).map(r =>
            '<div class="result-item"><span class="caster-name">🎙️ ' + r.personaName + '</span>'
            + (r.audioUrl ? '<audio controls src="' + r.audioUrl + '"></audio>' : '')
            + '</div>'
          ).join('');
          const delBtn = '<button type="button" class="delete-ep-btn" onclick="deleteEpisode(' + JSON.stringify(ep.jobId) + ')">この回を削除</button>';
          return '<div class="episode-card"><div class="episode-head"><div class="episode-date">📅 ' + ep.date + '</div>' + delBtn + '</div>' + resultsHtml + '</div>';
        }).join('');
      } catch (_e) {
        document.getElementById('episodesList').innerHTML = '<p class="text-dim">読み込み失敗</p>';
      }
    }

    async function deleteEpisode(jobId) {
      if (!confirm('この日付のエピソードをサーバーから削除します。\\n（音声・台本ファイルは消え、一覧からも外れます。）\\nよろしいですか？')) return;
      try {
        const resp = await fetch('/api/episodes/' + encodeURIComponent(jobId), { method: 'DELETE' });
        const data = await resp.json().catch(function () { return {}; });
        if (!resp.ok) {
          alert(data.error || '削除に失敗しました');
          return;
        }
        loadEpisodes();
      } catch (e) {
        alert('削除に失敗しました: ' + (e && e.message ? e.message : String(e)));
      }
    }

    loadEpisodes();
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
