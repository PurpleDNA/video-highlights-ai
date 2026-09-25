"""A CORS-enabled front door for youtube-transcript-api.

Why this exists: a browser cannot fetch YouTube captions. Those endpoints send
no CORS headers, so the request dies before it starts — which is the single
reason `read_transcript.py` survived the port to `web/`. This service is that
one Python call, reachable from the browser.

It is deliberately the smallest thing that can work: stdlib HTTP, one
dependency, no framework, no state, no database, no API keys of its own. If it
is down, the web app falls back to pasting a transcript, exactly as today.

Output is byte-for-byte what `transcript.fetch()` produced — `[HH:MM:SS] text`,
one caption cue per line — so `transcript.js`'s parser needs no changes and the
cues keep their real ~3s granularity (unlike third-party transcript sites,
which merge cues into ~31s blocks and triplicate the text).

THE OPEN QUESTION this service exists to answer: YouTube rate-limits and blocks
datacenter IPs. `youtube-transcript-api` works from a laptop because a laptop
has a residential IP. From Fly/AWS/GCP it frequently gets blocked outright. So
the first deploy is a spike: hit /transcript/<id> once and see whether real cues
come back or a block does. A block is reported below as HTTP 502 with the
exception's class name, so the answer is unambiguous rather than a generic 500.
"""

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from youtube_transcript_api import YouTubeTranscriptApi

PORT = int(os.environ.get("PORT", "8080"))

# When set, every /transcript request must carry `Authorization: Bearer <token>`.
# Left unset the service is open, which is fine for the first spike and not fine
# to leave running — an open endpoint becomes someone else's free transcript API.
TOKEN = os.environ.get("PROXY_TOKEN", "").strip()

# Matches the 11-character YouTube id and nothing else, so a bad path can never
# reach the library.
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def format_timestamp(seconds) -> str:
    """3661 -> '01:01:01'. Copied from pipeline/transcript.py so the output of
    this service and of the original Python fetcher are byte-identical."""
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def fetch_cues(video_id: str) -> str:
    """The transcript as `[HH:MM:SS] text` lines — the format transcript.js
    parses and the format transcripts/ already holds on disk."""
    data = YouTubeTranscriptApi().fetch(video_id).to_raw_data()
    return "".join(
        f'[{format_timestamp(item["start"])}] {item["text"]}\n' for item in data
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "gfpbap-transcript"

    # --- plumbing --------------------------------------------------------

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def _send(self, code: int, body: bytes, content_type: str):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code: int, kind: str, message: str):
        """Errors are JSON and always name `kind` — the exception's class name
        for an upstream failure. That is what makes a YouTube IP block legible
        as a block rather than as a generic failure."""
        body = json.dumps({"error": kind, "message": message}).encode()
        self._send(code, body, "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # --- routes ----------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path in ("/", "/health"):
            self._send(200, b"ok\n", "text/plain; charset=utf-8")
            return

        if not path.startswith("/transcript/"):
            self._error(404, "not_found", f"No route for {path}")
            return

        if TOKEN:
            supplied = self.headers.get("Authorization", "")
            if supplied != f"Bearer {TOKEN}":
                self._error(401, "unauthorized", "Missing or wrong bearer token.")
                return

        video_id = path[len("/transcript/"):].removesuffix(".txt")
        if not VIDEO_ID.match(video_id):
            self._error(400, "bad_video_id",
                        "Expected an 11-character YouTube video id.")
            return

        try:
            text = fetch_cues(video_id)
        except Exception as exc:
            # The library raises a family of subclasses — IpBlocked,
            # RequestBlocked, TranscriptsDisabled, NoTranscriptFound, ... The
            # class name is the diagnosis, so it goes back verbatim.
            self._error(502, type(exc).__name__, str(exc)[:500])
            return

        if not text:
            self._error(404, "empty_transcript",
                        "YouTube returned no caption cues for this video.")
            return

        self._send(200, text.encode("utf-8"), "text/plain; charset=utf-8")

    def log_message(self, fmt, *args):
        print(f"  {fmt % args}", flush=True)


if __name__ == "__main__":
    guard = "token required" if TOKEN else "OPEN — set PROXY_TOKEN before leaving this up"
    print(f"gfpbap-transcript on :{PORT} ({guard})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
