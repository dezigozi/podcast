import io
import json
import logging
import os
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path

import yaml
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file

# pydub に imageio-ffmpeg 同梱の ffmpeg バイナリを使わせる
try:
    import imageio_ffmpeg
    from pydub import AudioSegment as _AS
    _AS.converter = imageio_ffmpeg.get_ffmpeg_exe()
except ImportError:
    pass

sys.path.insert(0, str(Path(__file__).parent))

load_dotenv()
load_dotenv(Path(__file__).parent.parent / ".env")

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ファイルベースの状態管理（複数ワーカー間で共有できるよう /tmp に保存）
JOB_DIR = Path("/tmp/podcast_jobs")
GROUP_DIR = Path("/tmp/podcast_groups")
AUDIO_DIR = Path("/tmp/podcast_audio")
JOB_DIR.mkdir(exist_ok=True)
GROUP_DIR.mkdir(exist_ok=True)
AUDIO_DIR.mkdir(exist_ok=True)

STATUS_LABELS = {
    "collecting": "📰 ニュース収集中...",
    "generating_script": "✍️ スクリプト生成中（Gemini）...",
    "generating_audio": "🔊 音声生成中（Gemini TTS）...",
    "done": "✅ 完了",
    "error": "エラー",
}


# ── ファイル I/O ヘルパー ─────────────────────────────────────────

def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_json(path: Path, data: dict):
    """tmp ファイルに書いてからリネーム（アトミック書き込み）"""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.rename(path)


def _get_job(job_id: str) -> dict:
    return _read_json(JOB_DIR / f"{job_id}.json")


def _set_job(job_id: str, data: dict):
    _write_json(JOB_DIR / f"{job_id}.json", data)


def _update_job(job_id: str, **kwargs):
    job = _get_job(job_id)
    job.update(kwargs)
    _set_job(job_id, job)


def _get_group(group_id: str) -> dict:
    return _read_json(GROUP_DIR / f"{group_id}.json")


def _set_group(group_id: str, data: dict):
    _write_json(GROUP_DIR / f"{group_id}.json", data)


# ── 設定読み込み ──────────────────────────────────────────────────

def load_config():
    config_dir = Path(__file__).parent / "config"
    with open(config_dir / "settings.yaml", encoding="utf-8") as f:
        settings = yaml.safe_load(f)
    with open(config_dir / "personas.yaml", encoding="utf-8") as f:
        personas = yaml.safe_load(f).get("personas", {})
    return settings, personas


# ── バックグラウンド生成タスク ────────────────────────────────────

def generate_task(job_id: str, persona_id: str):
    try:
        from src.audio_generator import AudioGenerator
        from src.collector import NewsCollector
        from src.script_generator import ScriptGenerator

        settings, personas = load_config()
        persona = personas[persona_id]

        _update_job(job_id, status="collecting")
        collector = NewsCollector(settings)
        items = collector.collect_for_persona(persona)

        _update_job(job_id, status="generating_script")
        generator = ScriptGenerator(settings, personas)
        script = generator.generate(items, persona_id)

        _update_job(job_id, status="generating_audio")
        audio_path = AUDIO_DIR / f"{job_id}.mp3"
        audio_gen = AudioGenerator(settings)
        tts_provider = settings.get("tts", {}).get("provider", "gemini").lower()
        voice = persona["voices"][tts_provider]
        audio_gen.generate(script, voice, audio_path)

        _update_job(job_id,
            status="done",
            audio_path=str(audio_path),
            persona_name=persona["name"],
        )

    except Exception as e:
        logger.exception("生成エラー: %s", e)
        _update_job(job_id, status="error", error=str(e))


# ── Flask ルート ──────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/personas")
def personas():
    settings, personas_cfg = load_config()
    feeds = settings.get("news", {}).get("rss_feeds", [])
    result = []
    for k, v in personas_cfg.items():
        assigned = v.get("feeds", [])
        sources = " · ".join(assigned[:4]) + (f" +{len(assigned)-4}" if len(assigned) > 4 else "")
        result.append({"id": k, "name": v["name"], "title": v["title"], "sources": sources})
    return jsonify(result)


def _check_api_keys(settings: dict) -> str | None:
    """provider 設定に応じて必要なAPIキーをチェック、足りなければエラー文を返す"""
    llm_provider = settings.get("llm", {}).get("provider", "gemini").lower()
    tts_provider = settings.get("tts", {}).get("provider", "gemini").lower()
    need_gemini = llm_provider == "gemini" or tts_provider == "gemini"
    need_openai = llm_provider == "openai" or tts_provider == "openai"

    if need_gemini and not os.getenv("GEMINI_API_KEY"):
        return "GEMINI_API_KEY が設定されていません"
    if need_openai and not os.getenv("OPENAI_API_KEY"):
        return "OPENAI_API_KEY が設定されていません"
    return None


