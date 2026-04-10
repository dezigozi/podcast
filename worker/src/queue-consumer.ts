// Queue Consumer Worker — 非同期ポッドキャスト生成処理

import { collectNews, buildNewsPrompt, partitionNewsAmongPersonas } from "./collector";
import { generateScript } from "./script-generator";
import { generateAudio } from "./audio-generator";
import { PERSONAS, PERSONA_IDS } from "./personas";

export interface Env {
  OPENAI_API_KEY: string;
  PODCAST_BUCKET: R2Bucket;
  PODCAST_KV: KVNamespace;
  PODCAST_QUEUE: Queue;
}

export interface GenerateJob {
  jobId: string;
  persona: string; // "all" or persona ID
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

export default {
  async queue(batch: MessageBatch<GenerateJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      await processJob(job, env);
      message.ack();
    }
  },
};

async function processJob(job: GenerateJob, env: Env): Promise<void> {
  const kv = env.PODCAST_KV;
  const dateStr = new Date().toISOString().split("T")[0];

  // ステータスを "running" に更新
  const runningStatus: JobStatus = {
    status: "running",
    persona: job.persona,
    createdAt: job.createdAt,
    startedAt: new Date().toISOString(),
  };
  await kv.put(`job:${job.jobId}`, JSON.stringify(runningStatus), { expirationTtl: 86400 * 3 });

  try {
    const newsItems = await collectNews();

    const personaIds =
      job.persona === "all" ? [...PERSONA_IDS] : [job.persona];
    const exclusiveTopics = personaIds.length > 1;
    const itemsByPersona = exclusiveTopics
      ? partitionNewsAmongPersonas(newsItems, personaIds)
      : null;

    const results: JobStatus["results"] = [];

    for (const personaId of personaIds) {
      const persona = PERSONAS[personaId];
      if (!persona) continue;

      const itemsForPersona = itemsByPersona?.[personaId] ?? newsItems;
      const newsPrompt = buildNewsPrompt(itemsForPersona, {
        exclusiveAssignment: exclusiveTopics,
      });
      const script = await generateScript(newsPrompt, persona, env.OPENAI_API_KEY, exclusiveTopics);

      // スクリプトをR2に保存
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

      // 音声生成（noAudio でない場合）
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

    // 完了ステータスを保存
    const doneStatus: JobStatus = {
      status: "done",
      persona: job.persona,
      createdAt: job.createdAt,
      startedAt: runningStatus.startedAt,
      completedAt: new Date().toISOString(),
      results,
    };
    await kv.put(`job:${job.jobId}`, JSON.stringify(doneStatus), { expirationTtl: 86400 * 7 });

    // エピソード一覧KVを更新
    const allEpisodesJson = await kv.get("episodes:all");
    const allEpisodes = allEpisodesJson ? JSON.parse(allEpisodesJson) : [];
    allEpisodes.unshift({ jobId: job.jobId, date: dateStr, results });
    await kv.put("episodes:all", JSON.stringify(allEpisodes.slice(0, 50)));
  } catch (err) {
    const errorStatus: JobStatus = {
      status: "error",
      persona: job.persona,
      createdAt: job.createdAt,
      startedAt: runningStatus.startedAt,
      error: String(err),
    };
    await kv.put(`job:${job.jobId}`, JSON.stringify(errorStatus), { expirationTtl: 86400 });
    throw err; // Queueにリトライさせる
  }
}
