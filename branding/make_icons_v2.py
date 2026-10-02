# -*- coding: utf-8 -*-
"""Llama Rig 图标方案 v2 —— 与新版单色 UI 对齐

背景:
  原型 layout-demo.html 已改为纯单色 UI(浅色:白底黑字 / 深色:黑底白字),
  左上角品牌标记 .brand-mark = 圆角方块 30px + radius 8px + 背景 var(--accent)
  + 800 字重 "LR"(颜色 var(--bg))。
  旧图标(branding/glyphs/concept-*.png、assets/llamarig.*)用的是鼠尾草绿
  #4F7450 系 + 渐变高光,与单色 UI 已经不是一套语言,故重出。

本脚本只产出候选,不动 assets/:
  v2/concept-{A..D}-256.png      单图 256
  v2/concept-{A..D}.ico          多尺寸 ico(16/32/48/64/128/256,PIL 原生多帧)
  v2/concept-{A..D}-tray-32.png  托盘用 32(带底)
  v2/concept-{A..D}-glyph-32.png 托盘用 32(透明底白字形,深色任务栏)
  v2/sheet-concepts-v2.png       概念总览(256 浅/深底 + 实际尺寸 + 16px 放大校核)

小尺寸处理:16~24px 用简化几何(加粗笔画、去掉细节),避免糊成一团。

用法:python branding/make_icons_v2.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'v2')
os.makedirs(OUT, exist_ok=True)

SS = 4  # 超采样倍率

# ---- 取自 prototype/layout-demo.html 的 UI 变量 ----
INK = (10, 10, 10)        # --bg(深色) / --accent(浅色) #0a0a0a
PAPER = (255, 255, 255)   # --bg(浅色)
LINE = (216, 216, 216)    # --line(浅色) #d8d8d8
LINE_D = (42, 42, 42)     # --line(深色) #2a2a2a

FONT_BOLD = 'C:/Windows/Fonts/segoeuib.ttf'    # Segoe UI Bold ≈ UI 的 800
FONT_BLACK = 'C:/Windows/Fonts/seguibl.ttf'    # Segoe UI Black(极小尺寸用)
FONT_CN = 'C:/Windows/Fonts/msyh.ttc'
FONT_MONO = 'C:/Windows/Fonts/consola.ttf'

ICO_SIZES = [16, 32, 48, 64, 128, 256]

TILE_MARGIN = 0.055
TILE_RADIUS = 0.240
GLYPH = 0.520
SMALL_MAX = 24            # <= 该尺寸走简化几何


def font(path, size):
    return ImageFont.truetype(path, max(1, int(round(size))))


def draw_tile(d, S, bg, radius_ratio=TILE_RADIUS, border=None):
    m = TILE_MARGIN * S
    box = [m, m, S - m, S - m]
    r = radius_ratio * S
    d.rounded_rectangle(box, radius=r, fill=bg)
    if border:
        color, w = border
        d.rounded_rectangle(box, radius=r, outline=color, width=max(1, int(round(w * S))))


# ---------------- 四个概念 ----------------

def glyph_A(d, S, fg, small=False):
    """A · 字母牌:LR 二字,与 UI 左上角 .brand-mark 1:1 同款。"""
    fpath = FONT_BLACK if small else FONT_BOLD
    target_w = GLYPH * S * (1.00 if small else 1.06)
    target_h = GLYPH * S * (0.80 if small else 0.72)
    size = 10
    while size < S:
        f = font(fpath, size)
        l, t, r, b = d.textbbox((0, 0), 'LR', font=f)
        if (r - l) > target_w or (b - t) > target_h:
            break
        size += 1
    f = font(fpath, size - 1)
    l, t, r, b = d.textbbox((0, 0), 'LR', font=f)
    d.text((S / 2 - (l + r) / 2, S / 2 - (t + b) / 2), 'LR', font=f, fill=fg)


def glyph_B(d, S, fg, small=False):
    """B · 档位轨:三条横档 = 三个引擎/预设,顶上那条实心 = 当前在跑。"""
    w = GLYPH * S * (1.10 if small else 1.0)
    x0, x1 = S / 2 - w / 2, S / 2 + w / 2
    if small:
        bar_h = w * 0.28
        gap = w * 0.13
        solid_all = True
    else:
        bar_h = w * 0.175
        gap = w * 0.145
        solid_all = False
    total = bar_h * 3 + gap * 2
    y = S / 2 - total / 2
    stroke = max(1, int(round(bar_h * (0.42 if small else 0.30))))
    for i in range(3):
        box = [x0, y, x1, y + bar_h]
        r = bar_h / 2
        if i == 0 or small:
            d.rounded_rectangle(box, radius=r, fill=fg)
        else:
            d.rounded_rectangle(box, radius=r, outline=fg, width=stroke)
        y += bar_h + gap


def glyph_C(d, S, fg, small=False):
    """C · 显存表:半圆表盘 + 指针压在安全区(对应启动前的显存守卫)。"""
    cx = S / 2
    cy = S / 2 + GLYPH * S * (0.20 if small else 0.24)
    r = GLYPH * S * (0.62 if small else 0.56)
    stroke = max(1, int(round(GLYPH * S * (0.22 if small else 0.115))))
    d.arc([cx - r, cy - r, cx + r, cy + r], 180, 360, fill=fg, width=stroke)
    ang = math.radians(-58)
    ln = r * (0.62 if small else 0.80)
    d.line([cx, cy, cx + ln * math.cos(ang), cy + ln * math.sin(ang)],
           fill=fg, width=max(1, int(round(GLYPH * S * (0.20 if small else 0.105)))))
    if not small:
        dot = GLYPH * S * 0.085
        d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=fg)


def glyph_D(d, S, fg, small=False):
    """D · 机架:方托 + 落位的实心块(引擎卡进机架)。"""
    w = GLYPH * S * (1.06 if small else 1.0)
    x0, x1 = S / 2 - w / 2, S / 2 + w / 2
    top = S / 2 - w * (0.30 if small else 0.34)
    bot = S / 2 + w * 0.52
    stroke = max(1, int(round(w * (0.24 if small else 0.155))))
    r = w * 0.20
    d.line([x0 + stroke / 2, top, x0 + stroke / 2, bot - r], fill=fg, width=stroke)
    d.line([x1 - stroke / 2, top, x1 - stroke / 2, bot - r], fill=fg, width=stroke)
    d.line([x0 + stroke / 2, bot - stroke / 2, x1 - stroke / 2, bot - stroke / 2], fill=fg, width=stroke)
    d.arc([x0, bot - 2 * r, x0 + 2 * r, bot], 90, 180, fill=fg, width=stroke)
    d.arc([x1 - 2 * r, bot - 2 * r, x1, bot], 0, 90, fill=fg, width=stroke)
    bw = w * (0.52 if small else 0.46)
    bh = w * (0.40 if small else 0.34)
    bx, by = S / 2 - bw / 2, bot - stroke * 0.5 - bh - w * 0.10
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=bh * 0.22, fill=fg)


CONCEPTS = [
    ('A', '字母牌 · LR', '与 UI 左上角品牌标记 1:1 同款(黑底圆角 + 白色 LR)', glyph_A),
    ('B', '档位轨 · Rig', '三条横档 = 三个引擎/预设,实心那条 = 当前在跑', glyph_B),
    ('C', '显存表 · Guard', '半圆表盘 + 指针压在安全区 = 启动前的显存守卫', glyph_C),
    ('D', '机架 · Bay', '方托 + 落位实心块 = 引擎卡进机架', glyph_D),
]


def render(size, glyph, polarity='dark', border=None):
    """polarity: dark = 黑底白字形(与浅色主题品牌标记一致);light = 白底黑字形。"""
    S = size * SS
    small = size <= SMALL_MAX
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if polarity == 'dark':
        draw_tile(d, S, INK, border=border)
        fg = PAPER
    else:
        draw_tile(d, S, PAPER, border=(LINE, 0.008))
        fg = INK
    glyph(d, S, fg, small=small)
    return img.resize((size, size), Image.LANCZOS)


def render_glyph_only(size, glyph, color=PAPER):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    glyph(ImageDraw.Draw(img), S, color, small=size <= SMALL_MAX)
    return img.resize((size, size), Image.LANCZOS)


def save_concept(tag, glyph):
    render(256, glyph, 'dark').save(os.path.join(OUT, f'concept-{tag}-256.png'))
    render(256, glyph, 'dark').save(os.path.join(OUT, f'concept-{tag}.ico'),
                                    sizes=[(s, s) for s in ICO_SIZES])
    render(32, glyph, 'dark').save(os.path.join(OUT, f'concept-{tag}-tray-32.png'))
    render_glyph_only(32, glyph).save(os.path.join(OUT, f'concept-{tag}-glyph-32.png'))


def sheet(rows):
    PAD, LABEL_W, COL, ROW_H = 26, 300, 268, 300
    W = PAD + LABEL_W + 6 * COL + PAD
    H = 104 + len(rows) * (ROW_H + 22) + 210

    img = Image.new('RGBA', (W, H), (250, 250, 250, 255))
    d = ImageDraw.Draw(img)
    f_title = font(FONT_CN, 30)
    f_sub = font(FONT_CN, 16)
    f_name = font(FONT_CN, 24)
    f_desc = font(FONT_CN, 15)
    f_small = font(FONT_CN, 13)
    f_mono = font(FONT_MONO, 13)

    def cap(x, y, text, color=(120, 120, 120)):
        d.text((x, y), text, font=f_small, fill=color)

    d.text((PAD, 26), 'Llama Rig · 图标方案 v2 — 与单色 UI 对齐', font=f_title, fill=(20, 20, 20))
    d.text((PAD, 64), '底板 #0a0a0a / 字形 #ffffff;圆角比例与 UI 品牌标记一致(radius/side ≈ 0.24);'
                      '16~24px 自动走简化几何', font=f_sub, fill=(110, 110, 110))

    y = 104
    for tag, name, desc, glyph in rows:
        d.line([PAD, y - 12, W - PAD, y - 12], fill=(228, 228, 228), width=1)
        d.text((PAD, y + 6), f'{tag} · {name}', font=f_name, fill=(20, 20, 20))
        line, ly = '', y + 44
        for ch in desc:
            if d.textlength(line + ch, font=f_desc) > LABEL_W - 30:
                d.text((PAD, ly), line, font=f_desc, fill=(110, 110, 110))
                line, ly = ch, ly + 21
            else:
                line += ch
        d.text((PAD, ly), line, font=f_desc, fill=(110, 110, 110))

        x = PAD + LABEL_W
        # 1) 256 浅底
        d.rectangle([x, y + 8, x + COL - 20, y + ROW_H - 34], fill=(255, 255, 255), outline=LINE)
        img.alpha_composite(render(256, glyph, 'dark').resize((236, 236), Image.LANCZOS), (x + 6, y + 14))
        cap(x + 6, y + ROW_H - 26, '256 · 浅底(黑底牌)')
        x += COL
        # 2) 256 深底 —— 纯黑牌在深底上会融进去,这是真实表现
        d.rectangle([x, y + 8, x + COL - 20, y + ROW_H - 34], fill=INK, outline=LINE_D)
        img.alpha_composite(render(256, glyph, 'dark').resize((236, 236), Image.LANCZOS), (x + 6, y + 14))
        cap(x + 6, y + ROW_H - 26, '256 · 深底(黑牌融底)')
        x += COL
        # 3) 256 白底牌
        d.rectangle([x, y + 8, x + COL - 20, y + ROW_H - 34], fill=(255, 255, 255), outline=LINE)
        img.alpha_composite(render(256, glyph, 'light').resize((236, 236), Image.LANCZOS), (x + 6, y + 14))
        cap(x + 6, y + ROW_H - 26, '256 · 白底牌(黑字形)')
        x += COL
        # 4) 实际尺寸 · 浅底
        d.rectangle([x, y + 8, x + COL - 20, y + ROW_H - 34], fill=(255, 255, 255), outline=LINE)
        cx, cy = x + 12, y + 24
        for s in (64, 48, 32, 16):
            img.alpha_composite(render(s, glyph, 'dark'), (cx, cy))
            d.text((cx, cy + 68), f'{s}px', font=f_mono, fill=(120, 120, 120))
            cx += s + 12
        cap(x + 6, y + ROW_H - 26, '实际尺寸 · 浅底')
        x += COL
        # 5) 实际尺寸 · 深底
        d.rectangle([x, y + 8, x + COL - 20, y + ROW_H - 34], fill=INK, outline=LINE_D)
        cx, cy = x + 12, y + 24
        for s in (64, 48, 32, 16):
            img.alpha_composite(render(s, glyph, 'light'), (cx, cy))
            d.text((cx, cy + 68), f'{s}px', font=f_mono, fill=(150, 150, 150))
            cx += s + 12
        cap(x + 6, y + ROW_H - 26, '实际尺寸 · 深底(白牌)')
        x += COL
        # 6) 16px 放大 8 倍
        d.rectangle([x, y + 8, x + COL - 20, y + ROW_H - 34], fill=(245, 245, 245), outline=LINE)
        img.alpha_composite(render(16, glyph, 'dark').resize((112, 112), Image.NEAREST), (x + 6, y + 12))
        img.alpha_composite(render(16, glyph, 'light').resize((112, 112), Image.NEAREST), (x + 6, y + 132))
        cap(x + 6, y + ROW_H - 26, '16px ×7(黑牌 / 白牌)')
        y += ROW_H + 22

    # 极性对比
    d.line([PAD, y - 12, W - PAD, y - 12], fill=(228, 228, 228), width=1)
    d.text((PAD, y + 6), '底板极性对比(以 A 为例)', font=f_name, fill=(20, 20, 20))
    d.text((PAD, y + 44), '同一枚图标放在浅色/深色任务栏上的实际观感。\n'
                          '纯黑牌在深色栏上会融底 —— 这是选极性时要权衡的点。',
           font=f_desc, fill=(110, 110, 110))
    a = dict((t, g) for t, _, _, g in rows)['A']
    variants = [
        ('黑底牌 · 浅栏', (245, 245, 245), render(96, a, 'dark')),
        ('黑底牌 · 深栏', INK, render(96, a, 'dark')),
        ('黑底牌+发丝边 · 深栏', INK, render(96, a, 'dark', border=((240, 240, 240), 0.012))),
        ('白底牌 · 浅栏', (245, 245, 245), render(96, a, 'light')),
        ('白底牌 · 深栏', INK, render(96, a, 'light')),
    ]
    x = PAD + LABEL_W
    for label, bg, ic in variants:
        d.rectangle([x, y + 96, x + 128, y + 232], fill=bg,
                    outline=LINE if bg[0] > 128 else LINE_D)
        img.alpha_composite(ic, (x + 16, y + 112))
        cap(x, y + 238, label if len(label) < 16 else label, (120, 120, 120))
        x += 148

    p = os.path.join(OUT, 'sheet-concepts-v2.png')
    img.convert('RGB').save(p)
    return p


def sheet_context(rows):
    """在场景里看:Windows 任务栏(深/浅) + 应用左上角品牌区(与 UI 1:1)。"""
    W, H = 1360, 720
    img = Image.new('RGBA', (W, H), (250, 250, 250, 255))
    d = ImageDraw.Draw(img)
    f_title = font(FONT_CN, 30)
    f_sub = font(FONT_CN, 16)
    f_small = font(FONT_CN, 13)
    f_mono = font(FONT_MONO, 13)
    f_cn = font(FONT_CN, 13)
    f_brand = font(FONT_CN, 17)
    glyphs = [(t, g) for t, _n, _d, g in rows]

    d.text((26, 24), 'Llama Rig · 图标方案 v2 — 场景校核', font=f_title, fill=(20, 20, 20))
    d.text((26, 62), '任务栏按 32px 实际像素绘制(未放大);品牌区与 prototype/layout-demo.html 的 .brand-mark 同尺寸同圆角',
           font=f_sub, fill=(110, 110, 110))

    def bar(y, bg, label, line_col, polarity, caption_col):
        d.text((26, y - 26), label, font=f_small, fill=caption_col)
        d.rectangle([26, y, W - 26, y + 56], fill=bg)
        x = 46
        for t, g in glyphs:
            if polarity == 'glyph':
                ic = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
                g(ImageDraw.Draw(ic), 32, (240, 240, 240), small=False)
            else:
                ic = render(32, g, polarity)
            img.alpha_composite(ic, (x, y + 12))
            d.text((x + 2, y + 44), t, font=f_small, fill=caption_col)
            x += 66
        # 参照:两个中性方块
        for k in range(2):
            d.rounded_rectangle([x, y + 12, x + 32, y + 44], radius=4,
                                fill=(90, 90, 90) if bg[0] < 128 else (170, 170, 170))
            x += 66
        d.text((x + 4, y + 22), '← 参照方块(同尺寸)', font=f_small, fill=caption_col)

    bar(110, (31, 31, 31), 'Windows 11 深色任务栏(32px 实际大小 · 黑底牌)', LINE_D, 'dark', (150, 150, 150))
    bar(210, (243, 243, 243), 'Windows 11 浅色任务栏(32px 实际大小 · 黑底牌)', LINE, 'dark', (120, 120, 120))
    bar(310, (31, 31, 31), 'Windows 11 深色任务栏(32px · 透明底白字形,无底牌)', LINE_D, 'glyph', (150, 150, 150))

    # 应用左上角品牌区
    d.line([26, 420, W - 26, 420], fill=(228, 228, 228), width=1)
    d.text((26, 440), '应用左上角品牌区(与 UI 1:1):图标 A 直接复用为 .brand-mark', font=f_brand, fill=(20, 20, 20))
    for k, bg in enumerate([(255, 255, 255), (10, 10, 10)]):
        y = 490 + k * 96
        d.rectangle([26, y, W - 26, y + 76], fill=bg, outline=LINE if bg[0] > 128 else LINE_D)
        dark_row = bg[0] < 128
        chip_bg = (240, 240, 240) if dark_row else (10, 10, 10)
        chip_fg = (10, 10, 10) if dark_row else (255, 255, 255)
        name_fg = (224, 224, 224) if dark_row else (26, 26, 26)
        sub_fg = (102, 102, 102) if dark_row else (136, 136, 136)
        # 30px 品牌标记(与 UI 同:radius 8, 800 字重 LR)
        S = 30 * SS
        chip = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        cd = ImageDraw.Draw(chip)
        cd.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(8 * SS), fill=chip_bg)
        f = font(FONT_BOLD, 12 * SS * 1.0)
        l, t, r, b = cd.textbbox((0, 0), 'LR', font=f)
        cd.text((S / 2 - (l + r) / 2, S / 2 - (t + b) / 2), 'LR', font=f, fill=chip_fg)
        img.alpha_composite(chip.resize((30, 30), Image.LANCZOS), (46, y + 23))
        d.text((86, y + 22), 'Llama Rig', font=font(FONT_CN, 17), fill=name_fg)
        d.text((86, y + 46), '本地多引擎工作台', font=f_cn, fill=sub_fg)
        # 同一枚图标放到 30px 对比
        img.alpha_composite(render(30, rows[0][3], 'dark' if bg[0] > 128 else 'light'), (330, y + 23))
        d.text((372, y + 32), '← 图标 A 缩到 30px,与左侧品牌标记同款',
               font=f_small, fill=(102, 102, 102) if dark_row else (120, 120, 120))

    p = os.path.join(OUT, 'sheet-incontext-v2.png')
    img.convert('RGB').save(p)
    return p


if __name__ == '__main__':
    for tag, _name, _desc, glyph in CONCEPTS:
        save_concept(tag, glyph)
        print('wrote concept', tag)
    print('wrote', os.path.relpath(sheet(CONCEPTS), HERE))
    print('wrote', os.path.relpath(sheet_context(CONCEPTS), HERE))