@app.route("/api/generate", methods=["POST"])
def generate():
    data = request.get_json() or {}
    persona_id = data.get("persona_id", "")
    settings, personas_cfg = load_config()

    if persona_id not in personas_cfg:
        return jsonify({"error": "不正なペルソナIDです"}), 400

    err = _check_api_keys(settings)
    if err:
        return jsonify({"error": err}), 500

    job_id = uuid.uuid4().hex
    _set_job(job_id, {"status": "collecting", "persona_id": persona_id})

    t = threading.Thread(target=generate_task, args=(job_id, persona_id), daemon=True)
    t.start()

    return jsonify({"job_id": job_id})


@app.route("/api/generate-all", methods=["POST"])
def generate_all():
    settings, personas_cfg = load_config()

    err = _check_api_keys(settings)
    if err:
        return jsonify({"error": err}), 500

    group_id = uuid.uuid4().hex
    job_ids = []

    for persona_id in personas_cfg.keys():
        job_id = uuid.uuid4().hex
        _set_job(job_id, {"status": "collecting", "persona_id": persona_id})
        t = threading.Thread(target=generate_task, args=(job_id, persona_id), daemon=True)
        t.start()
        job_ids.append(job_id)

    _set_group(group_id, {"job_ids": job_ids})
    return jsonify({"group_id": group_id, "job_ids": job_ids})


@app.route("/api/group-status/<group_id>")
def group_status(group_id):
    group = _get_group(group_id)
    if not group:
        return jsonify({"error": "グループが見つかりません"}), 404

    statuses = []
    for job_id in group["job_ids"]:
        job = _get_job(job_id)
        statuses.append({
            "job_id": job_id,
            "status": job.get("status"),
            "label": STATUS_LABELS.get(job.get("status", ""), ""),
            "persona_name": job.get("persona_name", ""),
            "persona_id": job.get("persona_id", ""),
            "error": job.get("error"),
        })

    all_done = all(s["status"] == "done" for s in statuses)
    any_error = any(s["status"] == "error" for s in statuses)

    return jsonify({"statuses": statuses, "all_done": all_done, "any_error": any_error})


@app.route("/api/download-all/<group_id>")
def download_all(group_id):
    """5ペルソナ分のmp3を1つに連結してダウンロード"""
    group = _get_group(group_id)
    if not group:
        return jsonify({"error": "グループが見つかりません"}), 404

    today = datetime.now().strftime("%Y%m%d")

    # 完了したジョブのmp3パスを集める（personas.yamlの並び順を維持するため、group内のjob_idsの順を使う）
    audio_paths = []
    for job_id in group["job_ids"]:
        job = _get_job(job_id)
        if job.get("status") == "done" and job.get("audio_path"):
            p = Path(job["audio_path"])
            if p.exists():
                audio_paths.append(p)

    if not audio_paths:
        return jsonify({"error": "完了済みの音声ファイルがありません"}), 404

    # pydub で5つのmp3を連結（間に1秒の無音を挟む）
    from pydub import AudioSegment
    silence = AudioSegment.silent(duration=1000)
    combined = AudioSegment.empty()
    for i, path in enumerate(audio_paths):
        seg = AudioSegment.from_file(str(path), format="mp3")
        if i > 0:
            combined += silence
        combined += seg

    buf = io.BytesIO()
    combined.export(buf, format="mp3", bitrate="128k")
    buf.seek(0)

    return send_file(
        buf,
        mimetype="audio/mpeg",
        as_attachment=True,
        download_name=f"わんこそば_全員_{today}.mp3",
    )


@app.route("/api/status/<job_id>")
def status(job_id):
    job = _get_job(job_id)
    if not job:
        return jsonify({"error": "ジョブが見つかりません"}), 404
    label = STATUS_LABELS.get(job.get("status", ""), job.get("status", ""))
    return jsonify({**job, "label": label})


@app.route("/api/audio/<job_id>")
def audio(job_id):
    job = _get_job(job_id)
    if not job or job.get("status") != "done":
        return jsonify({"error": "音声ファイルが存在しません"}), 404
    return send_file(job["audio_path"], mimetype="audio/mpeg", as_attachment=False)


@app.route("/api/debug")
def debug():
    job_files = list(JOB_DIR.glob("*.json"))
    group_files = list(GROUP_DIR.glob("*.json"))
    return jsonify({
        "jobs_count": len(job_files),
        "groups_count": len(group_files),
        "pid": os.getpid(),
    })


if __name__ == "__main__":
    # ローカル開発時のデフォルトポート。macOSのAirPlay Receiverが5000を占有するため8000を使う。
    # Render.com 等の本番環境では環境変数 PORT が自動で渡される。
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=False)
