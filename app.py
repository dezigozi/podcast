import io
import logging
import os
import sys
import threading
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

import yaml
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_file

sys.path.insert(0, str(Path(__file__).parent))

load_dotenv()
load_dotenv(Path(__file__).parent.parent / ".env")

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

jobs: dict = {}
groups: dict = {}
OUTPUT_DIR = Path("/tmp/podcast_jobs")
OUTPUT_DIR.mkdir(exist_ok=True)

STATUS_LABELS = {
    "collecting": "📰 ニュース収集中...",
    "generating_script": "✍️ スクリプト生成中（GPT-4o）...",
    "generating_audio": "🔊 音声生成中（OpenAI TTS）...",
    "done": "✅ 完了",
    "error": "エラー",
}


def load_config():
    config_dir = Path(__file__).parent / "config"
    with open(config_dir / "settings.yaml", encoding="utf-8") as f:
        settings = yaml.safe_load(f)
    with open(config_dir / "personas.yaml", encoding="utf-8") as f:
        personas = yaml.safe_load(f).get("personas", {})
    return settings, personas


def generate_task(job_id: str, persona_id: str):
    try:
        from src.audio_generator import AudioGenerator
        from src.collector import NewsCollector
        from src.script_generator import ScriptGenerator

        settings, personas = load_config()
        persona = personas[persona_id]

        jobs[job_id]["status"] = "collecting"
        collector = NewsCollector(settings)
        items = collector.collect()

        jobs[job_id]["status"] = "generating_script"
        generator = ScriptGenerator(settings, personas)
        script = generator.generate(items, persona_id)

        jobs[job_id]["status"] = "generating_audio"
        audio_path = OUTPUT_DIR / f"{job_id}.mp3"
        audio_gen = AudioGenerator(settings)
        audio_gen.generate(script, persona["voice"], audio_path)

        jobs[job_id].update({
            "status": "done",
            "audio_path": str(audio_path),
            "persona_name": persona["name"],
        })

    except Exception as e:
        logger.exception("生成エラー: %s", e)
        jobs[job_id].update({"status": "error", "error": str(e)})


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/personas")
def personas():
    _, personas_cfg = load_config()
    result = [
        {"id": k, "name": v["name"], "title": v["title"]}
        for k, v in personas_cfg.items()
    ]
    return jsonify(result)


@app.route("/api/generate", methods=["POST"])
def generate():
    data = request.get_json() or {}
    persona_id = data.get("persona_id", "")
    _, personas_cfg = load_config()

    if persona_id not in personas_cfg:
        return jsonify({"error": "不正なペルソナIDです"}), 400

    if not os.getenv("OPENAI_API_KEY"):
        return jsonify({"error": "OPENAI_API_KEY が設定されていません"}), 500

    job_id = uuid.uuid4().hex
    jobs[job_id] = {"status": "collecting", "persona_id": persona_id}

    t = threading.Thread(target=generate_task, args=(job_id, persona_id), daemon=True)
    t.start()

    return jsonify({"job_id": job_id})


@app.route("/api/generate-all", methods=["POST"])
def generate_all():
    _, personas_cfg = load_config()

    if not os.getenv("OPENAI_API_KEY"):
        return jsonify({"error": "OPENAI_API_KEY が設定されていません"}), 500

    group_id = uuid.uuid4().hex
    job_ids = []

    for persona_id in personas_cfg.keys():
        job_id = uuid.uuid4().hex
        jobs[job_id] = {"status": "collecting", "persona_id": persona_id}
        t = threading.Thread(target=generate_task, args=(job_id, persona_id), daemon=True)
        t.start()
        job_ids.append(job_id)

    groups[group_id] = {"job_ids": job_ids}
    return jsonify({"group_id": group_id, "job_ids": job_ids})


@app.route("/api/group-status/<group_id>")
def group_status(group_id):
    group = groups.get(group_id)
    if not group:
        return jsonify({"error": "グループが見つかりません"}), 404

    statuses = []
    for job_id in group["job_ids"]:
        job = jobs.get(job_id, {})
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
    group = groups.get(group_id)
    if not group:
        return jsonify({"error": "グループが見つかりません"}), 404

    today = datetime.now().strftime("%Y%m%d")
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for job_id in group["job_ids"]:
            job = jobs.get(job_id, {})
            if job.get("status") == "done" and job.get("audio_path"):
                name = job.get("persona_name", job_id).replace(" ", "").replace("・", "")
                zf.write(job["audio_path"], f"わんこそば_{name}_{today}.mp3")

    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"わんこそば_全員_{today}.zip",
    )


@app.route("/api/status/<job_id>")
def status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "ジョブが見つかりません"}), 404
    label = STATUS_LABELS.get(job["status"], job["status"])
    return jsonify({**job, "label": label})


@app.route("/api/audio/<job_id>")
def audio(job_id):
    job = jobs.get(job_id)
    if not job or job.get("status") != "done":
        return jsonify({"error": "音声ファイルが存在しません"}), 404
    return send_file(job["audio_path"], mimetype="audio/mpeg", as_attachment=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
