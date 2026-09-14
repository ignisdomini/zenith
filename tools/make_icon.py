"""Иконка ЗЕНИТа: тёмный круг-небосвод, золотая звезда в зените, дуга трассы и отвес. python tools/make_icon.py"""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 1024
OUT = Path(__file__).resolve().parent.parent / 'build'
OUT.mkdir(exist_ok=True)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# диск неба с радиальным градиентом
for r in range(460, 0, -4):
    k = r / 460
    col = (int(8 + 22 * (1 - k)), int(12 + 28 * (1 - k)), int(28 + 42 * (1 - k)), 255)
    d.ellipse([S / 2 - r, S / 2 - r, S / 2 + r, S / 2 + r], fill=col)
# земная дуга (горизонт) внизу — обрезана по диску неба
earth = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(earth).chord([40, 610, S - 40, 1500], 180, 360, fill=(18, 34, 44, 255), outline=(111, 211, 255, 220), width=10)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).ellipse([S / 2 - 452, S / 2 - 452, S / 2 + 452, S / 2 + 452], fill=255)
img.paste(earth, (0, 0), Image.composite(earth.split()[3], Image.new('L', (S, S), 0), mask))
d = ImageDraw.Draw(img)
d.ellipse([S / 2 - 460, S / 2 - 460, S / 2 + 460, S / 2 + 460], outline=(242, 196, 109, 255), width=16)
# трасса зенита — пунктир по параллели
y = 610
for x in range(170, S - 170, 44):
    d.line([x, y, x + 24, y], fill=(255, 224, 138, 230), width=10)
# отвес от звезды к точке на трассе
cx, cy = S / 2, 330
d.line([cx, cy + 70, cx, y - 16], fill=(242, 196, 109, 200), width=8)
d.ellipse([cx - 22, y - 22, cx + 22, y + 22], fill=(110, 231, 168, 255), outline=(0, 0, 0, 255), width=5)
# свечение и звезда
glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([cx - 150, cy - 150, cx + 150, cy + 150], fill=(242, 196, 109, 150))
glow = glow.filter(ImageFilter.GaussianBlur(60))
img = Image.alpha_composite(img, glow)
d = ImageDraw.Draw(img)
pts = []
for i in range(8):
    ang = -math.pi / 2 + i * math.pi / 4
    rr = 120 if i % 2 == 0 else 34
    pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
d.polygon(pts, fill=(255, 232, 170, 255))
d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=(255, 255, 255, 255))

img.resize((512, 512), Image.LANCZOS).save(OUT / 'icon.png')
img.save(OUT / 'icon-1024.png')
img.resize((256, 256), Image.LANCZOS).save(OUT / 'icon.ico', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print('ok', OUT)
