#!/usr/bin/env python3
"""
Build the beginner guide as a PDF with vector infographics.

Why not a markdown-to-pdf converter: every diagram here is drawn from the same
numbers the document states. The gate diagram shows 7 gates because arming.ts
defines 7; the risk diagram compounds 1% ten times and prints what it computes.
A converter would have let those drift.

Why no matplotlib: it is not installed on this image, and vector shapes from
reportlab are sharper than a rasterised chart anyway. Every figure is a group of
paths and rects, so it stays crisp at any zoom and the file is small.

Glyphs: Liberation has no guaranteed arrow/tick coverage, so arrows, ticks and
crosses are drawn as shapes. Text never depends on a glyph the font may lack.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.lib.enums import TA_LEFT

OUT = "Asterion-Beginner-Guide.pdf"

# ── palette ─────────────────────────────────────────────────────────────────
INK      = HexColor("#111318")
MUTED    = HexColor("#5c6270")
FAINT    = HexColor("#9aa1ad")
RULE     = HexColor("#e2e5ea")
CARD     = HexColor("#f5f6f8")
ACCENT   = HexColor("#2f6df6")   # blue: structure, arrows, headings
GREEN    = HexColor("#14934a")   # profit, passed, met
RED      = HexColor("#d02b2b")   # loss, killed, unmet
AMBER    = HexColor("#b5730a")   # caution, paper mode
WHITE    = HexColor("#ffffff")

FONT_R = "LibR"; FONT_B = "LibB"; FONT_I = "LibI"; FONT_BI = "LibBI"

def register():
    base = "/usr/share/fonts/truetype/liberation/"
    pdfmetrics.registerFont(TTFont(FONT_R, base + "LiberationSans-Regular.ttf"))
    pdfmetrics.registerFont(TTFont(FONT_B, base + "LiberationSans-Bold.ttf"))
    pdfmetrics.registerFont(TTFont(FONT_I, base + "LiberationSans-Italic.ttf"))
    pdfmetrics.registerFont(TTFont(FONT_BI, base + "LiberationSans-BoldItalic.ttf"))
    pdfmetrics.registerFontFamily(FONT_R, normal=FONT_R, bold=FONT_B, italic=FONT_I, boldItalic=FONT_BI)

W, H = A4
M = 18 * mm          # page margin
CW = W - 2 * M       # content width

# ── primitive helpers ───────────────────────────────────────────────────────

def text(c, x, y, s, font=FONT_R, size=9.5, color=INK, align="l"):
    c.setFont(font, size)
    c.setFillColor(color)
    if align == "l":   c.drawString(x, y, s)
    elif align == "c": c.drawCentredString(x, y, s)
    else:              c.drawRightString(x, y, s)

def para(c, x, y, width, s, size=9.5, leading=13, color=INK, font=FONT_R, align=TA_LEFT):
    """Wrapped text. Returns the y below the last line."""
    st = ParagraphStyle("p", fontName=font, fontSize=size, leading=leading,
                        textColor=color, alignment=align)
    p = Paragraph(s, st)
    w, h = p.wrapOn(c, width, 10 * H)
    p.drawOn(c, x, y - h)
    return y - h

def rrect(c, x, y, w, h, r=3, fill=None, stroke=None, lw=0.7, dash=None):
    c.saveState()
    if dash: c.setDash(*dash)
    if fill: c.setFillColor(fill)
    if stroke: c.setStrokeColor(stroke); c.setLineWidth(lw)
    c.roundRect(x, y, w, h, r, stroke=1 if stroke else 0, fill=1 if fill else 0)
    c.restoreState()

def arrow(c, x1, y1, x2, y2, color=ACCENT, lw=1.1, head=3.4):
    """A line with a filled triangle head. Drawn, never a glyph."""
    import math
    c.saveState(); c.setStrokeColor(color); c.setLineWidth(lw)
    c.line(x1, y1, x2, y2)
    a = math.atan2(y2 - y1, x2 - x1)
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(x2 - head * math.cos(a - 0.45), y2 - head * math.sin(a - 0.45))
    p.lineTo(x2 - head * math.cos(a + 0.45), y2 - head * math.sin(a + 0.45))
    p.close()
    c.setFillColor(color); c.drawPath(p, stroke=0, fill=1)
    c.restoreState()

def tick(c, x, y, s=4.6, color=GREEN, lw=1.3):
    c.saveState(); c.setStrokeColor(color); c.setLineWidth(lw); c.setLineCap(1)
    p = c.beginPath(); p.moveTo(x - s * 0.5, y); p.lineTo(x - s * 0.05, y - s * 0.55); p.lineTo(x + s, y + s * 0.45)
    c.drawPath(p, stroke=1, fill=0); c.restoreState()

def cross(c, x, y, s=4.2, color=RED, lw=1.3):
    c.saveState(); c.setStrokeColor(color); c.setLineWidth(lw); c.setLineCap(1)
    c.line(x - s/2, y - s/2, x + s/2, y + s/2)
    c.line(x - s/2, y + s/2, x + s/2, y - s/2)
    c.restoreState()

def pill(c, x, y, label, fill, textcol=WHITE, size=7.2, pad=5, h=12.5):
    c.setFont(FONT_B, size)
    w = c.stringWidth(label, FONT_B, size) + 2 * pad
    rrect(c, x, y, w, h, r=h/2, fill=fill)
    text(c, x + w/2, y + h/2 - size*0.34, label, FONT_B, size, textcol, "c")
    return w

# ── page furniture ──────────────────────────────────────────────────────────

PAGE = {"n": 0}

def footer(c, label=""):
    text(c, M, 12*mm, "Asterion - beginner guide", FONT_R, 7.6, FAINT)
    if label:
        text(c, M + 42*mm, 12*mm, label, FONT_R, 7.6, FAINT)
    text(c, W - M, 12*mm, str(PAGE["n"]), FONT_B, 8, MUTED, "r")
    c.saveState(); c.setStrokeColor(RULE); c.setLineWidth(0.5)
    c.line(M, 15.5*mm, W - M, 15.5*mm); c.restoreState()

def new_page(c, title=None, kicker=None, label=""):
    c.showPage()
    PAGE["n"] += 1
    y = H - M
    if kicker:
        text(c, M, y - 8, kicker.upper(), FONT_B, 7.6, ACCENT)
        y -= 17
    if title:
        y = para(c, M, y, CW, title, size=19, leading=22, font=FONT_B)
    footer(c, label)
    return y - 8

def section_head(c, y, num, title, sub=None):
    rrect(c, M, y - 13, 15, 15, r=3, fill=ACCENT)
    text(c, M + 7.5, y - 9, str(num), FONT_B, 9.5, WHITE, "c")
    text(c, M + 22, y - 8.5, title, FONT_B, 13, INK)
    y -= 19
    if sub:
        y = para(c, M + 22, y, CW - 22, sub, size=9, leading=12.4, color=MUTED, font=FONT_I)
    return y - 6

def bullets(c, x, y, width, items, size=9.2, leading=12.5, gap=3.4, color=INK, dotcol=ACCENT):
    for it in items:
        c.saveState(); c.setFillColor(dotcol); c.circle(x + 2.4, y - 3.1, 1.25, stroke=0, fill=1); c.restoreState()
        y = para(c, x + 9, y, width - 9, it, size=size, leading=leading, color=color)
        y -= gap
    return y

# ══════════════════════════════════════════════════════════════════════════
# FIGURE 1 - what runs, when (the heartbeat)
# ══════════════════════════════════════════════════════════════════════════

def fig_schedule(c, y):
    rows = [
        ("every 5 min",    "Sentinel + desk tick",  "scans the watchlist, then one full trading pass", ACCENT),
        ("every hour",     "Crawler + analyst",     "fetches new bounty programs, re-scores what passed", ACCENT),
        ("03:15 daily",    "Maintenance",           "verifies the audit log, ages out old approvals", MUTED),
        ("every 6 hours",  "Dead-man's switch",     "checks the worker is alive, alerts if not", MUTED),
        ("06:30 daily",    "Briefing",              "one Telegram message with the day's summary", GREEN),
    ]
    # Row spacing is a text metric, not a guess: 8.8pt text needs ~6mm of
    # baseline pitch to clear its own ascenders. The first build used 15mm total
    # for five rows = 1.6mm pitch, and the rows genuinely overlapped.
    ROW_PITCH = 6.4 * mm
    h = ROW_PITCH * len(rows) + 6 * mm
    rrect(c, M, y - h, CW, h, r=4, fill=CARD)
    # the timeline spine
    c.saveState(); c.setStrokeColor(HexColor("#cfd4dc")); c.setLineWidth(1.2)
    c.line(M + 13*mm, y - 4*mm, M + 13*mm, y - h + 3.4*mm); c.restoreState()

    per = ROW_PITCH
    for i, (when, what, does, col) in enumerate(rows):
        yy = y - 6.0*mm - i * per
        c.saveState(); c.setFillColor(col); c.circle(M + 13*mm, yy - 1.2*mm, 2.1, stroke=0, fill=1); c.restoreState()
        text(c, M + 18.5*mm, yy - 2.2*mm, when, FONT_B, 7.6, col if col is not MUTED else MUTED)
        text(c, M + 40*mm, yy - 2.2*mm, what, FONT_B, 8.8, INK)
        text(c, M + 40*mm + 34*mm, yy - 2.2*mm, does, FONT_R, 8.2, MUTED)
    return y - h - 5*mm

# ══════════════════════════════════════════════════════════════════════════
# FIGURE 2 - the desk pipeline: where a coin dies
# ══════════════════════════════════════════════════════════════════════════

def fig_pipeline(c, y):
    h = 52 * mm
    stages = [
        ("1", "SCOUT",    "liquid?\nnew enough?",   "throws away the\nobviously wrong"),
        ("2", "FILTER",   "can you sell?\nowner mint?", "simulates a real sell,\nchecks the mint authority"),
        ("3", "ANALYST",  "score 0-100\nany floor failed?", "writes the number\nand the reason"),
        ("4", "RISK",     "slot free?\ndaily loss hit?", "opens at half size,\nsets the stop"),
    ]
    n = len(stages)
    gap = 4 * mm
    bw = (CW - gap * (n - 1)) / n

    for i, (num, name, asks, does) in enumerate(stages):
        x = M + i * (bw + gap)
        rrect(c, x, y - h + 12*mm, bw, h - 12*mm, r=4, fill=CARD, stroke=RULE)
        # stage number chip
        rrect(c, x + 4*mm, y - 8*mm, 7*mm, 7*mm, r=1.8, fill=ACCENT)
        text(c, x + 7.5*mm, y - 5.6*mm, num, FONT_B, 8.5, WHITE, "c")
        text(c, x + 13*mm, y - 5.6*mm, name, FONT_B, 8.2, INK)

        yy = y - 13*mm
        for line in asks.split("\n"):
            text(c, x + 4*mm, yy, line, FONT_R, 7.5, MUTED); yy -= 4.2*mm
        yy -= 1.6*mm
        c.saveState(); c.setStrokeColor(RULE); c.setLineWidth(0.5)
        c.line(x + 4*mm, yy + 1.2*mm, x + bw - 4*mm, yy + 1.2*mm); c.restoreState()
        yy -= 2.6*mm
        for line in does.split("\n"):
            text(c, x + 4*mm, yy, line, FONT_I, 7.3, INK); yy -= 3.9*mm

        if i < n - 1:
            arrow(c, x + bw + 0.7*mm, y - h/2 + 6*mm, x + bw + gap - 0.7*mm, y - h/2 + 6*mm, ACCENT, 1.0, 3.0)

    # The outcome band, spanning the row. It belongs to the WHOLE pipeline, not to
    # FILTER: drawing one short arrow under stage 2 read as "filter kills everything",
    # which is wrong. Most coins die at some stage; the band says so once.
    ey = y - h - 0.5*mm
    rrect(c, M, ey - 11*mm, CW, 11*mm, r=2.5, fill=HexColor("#fdeaea"))
    text(c, M + 6*mm, ey - 7*mm, "ANY STAGE CAN KILL A COIN", FONT_B, 7.6, RED)
    text(c, M + 52*mm, ey - 7*mm, "most do, most days, and that is the feature working - an empty trade list is a correct outcome, not a broken bot",
         FONT_R, 7.8, HexColor("#8c3a3a"))
    return ey - 15*mm

# ══════════════════════════════════════════════════════════════════════════
# FIGURE 3 - 1% risk, compounded: why the size is the safety
# ══════════════════════════════════════════════════════════════════════════

def fig_risk(c, y):
    h = 46 * mm
    rrect(c, M, y - h, CW, h, r=4, fill=CARD)

    # left: the compounding table, computed not typed
    text(c, M + 6*mm, y - 8*mm, "10 losses in a row, at three risk sizes", FONT_B, 8.6, INK)
    text(c, M + 6*mm, y - 13*mm, "compounded, not added", FONT_I, 7.4, MUTED)

    risks = [0.01, 0.05, 0.10]
    colx = [M + 6*mm, M + 62*mm, M + 88*mm]
    text(c, colx[0], y - 20*mm, "risk / trade", FONT_B, 7.2, MUTED)
    text(c, colx[1], y - 20*mm, "left after 10", FONT_B, 7.2, MUTED)
    text(c, colx[2], y - 20*mm, "still needed to recover", FONT_B, 7.2, MUTED)

    yy = y - 26*mm
    for r in risks:
        left = (1 - r) ** 10
        recover = (1 / left) - 1
        col = GREEN if r == 0.01 else (AMBER if r == 0.05 else RED)
        text(c, colx[0], yy, f"{int(r*100)}%", FONT_B, 8.2, col)
        text(c, colx[1], yy, f"${left*10000:,.0f}  of $10,000", FONT_R, 8.2, INK)
        text(c, colx[2], yy, f"+{recover*100:.0f}% to get back", FONT_R, 8.2, INK)
        yy -= 5.4*mm

    # right: a bar strip showing the same three cases
    bx = M + 128*mm
    bw = CW - 134*mm
    text(c, bx, y - 8*mm, "how deep each hole is", FONT_B, 8.6, INK)
    text(c, bx, y - 13*mm, "bar length = loss", FONT_I, 7.4, MUTED)
    yy = y - 20*mm
    for r in risks:
        left = (1 - r) ** 10
        lost = 1 - left
        col = GREEN if r == 0.01 else (AMBER if r == 0.05 else RED)
        text(c, bx, yy, f"{int(r*100)}%", FONT_B, 7.4, col)
        rrect(c, bx + 10*mm, yy - 1.1*mm, bw - 10*mm, 3.4*mm, r=1.7, fill=HexColor("#e7eaef"))
        rrect(c, bx + 10*mm, yy - 1.1*mm, max(1.2*mm, (bw - 10*mm) * lost), 3.4*mm, r=1.7, fill=col)
        text(c, bx + bw, yy + 6.2*mm, f"-{lost*100:.0f}%", FONT_B, 7.4, col, "r")
        yy -= 9*mm

    text(c, M + 6*mm, y - h + 4*mm,
         "The 1% column is survivable. The 10% column needs a double just to break even. Same strategy, same ten trades.",
         FONT_I, 7.4, MUTED)
    return y - h - 5*mm

# ══════════════════════════════════════════════════════════════════════════
# FIGURE 4 - the seven arming gates
# ══════════════════════════════════════════════════════════════════════════

def fig_gates(c, y):
    gates = [
        ("200 closed paper trades", "fewer than that and the statistics mean nothing"),
        ("30 days of paper history", "a strategy can look great for a week and be broken by a month"),
        ("positive expectancy after fees", "it must make money after costs, not before"),
        ("max drawdown under 20%", "the worst peak-to-trough run has to be survivable"),
        ("DESK_LIVE=1 set as a secret", "a deliberate act, never a default"),
        ("a capital cap above zero", "a hard ceiling on what can be lost"),
        ("the signing key held outside the worker", "the key that moves money must not sit with the code that decides"),
    ]
    h = 47 * mm
    rrect(c, M, y - h, CW, h, r=4, fill=CARD, stroke=RULE)
    text(c, M + 6*mm, y - 8*mm, "ALL SEVEN, OR IT STAYS ON PAPER", FONT_B, 8.6, INK)
    text(c, M + 6*mm, y - 13*mm, "no button flips this - there is no button that can start real trading", FONT_I, 7.4, MUTED)

    per = (h - 20*mm) / len(gates)
    for i, (g, why) in enumerate(gates):
        yy = y - 18*mm - i * per
        c.saveState(); c.setFillColor(WHITE); c.setStrokeColor(HexColor("#cfd4dc")); c.setLineWidth(0.7)
        c.circle(M + 8*mm, yy + 1.2*mm, 2.3, stroke=1, fill=1); c.restoreState()
        text(c, M + 7.25*mm, yy + 0.1*mm, str(i + 1), FONT_B, 6.2, MUTED, "c")
        text(c, M + 13*mm, yy, g, FONT_B, 7.9, INK)
        text(c, M + 82*mm, yy, why, FONT_R, 7.5, MUTED)
    return y - h - 5*mm

# ══════════════════════════════════════════════════════════════════════════
# FIGURE 5 - the trading screen, annotated
# ══════════════════════════════════════════════════════════════════════════

def fig_screen(c, y):
    h = 62 * mm
    px, pw = M, CW * 0.42
    # a wireframe of the Trade screen
    rrect(c, px, y - h, pw, h, r=4, fill=WHITE, stroke=RULE)
    # header band
    rrect(c, px, y - 11*mm, pw, 11*mm, r=4, fill=HexColor("#eceffb"))
    text(c, px + 4*mm, y - 7*mm, "Trade", FONT_B, 8.6, INK)
    text(c, px + pw - 4*mm, y - 7*mm, "paper", FONT_B, 7, AMBER, "r")

    # equity block
    text(c, px + 4*mm, y - 17*mm, "$1,020.50", FONT_B, 13, INK)
    text(c, px + 4*mm, y - 21.5*mm, "equity", FONT_R, 6.4, MUTED)
    text(c, px + 26*mm, y - 17*mm, "+$20.00", FONT_B, 10, GREEN)
    text(c, px + 26*mm, y - 21.5*mm, "net", FONT_R, 6.4, MUTED)

    # sparkline
    base = y - 33*mm
    pts = [2, 5, 4, 8, 7, 11, 10, 14, 12, 16]
    bw = (pw - 8*mm) / len(pts)
    for i, v in enumerate(pts):
        bh = 1.4*mm + v * 0.32*mm
        rrect(c, px + 4*mm + i*bw, base, bw*0.78, bh, r=0.7, fill=GREEN if i == len(pts)-1 else HexColor("#9ec9ae"))
    c.saveState(); c.setStrokeColor(RULE); c.setLineWidth(0.5)
    c.line(px + 4*mm, base, px + pw - 4*mm, base); c.restoreState()

    # stats row
    st = [("3", "trades"), ("66.7%", "win rate"), ("3.00", "profit factor"), ("2/1", "w/l")]
    for i, (v, k) in enumerate(st):
        x = px + 4*mm + i * (pw - 8*mm) / 4
        text(c, x, y - 41*mm, v, FONT_B, 8.4, INK)
        text(c, x, y - 45*mm, k, FONT_R, 6.2, MUTED)

    # closed rows
    rows = [("AAA", "+$20.00", "trail", GREEN), ("BBB", "+$10.00", "trail", GREEN), ("CCC", "-$10.00", "stop", RED)]
    yy = y - 50*mm
    for sym, pnl, why, col in rows:
        text(c, px + 4*mm, yy, sym, FONT_B, 7, INK)
        text(c, px + 16*mm, yy, pnl, FONT_R, 7, col)
        text(c, px + 34*mm, yy, why, FONT_R, 6.6, MUTED)
        yy -= 4*mm

    # annotations, right
    ax = M + CW * 0.46
    notes = [
        ("equity is what you own if you closed now", 17),
        ("net is every closed trade added up - the only number that matters", 21),
        ("each bar is one closed trade; read the SHAPE, not the bars", 30),
        ("four numbers, and all four together; one alone will mislead", 43),
        ("the exit REASON is the useful part, not the profit", 51),
    ]
    for label, off in notes:
        yy = y - off*mm
        c.saveState(); c.setFillColor(ACCENT); c.circle(ax - 1.6*mm, yy + 1.1*mm, 1.1, stroke=0, fill=1); c.restoreState()
        arrow(c, ax, yy + 1.1*mm, px + pw + 1.2*mm, yy + 1.1*mm, HexColor("#c3ccdd"), 0.6, 2.4)
        text(c, ax + 2*mm, yy, label, FONT_R, 7.6, INK)
    return y - h - 5*mm

register()
c = canvas.Canvas(OUT, pagesize=A4)
c.setTitle("Asterion - beginner guide")
c.setAuthor("Aether")
c.setSubject("How to use every feature in the Asterion desk, in plain language")

# ════════════════════════ COVER ════════════════════════
PAGE["n"] = 1
c.setFillColor(INK); c.rect(0, 0, W, H, stroke=0, fill=1)

# a faint grid, so the cover reads as a technical document rather than a poster
c.saveState(); c.setStrokeColor(HexColor("#1e222b")); c.setLineWidth(0.4)
for gx in range(0, int(W), int(12*mm)): c.line(gx, 0, gx, H)
for gy in range(0, int(H), int(12*mm)): c.line(0, gy, W, gy)
c.restoreState()

text(c, M, H - 42*mm, "ASTERION", FONT_B, 10, HexColor("#7f8ba3"))
text(c, M, H - 52*mm, "DESK MANUAL", FONT_B, 10, HexColor("#7f8ba3"))

y = H - 78*mm
y = para(c, M, y, CW * 0.82,
         "A beginner's guide to<br/>every feature, in plain words",
         size=30, leading=34, color=WHITE, font=FONT_B)
text(c, M, y - 8*mm, "No crypto background assumed. If you can open Telegram and type, you can run this.",
     FONT_I, 10.5, HexColor("#9aa6bd"))

# the cover diagram: the two workers feeding two screens
dy = 74*mm
box = CW * 0.22
rrect(c, M, dy, box, 34*mm, r=4, fill=HexColor("#171b23"), stroke=HexColor("#2b3240"))
text(c, M + box/2, dy + 25*mm, "HUNT", FONT_B, 9, ACCENT, "c")
text(c, M + box/2, dy + 19*mm, "finds bugs in", FONT_R, 7.4, HexColor("#9aa6bd"), "c")
text(c, M + box/2, dy + 14.5*mm, "crypto software", FONT_R, 7.4, HexColor("#9aa6bd"), "c")
text(c, M + box/2, dy + 6*mm, "pays for itself", FONT_I, 7.2, HexColor("#6f7b91"), "c")

box2x = M + box + 12*mm
rrect(c, box2x, dy, box, 34*mm, r=4, fill=HexColor("#171b23"), stroke=HexColor("#2b3240"))
text(c, box2x + box/2, dy + 25*mm, "TRADE", FONT_B, 9, GREEN, "c")
text(c, box2x + box/2, dy + 19*mm, "tests strategies", FONT_R, 7.4, HexColor("#9aa6bd"), "c")
text(c, box2x + box/2, dy + 14.5*mm, "on paper money", FONT_R, 7.4, HexColor("#9aa6bd"), "c")
text(c, box2x + box/2, dy + 6*mm, "before real dollars", FONT_I, 7.2, HexColor("#6f7b91"), "c")

arrow(c, box2x + box + 3*mm, dy + 17*mm, box2x + box + 14*mm, dy + 17*mm, HexColor("#4b5568"), 1.2, 3.2)

rrect(c, box2x + box + 15*mm, dy, CW - (box*2 + 12*mm + 15*mm), 34*mm, r=4, fill=HexColor("#101419"), stroke=HexColor("#2b3240"))
text(c, box2x + box + 20*mm, dy + 25*mm, "YOU", FONT_B, 9, WHITE)
text(c, box2x + box + 20*mm, dy + 19*mm, "read two screens", FONT_R, 7.4, HexColor("#9aa6bd"))
text(c, box2x + box + 20*mm, dy + 14*mm, "Trade + Hunt targets", FONT_R, 7.4, HexColor("#9aa6bd"))
text(c, box2x + box + 20*mm, dy + 6*mm, "nothing spends until you say", FONT_I, 7.2, HexColor("#6f7b91"))

text(c, M, 40*mm, "Contents", FONT_B, 8, HexColor("#7f8ba3"))
toc = ["1  What it is", "2  The five words", "3  The schedule", "4  The Trade screen",
       "5  Hunt targets", "6  The Library", "7  The other screens", "8  How a trade happens",
       "9  Going live", "10 Commands", "11 What empty means", "12 What costs money", "13 One minute"]
yy = 34*mm
for i, t in enumerate(toc):
    col = 0 if i < 7 else 1
    x = M + col * (CW / 2)
    yt = yy - (i if i < 7 else i - 7) * 5.2*mm
    text(c, x, yt, t, FONT_R, 7.6, HexColor("#8b97ad"))

# ════════════════════════ 1 - what it is ════════════════════════
y = new_page(c, "What this thing is", "1", "what it is")
y = para(c, M, y + 6, CW,
    "Asterion is two workers in one program. One <b>hunts for bugs in crypto software</b> and pays for "
    "itself by finding holes before someone else does. The other <b>trades on paper</b> - fake money, real "
    "prices - to find out whether a strategy works before you risk a single real dollar. Both run on a "
    "schedule, on a server, while you sleep.", size=10, leading=15)
y -= 4
y = para(c, M, y, CW,
    "You read two screens: one for the desk, one for the trading. That is the whole system.",
    size=10, leading=15, color=MUTED)
y -= 10

y = section_head(c, y, 1, "The safest part is the part you cannot rush",
    "Nothing here can spend your money until seven separate conditions are true. That is not caution for its own sake - it is the design.")

# the same two-worker picture as the cover, but read left to right as a sentence
h = 40*mm
rrect(c, M, y - h, CW, h, r=4, fill=CARD)
cx = [M + CW*0.19, M + CW*0.5, M + CW*0.81]
labels = [
    ("the bot works",   "on a schedule,\nwhile you sleep"),
    ("the screens show", "only what happened,\nnever a guess"),
    ("you decide",       "approving is the one\nirreversible action"),
]
for i, (head, body) in enumerate(labels):
    c.saveState(); c.setFillColor(ACCENT); c.circle(cx[i], y - 10*mm, 1.7, stroke=0, fill=1); c.restoreState()
    text(c, cx[i], y - 16*mm, head, FONT_B, 9.2, INK, "c")
    for j, line in enumerate(body.split("\n")):
        text(c, cx[i], y - 21.5*mm - j*4.2*mm, line, FONT_R, 8.2, MUTED, "c")
    if i < 2:
        arrow(c, cx[i] + 22*mm, y - 10*mm, cx[i+1] - 22*mm, y - 10*mm, HexColor("#c3ccdd"), 1.0, 3.0)
y -= h + 5*mm

y = bullets(c, M, y, CW, [
    "<b>Nothing here is verified against a live exchange yet.</b> The desk runs on paper. Its own arming gate refuses until seven conditions hold, and even then live order submission is not implemented. You cannot lose money by using this today.",
    "<b>Silence is the normal state.</b> An empty queue and an empty trade list are correct most days. If you need daily reassurance that something is happening, this will feel broken - and that feeling is the feature working.",
])
# ════════════════════════ 2 - five words ════════════════════════
y = new_page(c, "The five words you need", "2", "the five words")
y = para(c, M, y + 4, CW, "Everything else in this document is detail. These five are the vocabulary the rest of it uses.",
         size=10, leading=14, color=MUTED)
y -= 10

words = [
    ("Paper mode",  "Trading with fake money. Prices are real, orders are real, the money is imaginary. You lose nothing and learn everything.", AMBER),
    ("Live mode",   "Trading with real money. Same code, real orders, real risk. Seven gates stand between you and this.", RED),
    ("A position",  "Something you bought and still own. Bought $50 of a coin and hold it? That is an open position of $50.", ACCENT),
    ("A stop",      "An automatic sell that fires when the price falls to a level set in advance. It is what stops one bad day becoming a bad month. The desk sets it for you.", GREEN),
    ("Slippage",    "The gap between the price you expected and the price you got. On small coins, your own sell moves the price down against you. It happens on the way in and the way out, and the desk models both.", MUTED),
]
for w, d, col in words:
    h = 20*mm
    rrect(c, M, y - h, CW, h, r=4, fill=CARD)
    rrect(c, M, y - h, 3.2, h, r=1.4, fill=col)
    text(c, M + 8*mm, y - 7*mm, w, FONT_B, 10.5, INK)
    para(c, M + 8*mm, y - 10.5*mm, CW - 14*mm, d, size=8.8, leading=11.8, color=MUTED)
    y -= h + 4*mm
# ════════════════════════ 3 - schedule ════════════════════════
y = new_page(c, "What actually runs, and when", "3", "the schedule")
y = para(c, M, y + 4, CW,
    "Nothing in this system is a button you press repeatedly. It is a schedule. Five timers run on the "
    "server, and you do not have to be awake, online, or have your laptop open.", size=10, leading=14)
y -= 6
y = fig_schedule(c, y)

y = section_head(c, y, 3, "The 5-minute tick is the important one",
    "It does four things in a fixed order, and the order matters - each stage is cheaper than the next, so the expensive ones only see survivors.")
text(c, M + 22, y + 2, "", FONT_R, 9)
y -= 2
y = fig_pipeline(c, y + 6)
# ════════════════════════ 4 - trade screen ════════════════════════
y = new_page(c, "The Trade screen", "4", "the trade screen")
y = para(c, M, y + 4, CW,
    "This is the screen that looks like a trading app. Read top to bottom, and read the blocks in the order "
    "below - each one answers a narrower question than the one above it.", size=10, leading=14)
y -= 8
y = fig_screen(c, y + 2)

y = section_head(c, y, 4, "The one number people misread",
    "Profit factor is money won divided by money lost. It is not a score out of anything.")
y = bullets(c, M + 22, y, CW - 22, [
    "<b>Above 1.0</b> - profitable. <b>Above 1.3</b> - good. <b>Above 2.0</b> - suspicious, and assume it will not last.",
    "If it reads <b>n/a (no losses yet)</b>, that is arithmetic, not a great sign. There is nothing to divide by yet.",
    "Under 30 closed trades, ignore every number on the screen. It is noise dressed as a result.",
])
# ════════════════════════ 5 - hunt targets ════════════════════════
y = new_page(c, "Hunt targets", "5", "hunt targets")
y = para(c, M, y + 4, CW,
    "This screen answers a different question: <b>what is the desk looking at right now, and what did it "
    "already throw away?</b> It reads the table the desk actually fills.", size=10, leading=14)
y -= 8

states = [
    ("passed",  "survived every gate and is tradeable right now. What the desk will buy from.", GREEN),
    ("scored",  "survived the cheap checks and got a score, but no position opened - usually no free slot.", ACCENT),
    ("in (raw)", "the scout saw it and has not checked it properly yet. A queue, not a candidate.", MUTED),
    ("killed",  "rejected, with a reason. The most informative number on the screen: a desk that kills nothing is not filtering.", RED),
    ("expired", "too old to be interesting. Rows age out.", FAINT),
]
h = 44*mm
rrect(c, M, y - h, CW, h, r=4, fill=CARD)
text(c, M + 6*mm, y - 8*mm, "THE FIVE STATES, IN PIPELINE ORDER", FONT_B, 8.6, INK)
yy = y - 14*mm
for name, desc, col in states:
    w = pill(c, M + 6*mm, yy - 3.4*mm, name, col, size=7)
    para(c, M + 12*mm + w, yy - 0.4*mm, CW - 20*mm - w, desc, size=8.4, leading=10.6, color=MUTED)
    yy -= 6.2*mm
y -= h + 6*mm

y = section_head(c, y, 5, "Read the why line, not the score",
    "A token scoring 78 that was still killed has a why line naming the single floor it missed. That reason is far more useful than the total.")
y = bullets(c, M + 22, y, CW - 22, [
    "<b>Liquidity</b> is how much money sits in the pool you would trade against. A $40k pool against a $20M market cap means your own sell moves the price, and the desk therefore requires liquidity of at least <b>3% of market cap</b>.",
    "<b>Holders</b> is how many separate wallets own it. Ten holders means one wallet selling crashes it.",
])
# ════════════════════════ 6 - library ════════════════════════
y = new_page(c, "The Library, and what changed", "6", "the library")
y = para(c, M, y + 4, CW,
    "The Library lists <b>what the program can actually do</b>. Each entry is one bug class it knows how to "
    "hunt, and each shows two facets that are deliberately separate.", size=10, leading=14)
y -= 8

h = 30*mm
for i, (name, desc, col) in enumerate([
    ("a playbook", "the exact route and proof method. If it has one, the bot can actually run it against a target and prove a result.", ACCENT),
    ("a method pack", "the questions to ask first, the false positives to rule out, and what a proof must show. The thinking, not the executing.", GREEN),
]):
    yy = y - i * (h + 3*mm) - h
    rrect(c, M, yy, CW, h, r=4, fill=CARD)
    rrect(c, M, yy, 3.2, h, r=1.4, fill=col)
    text(c, M + 8*mm, yy + h - 8*mm, name, FONT_B, 10.5, INK)
    para(c, M + 8*mm, yy + h - 12*mm, CW - 14*mm, desc, size=8.8, leading=11.8, color=MUTED)
y -= 2 * (h + 3*mm) + 4*mm

y = section_head(c, y, 6, "What changed this round",
    "The Solidity set went from 13 routed classes to 17, and 20 packs in total. Every one of the seven is new methodology, a new route, and a new proof harness.")

new7 = [
    ("sol.overflow",        "arithmetic that wraps, or a cast that silently truncates"),
    ("sol.mev",             "sandwich, backrun and ordering attacks"),
    ("sol.erc4626",         "vault share price and the first-depositor donation"),
    ("sol.erc20",           "tokens that take a fee, rebase, or return nothing"),
    ("sol.proxy",           "storage slots that collide between proxy and logic"),
    ("sol.erc4337",         "account abstraction and paymaster drains"),
    ("sol.signature.ecdsa", "signature replay and zero-address recovery"),
]
yy = y
for i, (k, v) in enumerate(new7):
    text(c, M + 22, yy, k, FONT_B, 7.9, ACCENT)
    text(c, M + 58*mm, yy, v, FONT_R, 7.9, INK)
    yy -= 5.2*mm

yy -= 3*mm
rrect(c, M + 22, yy - 15*mm, CW - 22, 16*mm, r=3, fill=HexColor("#eef4ff"), stroke=HexColor("#cfe0ff"))
text(c, M + 27, yy - 5*mm, "Also fixed: Solana was filed under a heading that read \"Solidity\"", FONT_B, 8.2, ACCENT)
para(c, M + 27, yy - 8*mm, CW - 32, "The three Solana classes have ids starting with <i>sol.</i> and were grouped by that prefix. They are Solana programs. The class now decides the heading, and there is a Solana group.",
     size=8, leading=10.4, color=MUTED)
# ════════════════════════ 7 - other screens ════════════════════════
y = new_page(c, "Reading the rest of the screens", "7", "the other screens")
y = para(c, M, y + 4, CW, "Four screens remain, and each has exactly one job.", size=10, leading=14)
y -= 8

for name, desc, col in [
    ("Hunt",  "Describe a target in plain text. The bot compiles it into a real engagement with rules, and puts it in the queue for you to approve. Nothing runs until you approve.", ACCENT),
    ("Queue", "The approvals waiting for you. Approving is the one irreversible action in the console, so it asks first and writes to an append-only log that cannot be edited afterwards.", AMBER),
    ("Ask",   "Talk to the bot in sentences. It answers about the system.", MUTED),
    ("Ops",   "The inventory: programs, findings, history, the audit log, the desk, the Trade screen, the Hunt-target screen, status and the scoreboard.", GREEN),
]:
    h = 19*mm
    rrect(c, M, y - h, CW, h, r=4, fill=CARD)
    rrect(c, M, y - h, 3.2, h, r=1.4, fill=col)
    text(c, M + 8*mm, y - 7*mm, name, FONT_B, 10.5, INK)
    para(c, M + 8*mm, y - 10.5*mm, CW - 14*mm, desc, size=8.8, leading=11.8, color=MUTED)
    y -= h + 3.5*mm
# ════════════════════════ 8 - how a trade happens ════════════════════════
y = new_page(c, "How a trade actually happens", "8", "how a trade happens")
y = para(c, M, y + 4, CW, "The full path, once, end to end.", size=10, leading=14, color=MUTED)
y -= 10

steps = [
    ("The scout sees a new coin with enough liquidity and volume, and writes a row.", ACCENT),
    ("The filter checks the dangerous things: can the owner mint unlimited tokens, can they freeze your wallet, is selling actually possible.", ACCENT),
    ("The analyst scores it. Failing the floor on any single check kills it, regardless of the total.", ACCENT),
    ("Risk checks for a free position slot and whether the day's loss limit is already hit. If both are fine, it opens at <b>half size</b>.", AMBER),
    ("The other half is bought a moment later at a confirmed price, which is what stops a fast-moving price filling you at a bad level.", AMBER),
    ("A stop is set immediately, and it only ever moves up.", GREEN),
    ("When the stop, the trail, or the thesis fires, it sells and writes the exit with a reason code.", GREEN),
]
yy = y
for i, (s, col) in enumerate(steps):
    rrect(c, M, yy - 13.4*mm, 7.4*mm, 7.4*mm, r=1.9, fill=col)
    text(c, M + 3.7*mm, yy - 10.9*mm, str(i + 1), FONT_B, 8, WHITE, "c")
    yy2 = para(c, M + 11*mm, yy - 3*mm, CW - 12*mm, s, size=8.9, leading=11.6)
    if i < len(steps) - 1:
        cfg = M + 2.9*mm
        c.saveState(); c.setStrokeColor(RULE); c.setLineWidth(1); c.line(cfg, yy - 13.6*mm, cfg, yy2 - 1.6*mm); c.restoreState()
    yy = yy2 - 6*mm

y = yy + 2*mm
y = section_head(c, y, 8, "Two hard limits, and why they are the whole safety",
    "Both are floor limits on the damage, not targets for the upside.")
y -= 2
y = fig_risk(c, y + 4)
# ════════════════════════ 9 - going live ════════════════════════
y = new_page(c, "Going live, and why it takes seven checks", "9", "going live")
y = para(c, M, y + 4, CW,
    "Paper mode is not live mode with a number changed. Each gate below exists because something went wrong "
    "once without it.", size=10, leading=14)
y -= 8
y = fig_gates(c, y)

y = section_head(c, y, 9, "There is deliberately no go-live button",
    "Arming is a server-side secret, not a web control. A web control that can start real trading is one leaked URL away from an empty wallet.")
y = para(c, M + 22, y, CW - 22,
    "Until all seven are true the mode stays <b>paper</b> no matter what you type. You can ask <b>/desk live</b> "
    "in Telegram and it will list what is missing. It cannot arm itself.", size=9, leading=12.4, color=MUTED)
# ════════════════════════ 10 - commands ════════════════════════
y = new_page(c, "The Telegram commands", "10", "commands")
y = para(c, M, y + 4, CW, "Everything the web console does, the bot does too, in the chat.", size=10, leading=14, color=MUTED)
y -= 10

cmds = [
    ("/start  /menu", "the main menu"),
    ("/status",       "worker alive, how many programs, what is queued"),
    ("/hunt &lt;target&gt;", "start a hunt on something"),
    ("/desk",         "desk status and the unmet gates"),
    ("/pos",          "open positions"),
    ("/kills",        "what was rejected and why"),
    ("/calib",        "how accurate the filters have been"),
    ("/corpus",       "the precedent data behind the scoring"),
    ("/ui",           "a link to the full console"),
]
h = len(cmds) * 6.4*mm + 8*mm
rrect(c, M, y - h, CW, h, r=4, fill=CARD)
yy = y - 8*mm
for cmd, desc in cmds:
    text(c, M + 6*mm, yy, cmd, FONT_B, 8.4, ACCENT)
    text(c, M + 44*mm, yy, desc, FONT_R, 8.4, INK)
    yy -= 6.4*mm
y -= h + 8*mm

y = section_head(c, y, 10, "The honest state of the desk",
    "Two things are true right now, and both matter more than any feature list.")
y = bullets(c, M + 22, y, CW - 22, [
    "<b>The flow gate that used to block judging is closed.</b> The filter refuses to judge a token whose flow fields are null, so every candidate was written as a coverage gap and nothing ever opened. The provider that closes it is wired in, so the desk reaches a verdict now.",
    "<b>Live order submission is still unimplemented.</b> The executor throws <i>live_signer_not_wired</i>, so even a fully armed desk refuses. It is a paper-only research instrument until a signer is wired. That is the part of the README that remains true.",
])
# ════════════════════════ 11 - what empty means ════════════════════════
y = new_page(c, "What empty means, in every place it appears", "11", "what empty means")
y = para(c, M, y + 4, CW,
    "Re-read this section whenever something looks blank. Empty is usually correct, and each empty has a "
    "different cause.", size=10, leading=14, color=MUTED)
y -= 10

empties = [
    ("No closed trades",  "Paper mode has not exited a position yet. Positions only close on a stop, a trail, or a thesis break.", GREEN),
    ("No open positions", "Every slot was empty and nothing passed the gates. Normal, and the point.", GREEN),
    ("No targets",        "The scout has not written a row since deploy. The tick runs every 5 minutes; wait one. If still zero, every candidate failed a coarse gate before a row existed.", AMBER),
    ("No approvals",      "Nothing is waiting on you. Correct.", GREEN),
    ("No findings",       "The bot has not proven a bug yet. A finding is written when proven, not when suspected.", GREEN),
    ("Method only",       "That Library class can be reasoned about but has no automated proof route. Honest, and labelled as such.", AMBER),
]
for name, desc, col in empties:
    h = 17*mm
    rrect(c, M, y - h, CW, h, r=4, fill=CARD)
    c.saveState(); c.setFillColor(col); c.circle(M + 7*mm, y - 6*mm, 1.8, stroke=0, fill=1); c.restoreState()
    text(c, M + 12*mm, y - 7*mm, name, FONT_B, 9.4, INK)
    para(c, M + 12*mm, y - 10*mm, CW - 18*mm, desc, size=8.4, leading=11, color=MUTED)
    y -= h + 3.4*mm
# ════════════════════════ 12 - what costs money ════════════════════════
y = new_page(c, "The five things that will cost you money", "12", "what costs money")
y = para(c, M, y + 4, CW, "If you let them. Each one has a defence already built in.", size=10, leading=14, color=MUTED)
y -= 10

costs = [
    ("Overfitting", "A strategy tuned on past data fits that data and nothing else. That is why the desk holds back part of the history the strategy never saw, and why going live needs 30 days rather than 30 trades."),
    ("Thin liquidity", "A $40k pool cannot absorb your exit. You will see a paper profit that cannot be realised. The 3%-of-market-cap rule is the defence."),
    ("One bad week", "Which is why the daily breaker and the 1% risk exist. Ten 1% losers is 10%, survivable. Ten 10% losers is ruin."),
    ("A honeypot", "A token that lets you buy and blocks your sell. The filter checks it by simulating a sell, because reading the code is not enough."),
    ("Believing the backtest", "Every backtest is a story about the past. The only number that has ever predicted the future is live results, and even those only after a few hundred trades."),
]
for i, (name, desc) in enumerate(costs):
    h = 22*mm
    rrect(c, M, y - h, CW, h, r=4, fill=CARD)
    text(c, M + 6*mm, y - 7*mm, f"{i+1}.  {name}", FONT_B, 9.6, RED if i in (0, 2) else INK)
    para(c, M + 6*mm, y - 10.5*mm, CW - 12*mm, desc, size=8.5, leading=11.4, color=MUTED)
    y -= h + 3.6*mm
# ════════════════════════ 13 - one minute ════════════════════════
y = new_page(c, "The one-minute version", "13", "one minute")

h = 56*mm
rrect(c, M, y - h, CW, h, r=5, fill=INK)
text(c, M + 10*mm, y - 13*mm, "THE DAILY LOOP", FONT_B, 8.4, HexColor("#7f8ba3"))
yy = y - 22*mm
for line in [
    "Open the console.",
    "Look at Trade: read equity and net, then the shape of the curve.",
    "Look at Hunt targets: check the passed count, read the why lines on anything killed.",
    "If passed is zero and the kills have real reasons, everything is working.",
    "Leave it alone. Check again tomorrow.",
]:
    c.saveState(); c.setFillColor(HexColor("#4b5568")); c.circle(M + 12*mm, yy + 1.2*mm, 1.3, stroke=0, fill=1); c.restoreState()
    text(c, M + 17*mm, yy, line, FONT_R, 9.6, WHITE)
    yy -= 7*mm

y -= h + 10*mm
y = para(c, M, y, CW,
    "The desk is not a slot machine. It is a filter that occasionally finds something worth doing. "
    "Most days it will do nothing, and that is the feature.", size=12, leading=17, font=FONT_I, color=INK)

y -= 6*mm
c.saveState(); c.setStrokeColor(RULE); c.setLineWidth(0.6); c.line(M, y, M + 40*mm, y); c.restoreState()

y -= 12*mm
text(c, M, y, "Asterion · desk manual", FONT_B, 8, MUTED)
text(c, M, y - 5*mm, "Generated from the same source the screens read. Numbers in the figures are computed, not typed.", FONT_I, 7.4, FAINT)

c.save()
print("wrote", OUT)
