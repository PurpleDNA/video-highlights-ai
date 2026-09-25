"""Standalone YouTube transcript ingest tool.

The one remaining Python script (see CLAUDE.md's "What remains Python") — kept
because YouTube's caption endpoints send no CORS headers, so no browser script
can fetch them, and the alternative (yt-dlp) is a binary, not something a
static site can call.

Writes transcripts/<webinar>.txt in the `[HH:MM:SS] text` cue-per-line format
web/runtime/transcript.js parses (see that module's header comment) — the
work folder's documented transcript ingest path, run occasionally rather than
as part of any pipeline.

Usage:
    pip install -r requirements.txt
    python read_transcript.py --video-id 8UPCTR7Ma7I --webinar "Reflections on COP30"

Writes to transcripts/<webinar>.txt, resolved against this script's own
directory (not the current working directory), so it lands in the same place
--- next to this file, matching the work folder's `transcripts/` --- no
matter where the command is run from.
"""

import argparse
from pathlib import Path

from youtube_transcript_api import YouTubeTranscriptApi

TRANSCRIPTS_DIR = Path(__file__).resolve().parent / "transcripts"


def format_timestamp(seconds):
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def fetch_transcript(video_id):
    """The raw cue list for `video_id`: dicts with (at least) `start` and
    `text`, per youtube-transcript-api's `to_raw_data()`."""
    api = YouTubeTranscriptApi()
    return api.fetch(video_id).to_raw_data()


def write_transcript(cues, webinar):
    """Write `cues` to transcripts/<webinar>.txt, creating the directory if
    it doesn't exist yet. Returns the path written."""
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    path = TRANSCRIPTS_DIR / f"{webinar}.txt"
    with path.open("w", encoding="utf-8") as f:
        for cue in cues:
            f.write(f'[{format_timestamp(cue["start"])}] {cue["text"]}\n')
    return path


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Fetch a YouTube video's transcript and write it as "
            "transcripts/<webinar>.txt, in the [HH:MM:SS] cue format the "
            "web app reads."
        )
    )
    parser.add_argument(
        "--video-id", required=True,
        help="YouTube video id, e.g. 8UPCTR7Ma7I (the 'v=' value in the video's URL).",
    )
    parser.add_argument(
        "--webinar", required=True,
        help=(
            'Webinar name, e.g. "Reflections on COP30". Used verbatim as the '
            'output filename (transcripts/<webinar>.txt) and should match the '
            'name used for "webinar recordings/<webinar>.mp4".'
        ),
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    cues = fetch_transcript(args.video_id)
    path = write_transcript(cues, args.webinar)
    print(f"Wrote {len(cues)} cues to {path}")


if __name__ == "__main__":
    main()
