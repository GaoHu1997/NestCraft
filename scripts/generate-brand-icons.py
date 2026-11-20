"""将已选定的品牌原图原样复制到软件资源，并派生 PNG／ICO。"""
from pathlib import Path
import shutil
import sys
from PIL import Image, ImageDraw

source, favicon, root = (Path(value) for value in sys.argv[1:4])
image = Image.open(source).convert("RGBA")
public = root / "public" / "brand"
icons = root / "src-tauri" / "icons"
public.mkdir(parents=True, exist_ok=True)
icons.mkdir(parents=True, exist_ok=True)
shutil.copyfile(source, public / "logo-sail.png")
shutil.copyfile(favicon, public / "favicon.png")
canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
ImageDraw.Draw(canvas).rounded_rectangle((4, 4, 251, 251), radius=52, fill=(223, 243, 236, 255))
scaled = image.copy()
scaled.thumbnail((200, 200), Image.Resampling.LANCZOS)
canvas.alpha_composite(scaled, ((256 - scaled.width) // 2, (256 - scaled.height) // 2))
canvas.save(icons / "icon.png")
canvas.save(icons / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("品牌资源已派生：原帆船 PNG + favicon + PNG/ICO，未修改设计资源")
