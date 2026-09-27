#!/usr/bin/env python3
import hashlib
import json
import os
import sys


def svg(width: int, height: int, title: str, subject: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}">
<rect width="{width}" height="{height}" fill="#fffdf9"/>
<circle cx="{width*0.34:.1f}" cy="{height*0.52:.1f}" r="{min(width,height)*0.18:.1f}" fill="#d9dde1"/>
<path d="M {width*0.48:.1f} {height*0.36:.1f} L {width*0.78:.1f} {height*0.52:.1f} L {width*0.48:.1f} {height*0.68:.1f} Z" fill="#c9473d"/>
<text x="{width*0.08:.1f}" y="{height*0.14:.1f}" font-family="Arial" font-size="22" font-weight="700" fill="#1d2329">{title[:48]}</text>
<text x="{width*0.08:.1f}" y="{height*0.86:.1f}" font-family="Arial" font-size="15" fill="#69727a">{subject[:70]}</text>
</svg>'''


def main() -> int:
    request = json.load(sys.stdin)
    spec = request["spec"]
    origin = os.environ.get("MOCK_ILLUSTRATION_ORIGIN", "generative_ai")
    source_type = "humanCreated" if origin == "human" else "algorithmicMedia" if origin == "software" else "trainedAlgorithmicMedia"
    prompt_hash = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    response = {
        "adapter_id": "mock-illustration-adapter/1",
        "origin": origin,
        "digital_source_type": source_type,
        "provider": None if origin in {"human", "software"} else "mock-provider",
        "model": None if origin in {"human", "software"} else "mock-image-model",
        "version": "1",
        "prompt_hash": prompt_hash,
        "disclosure": "AI-generated editorial illustration for qualification testing." if origin == "generative_ai" else "Mock editorial illustration for qualification testing.",
        "license": "test-only",
        "variants": {
            "desktop": svg(1200, 700, spec["title"], spec["subject"]),
            "mobile": svg(640, 760, spec["title"], spec["subject"]),
        },
        "metadata": {"fixture": True},
    }
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
