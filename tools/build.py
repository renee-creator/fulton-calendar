"""Builds index.html (the real page) and preview/fulton-calendar-preview.html (a try-it page with example entries)
from src/app.html. Run from the repository folder with  python3 tools/build.py"""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
app = (root / "src/app.html").read_text()
marker = "<!--PREVIEW-->"
assert app.count(marker) == 1, "preview marker not found"
cut = app.index("<style>")
headbits, body = app[:cut], app[cut:]
head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="robots" content="noindex,nofollow">\n'
        '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n'
        '<link rel="manifest" href="manifest.webmanifest">\n<meta name="theme-color" content="#2f5a43">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-title" content="Calendar">\n<meta name="apple-mobile-web-app-status-bar-style" content="default">\n' + headbits +
        '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n')
out = head + body.replace(marker, "") + "\n</body>\n</html>\n"
(root / "index.html").write_text(out)
print("index.html", len(out), "bytes")
core = (root / "core.js").read_text()
stub = (root / "src/preview.js").read_text()
prev = app.replace("<title>Fulton Calendar</title>", "<title>Fulton Calendar Preview</title>").replace(marker, "<script>\n" + core + "\n</script>\n<script>\n" + stub + "\n</script>")
(root / "preview").mkdir(exist_ok=True)
(root / "preview/fulton-calendar-preview.html").write_text(prev)
print("preview", len(prev), "bytes")
