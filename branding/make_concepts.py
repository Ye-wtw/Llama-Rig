# -*- coding: utf-8 -*-
"""品牌图标概念草图生成器 v2(PIL)
v2 修正:
  - 全部改为深底 + 高对比亮色字形(32/16px 不再退化成同一块黑方块)
  - 说明文字按列宽折行,不再叠字
  - 小尺寸校核同时放在浅底与深底上,并放大 5 倍看像素
输出:
  glyphs/concept-{A..D}.png / .ico
  icon-concepts.png   概念总览
  wordmarks.png       候选名字标样张
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
GLYPHS = os.path.join(HERE, 'glyphs')
os.makedirs(GLYPHS, exist_ok=True)

SS = 4  # 超采样倍率

INK = (41, 48, 40)
INK2 = (63, 73, 61)
FADE = (120, 138, 114)     # 非当前项:抬高对比,小尺寸仍可见
SAGE = (79, 116, 80)
SAGEB = (127, 176, 122)
MINT = (222, 236, 216)
PAPER = (247, 248, 244)
WHITE = (255, 255, 255)
DARK = (22, 24, 21)

FONT_BOLD = 'C:/Windows/Fonts/segoeuib.ttf'
FONT_CN = 'C:/Windows/Fonts/msyh.ttc'


def font(path, size):
    return ImageFont.truetype(path, size)


def new_canvas(bg, size):
    img = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=int(size * SS * 0.22), fill=bg)
    return img, d


def s(v):
    return int(round(v * SS))


# --- 概念 A:多引擎换挡(三个横档,当前档亮) ------------------------------
def glyph_slots(size=256):
    img, d = new_canvas(INK, size)
    for i, y in enumerate((74, 128, 182)):
        active = i == 1
        d.rounded_rectangle([s(44), s(y - 22), s(212), s(y + 22)], radius=s(21),
                            fill=MINT if active else FADE)
        if active:
            d.ellipse([s(166), s(y - 13), s(198), s(y + 13)], fill=INK)
    return img


# --- 概念 B:调速表(指针压在安全区)= 显存守卫 ---------------------------
def glyph_dial(size=256):
    img, d = new_canvas(INK, size)
    box = [s(42), s(42), s(214), s(214)]
    d.arc(box, start=140, end=400, fill=FADE, width=s(30))
    d.arc(box, start=140, end=268, fill=MINT, width=s(30))
    cx = cy = s(128)
    ang = math.radians(268)
    d.line([cx, cy, cx + s(56) * math.cos(ang), cy + s(56) * math.sin(ang)], fill=MINT, width=s(13))
    d.ellipse([cx - s(14), cy - s(14), cx + s(14), cy + s(14)], fill=SAGEB)
    return img


# --- 概念 C:三路汇流(3 个引擎 -> 1 个控制台) ---------------------------
def glyph_manifold(size=256):
    img, d = new_canvas(INK, size)
    for i, x in enumerate((54, 111, 168)):
        d.rounded_rectangle([s(x), s(40), s(x + 34), s(152)], radius=s(17),
                            fill=MINT if i == 1 else FADE)
    d.rounded_rectangle([s(54), s(164), s(202), s(216)], radius=s(26), fill=MINT)
    return img


# --- 概念 D:预设牌堆(当前那张在最上面) ---------------------------------
def glyph_stack(size=256):
    img, d = new_canvas(INK, size)
    d.rounded_rectangle([s(80), s(44), s(200), s(164)], radius=s(24), fill=INK2)
    d.rounded_rectangle([s(63), s(62), s(183), s(182)], radius=s(24), fill=SAGE)
    d.rounded_rectangle([s(46), s(80), s(166), s(200)], radius=s(24), fill=MINT)
    d.rounded_rectangle([s(70), s(116), s(142), s(134)], radius=s(9), fill=INK)
    d.rounded_rectangle([s(70), s(146), s(120), s(160)], radius=s(7), fill=SAGEB)
    return img


CONCEPTS = [
    ('A', '多引擎换挡', '三个横档 = 三个引擎/预设,亮的那档是当前正在跑的', glyph_slots),
    ('B', '调速表 · 显存守卫', '指针压在安全区,含义是启动前就把超显存的挡下来', glyph_dial),
    ('C', '三路汇流', '三条引擎管路汇进同一个控制台底座', glyph_manifold),
    ('D', '预设牌堆', '一叠预设,当前那张翻到最上面', glyph_stack),
]

for tag, cn, desc, fn in CONCEPTS:
    fn(256).resize((256, 256), Image.LANCZOS).save(os.path.join(GLYPHS, f'concept-{tag}.png'))
    ico = [fn(sz).resize((sz, sz), Image.LANCZOS) for sz in (256, 128, 64, 48, 32, 16)]
    ico[0].save(os.path.join(GLYPHS, f'concept-{tag}.ico'),
                sizes=[(im.width, im.height) for im in ico])


def wrap_cn(text, per_line):
    return [text[i:i + per_line] for i in range(0, len(text), per_line)]


# ---------------------------- 总览表 -------------------------------------
PAD = 56
CELL = 256
COL_W = CELL + 48
SMALL_BAND = 208
SHEET_W = 56 * 2 + COL_W * len(CONCEPTS) + 40
SHEET_H = 160 + CELL + 130 + SMALL_BAND + 90
sheet = Image.new('RGB', (SHEET_W, SHEET_H), WHITE)
sd = ImageDraw.Draw(sheet)

sd.text((PAD, 34), '本地 LLM 控制台 · 图标概念草图 v2', font=font(FONT_CN, 40), fill=(30, 32, 28))
sd.text((PAD, 92), '深底高对比字形;下方小图 = 32px / 16px 实际渲染放大 5 倍,分浅底与深底两种环境检查',
        font=font(FONT_CN, 20), fill=(110, 116, 106))

for ci, (tag, cn, desc, fn) in enumerate(CONCEPTS):
    x = PAD + ci * COL_W
    y = 160
    big = fn(256).resize((CELL, CELL), Image.LANCZOS)
    sheet.paste(big, (x, y), big)
    sd.text((x, y + CELL + 14), f'{tag}. {cn}', font=font(FONT_CN, 27), fill=(30, 32, 28))
    for li, line in enumerate(wrap_cn(desc, 15)):
        sd.text((x, y + CELL + 52 + li * 31), line, font=font(FONT_CN, 18), fill=(110, 116, 106))

    sy = y + CELL + 136
    sd.rounded_rectangle([x - 14, sy - 12, x + CELL + 14, sy + SMALL_BAND - 10], radius=14,
                         fill=(31, 33, 30))
    sd.text((x, sy + 8), '小尺寸校核(实际像素放大 5 倍)', font=font(FONT_CN, 16), fill=(170, 176, 166))
    base = sy + 44 + 160
    up32 = fn(32).resize((32, 32), Image.LANCZOS).resize((160, 160), Image.NEAREST)
    up16 = fn(16).resize((16, 16), Image.LANCZOS).resize((80, 80), Image.NEAREST)
    sheet.paste(up32, (x, base - 160), up32)
    sheet.paste(up16, (x + 180, base - 80), up16)
    sd.text((x + 60, base + 6), '32px', font=font(FONT_CN, 16), fill=(170, 176, 166))
    sd.text((x + 200, base + 6), '16px', font=font(FONT_CN, 16), fill=(170, 176, 166))

sheet.save(os.path.join(HERE, 'icon-concepts.png'))
print('sheet    ->', os.path.join(HERE, 'icon-concepts.png'))


# ---------------------------- 字标样张 -----------------------------------
CANDIDATES = [
    ('Governor', '调速台', '调速器:引擎限速器,不让它超转 —— 显存守卫的机械同名物', glyph_dial),
    ('Roundhouse', '转车台', '圆形机车库:多条机车停在一个转盘上,转一下即换', glyph_slots),
    ('Gearbox', '换挡箱', '多引擎 = 多档位,一键换挡', glyph_slots),
    ('Patchbay', '跳线盘', '录制棚里的跳线盘:多路信号手动路由', glyph_manifold),
]

WM_H = 190
wm = Image.new('RGB', (1280, 100 + WM_H * len(CANDIDATES)), WHITE)
wd = ImageDraw.Draw(wm)
wd.text((40, 30), '字标样张(图标 + 英文名 + 中文副名)', font=font(FONT_CN, 34), fill=(30, 32, 28))

for i, (en, cn, note, fn) in enumerate(CANDIDATES):
    y = 100 + i * WM_H
    g = fn(128).resize((128, 128), Image.LANCZOS)
    wm.paste(g, (40, y + 16), g)
    wd.text((200, y + 20), en, font=font(FONT_BOLD, 74), fill=(30, 32, 28))
    wd.text((204, y + 110), f'{cn} · {note}', font=font(FONT_CN, 20), fill=(110, 116, 106))

wm.save(os.path.join(HERE, 'wordmarks.png'))
print('wordmark ->', os.path.join(HERE, 'wordmarks.png'))
