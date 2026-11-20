"""从已选 L03 原图派生设计侧透明 PNG；不重绘、不改变主体配色。"""
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[3]
source = root / 'docs/UI/brand-candidates-v1/logo-03-sail.png'
out_dir = Path(__file__).resolve().parent
rgb = np.asarray(Image.open(source).convert('RGB'), dtype=np.float32)
chroma = rgb.max(axis=2) - rgb.min(axis=2)
# 原图是青绿色主体与近白背景。只提取有色轮廓，清除近白底纹。
alpha = np.clip((chroma - 12) / 24, 0, 1)
alpha[(rgb[:, :, 1] - rgb[:, :, 0] < 12) | (rgb[:, :, 2] - rgb[:, :, 0] < 8)] = 0
assert np.count_nonzero(alpha > .95) > 1000, '未识别到青绿色帆船主体'
# 去掉边缘混入的白底，避免深色背景出现白边；主体 alpha=1 时颜色不变。
straight = np.clip((rgb - 255 * (1 - alpha[:, :, None])) / np.maximum(alpha[:, :, None], 1e-6), 0, 255)
rgba = np.dstack((straight, alpha * 255)).round().astype(np.uint8)
image = Image.fromarray(rgba)
bbox = image.getbbox()
assert bbox, '透明处理产生空图'
image = image.crop(bbox)
size = max(image.size)
pad = round(size * .07)
canvas = Image.new('RGBA', (size + pad * 2, size + pad * 2), (0, 0, 0, 0))
canvas.alpha_composite(image, (pad + (size - image.width) // 2, pad + (size - image.height) // 2))
for name, target in [('logo-sail.png', canvas), ('favicon.png', canvas.resize((64, 64), Image.Resampling.LANCZOS))]:
    destination = out_dir / name
    if destination.exists():
        raise FileExistsError(f'拒绝覆盖现有设计资源: {destination}')
    target.save(destination)
    print(f'Created {destination} ({target.width}x{target.height})')
print(f'原图主体边界: {bbox}; 仅透明化、裁除外围空白、居中留白。')
