// 音声生成モジュール — src/audio_generator.py をTypeScriptに移植
// スクリプトを3500文字ごとのチャンクに分割してTTS APIを呼び出し、結合する

import { PODCAST_CONFIG } from "./rss-feeds";

export async function generateAudio(
  script: string,
  voice: string,
  apiKey: string
): Promise<Uint8Array> {
  const chunks = splitScript(script, PODCAST_CONFIG.tts.chunkMaxChars);
  const audioParts: Uint8Array[] = [];

  for (const chunk of chunks) {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: PODCAST_CONFIG.tts.model,
        voice,
        input: chunk,
        speed: PODCAST_CONFIG.tts.speed,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(120_000), // 2分
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI TTS API エラー: ${response.status} ${err}`);
    }

    const buf = await response.arrayBuffer();
    audioParts.push(new Uint8Array(buf));
  }

  // Uint8Array を結合して1つのMP3バイナリにする
  return concatUint8Arrays(audioParts);
}

// スクリプトを句点・感嘆符・疑問符で分割してチャンクリストを返す
function splitScript(script: string, maxChars: number): string[] {
  if (script.length <= maxChars) return [script];

  // 句点等の後で分割（後読みを使わずに安全に分割）
  const sentences: string[] = [];
  let remaining = script;
  while (remaining.length > 0) {
    // 句点・！・？・改行の位置を探す
    let splitAt = -1;
    for (let i = 0; i < remaining.length; i++) {
      const ch = remaining[i];
      if (ch === "。" || ch === "！" || ch === "？" || ch === "\n") {
        splitAt = i + 1;
        if (splitAt >= 10) break; // 最低10文字以上の文なら分割OK
      }
    }
    if (splitAt <= 0) {
      // 分割点が見つからない場合は全体を1つにする
      sentences.push(remaining);
      break;
    }
    sentences.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  // 文をチャンクにまとめる
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
