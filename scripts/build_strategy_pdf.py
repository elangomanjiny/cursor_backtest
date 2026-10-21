"""Build the strategy Long/Short Entry–Exit PDF from engine rules (v2.2.24)."""
from __future__ import annotations

import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "strategy-entry-exit-v2.2.24.pdf"

NAVY = colors.HexColor("#0d1117")
INK = colors.HexColor("#1f2328")
MUTED = colors.HexColor("#57606a")
LINE = colors.HexColor("#d0d7de")
LONG_BG = colors.HexColor("#dafbe1")
LONG_HD = colors.HexColor("#1a7f37")
SHORT_BG = colors.HexColor("#ffebe9")
SHORT_HD = colors.HexColor("#cf222e")
ENTRY_BG = colors.HexColor("#ddf4ff")
EXIT_BG = colors.HexColor("#fff8c5")
HEAD_BG = colors.HexColor("#1f6feb")


def styles():
    base = getSampleStyleSheet()
    s = {
        "cover": ParagraphStyle(
            "cover",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=20,
            leading=24,
            textColor=NAVY,
            alignment=TA_CENTER,
            spaceAfter=6,
        ),
        "sub": ParagraphStyle(
            "sub",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            leading=13,
            textColor=MUTED,
            alignment=TA_CENTER,
            spaceAfter=14,
        ),
        "h1": ParagraphStyle(
            "h1",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=18,
            textColor=NAVY,
            spaceBefore=8,
            spaceAfter=8,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=14,
            textColor=HEAD_BG,
            spaceBefore=6,
            spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "body",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=8.5,
            leading=11.5,
            textColor=INK,
            alignment=TA_JUSTIFY,
        ),
        "cell": ParagraphStyle(
            "cell",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=8,
            leading=10.8,
            textColor=INK,
            alignment=TA_LEFT,
        ),
        "cellhd": ParagraphStyle(
            "cellhd",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=9,
            leading=11,
            textColor=colors.white,
            alignment=TA_CENTER,
        ),
        "tiny": ParagraphStyle(
            "tiny",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=7.5,
            leading=10,
            textColor=MUTED,
        ),
        "bullet": ParagraphStyle(
            "bullet",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=8.5,
            leading=11.5,
            textColor=INK,
            leftIndent=10,
            bulletIndent=0,
        ),
    }
    return s


def P(text: str, st) -> Paragraph:
    return Paragraph(text.replace("\n", "<br/>"), st)


def quad(s, long_entry, long_exit, short_entry, short_exit):
    hd_le = P("LONG ENTRY", s["cellhd"])
    hd_lx = P("LONG EXIT", s["cellhd"])
    hd_se = P("SHORT ENTRY", s["cellhd"])
    hd_sx = P("SHORT EXIT", s["cellhd"])
    data = [
        [hd_le, hd_lx],
        [P(long_entry, s["cell"]), P(long_exit, s["cell"])],
        [hd_se, hd_sx],
        [P(short_entry, s["cell"]), P(short_exit, s["cell"])],
    ]
    col = 88 * mm
    row_h = None
    t = Table(data, colWidths=[col, col], repeatRows=0)
    t.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("BACKGROUND", (0, 0), (0, 0), LONG_HD),
                ("BACKGROUND", (1, 0), (1, 0), LONG_HD),
                ("BACKGROUND", (0, 1), (0, 1), LONG_BG),
                ("BACKGROUND", (1, 1), (1, 1), EXIT_BG),
                ("BACKGROUND", (0, 2), (0, 2), SHORT_HD),
                ("BACKGROUND", (1, 2), (1, 2), SHORT_HD),
                ("BACKGROUND", (0, 3), (0, 3), SHORT_BG),
                ("BACKGROUND", (1, 3), (1, 3), EXIT_BG),
            ]
        )
    )
    return t


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(16 * mm, 10 * mm, "cursor_backtest  v2.2.24  —  engine: volume_delta_hybrid")
    canvas.drawRightString(
        A4[0] - 16 * mm,
        10 * mm,
        f"Page {doc.page}",
    )
    canvas.restoreState()


def build():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    s = styles()
    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
        title="cursor_backtest v2.2.24 — Strategy entry & exit",
        author="cursor_backtest",
    )
    story = []

    story.append(P("Strategy settings — Entry &amp; Exit", s["cover"]))
    story.append(
        P(
            "Directional · Non-Directional · Pro · Pro-MTF<br/>"
            "Long Entry · Long Exit · Short Entry · Short Exit<br/>"
            "Source of truth: <font face='Courier'>backend/engine/volume_delta.py</font>  ·  v2.2.24",
            s["sub"],
        )
    )

    story.append(P("1. Shared rules (all four strategies)", s["h1"]))
    story.append(
        P(
            "<b>Aggressive candle (AGGR).</b> A completed bar whose volume-delta % "
            "meets the threshold: Buy AGGR when Δ% ≥ Thr%; Sell AGGR when Δ% ≤ −Thr%. "
            "AGGR is only formed when the bar open is inside the IST session window "
            "<b>After ≤ clock &lt; Before</b>.",
            s["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        P(
            "<b>Session.</b> New entries require the fill bar’s open inside After…Before. "
            "At <b>Flatten</b> time the open trade is closed market: <b>LTX</b> (long) / "
            "<b>STX</b> (short). Pending ORB / next-bar setups / reverse-at-open are cancelled "
            "so the next session cannot fill yesterday’s range.",
            s["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        P(
            "<b>Sides.</b> Long only / Short only / Both. A blocked reverse on a losing trade "
            "becomes a hard stop tag (LSL/SSL); a green reverse still tags LR/SR.",
            s["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(P("Shared exits (independent switches — not strategy-specific)", s["h2"]))
    shared = [
        ["Switch", "Long exit tag", "Short exit tag", "Fill"],
        [
            "Stoploss On",
            "LSL  (LB if BE already locked)",
            "SSL  (SB if BE already locked)",
            "Tick touches stop",
        ],
        ["Target On", "LT", "ST", "Tick touches target"],
        ["Trail On", "LSL / LB (ratcheted stop)", "SSL / SB", "Favourable tick ratchets stop"],
        ["BreakEven On", "LB after lock", "SB after lock", "Arm then lock = CTC × (slip+fee)/lots"],
        ["Flatten clock", "LTX", "STX", "IST time ≥ Flat"],
        ["Scale-in", "Not an exit", "Not an exit", "Same-side AGGR add (max 3) if green through cost BE"],
    ]
    st_rows = [[P(c, s["cell"] if r else s["cellhd"]) for c in row] for r, row in enumerate(shared)]
    st = Table(st_rows, colWidths=[32 * mm, 48 * mm, 48 * mm, 48 * mm])
    st.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.35, LINE),
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor("#f6f8fa")),
                ("BACKGROUND", (0, 3), (-1, 3), colors.HexColor("#f6f8fa")),
                ("BACKGROUND", (0, 5), (-1, 5), colors.HexColor("#f6f8fa")),
            ]
        )
    )
    story.append(st)
    story.append(Spacer(1, 3 * mm))
    story.append(
        P(
            "SL/TP distance uses the chosen unit (Range = AGGR range × RR, or tick / points / %). "
            "Trail and BE are independent of Stoploss/Target. Slip and fee apply to every fill "
            "(long entry +, exit −; short opposite). Tags: <b>LE/SE</b> first fill, "
            "<b>LR</b> = long reversed → new short, <b>SR</b> = short reversed → new long. "
            "Pro-MTF uses <b>LMTFX/SMTFX</b> instead of LR/SR.",
            s["body"],
        )
    )

    # --- Directional ---
    story.append(PageBreak())
    story.append(P("2. Directional  (baseline)", s["h1"]))
    story.append(
        P(
            "Wait = off, Pro = off, Pro-MTF = off. One-way AGGR: Buy → long only, Sell → short only. "
            "Fill at <b>next bar open</b>. Opposite AGGR <b>reverses at the next bar open</b> "
            "(not on the stop). Stop is a hard LSL/SSL.",
            s["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        quad(
            s,
            "<b>Signal</b> Buy AGGR (Δ% ≥ Thr%) while flat (or after a reverse).<br/>"
            "<b>Fill</b> Next bar open. Tag <b>LE</b> (or <b>SR</b> if this long was opened by reversing a short).<br/>"
            "<b>Stop / target</b> From that fill using SL/TP units (Range = this AGGR’s range × RR).<br/>"
            "<b>Gate</b> Session window + Long side allowed. Same-bar AGGR that created the setup is not skipped — fill is always the following bar’s open.",
            "<b>Reverse (primary)</b> Sell AGGR while long → close long at <b>next bar open</b>. Tag <b>LR</b>, then open short (if Short side allowed).<br/>"
            "<b>Hard stop</b> Tick ≤ stop → <b>LSL</b> (or <b>LB</b> if BE already locked). Does <b>not</b> reverse.<br/>"
            "<b>Target</b> Tick ≥ target → <b>LT</b>.<br/>"
            "<b>Flatten</b> <b>LTX</b>. No flip after flatten.<br/>"
            "If reverse is blocked and the open-fill would be a loss, tag becomes <b>LSL</b> instead of LR.",
            "<b>Signal</b> Sell AGGR (Δ% ≤ −Thr%) while flat (or after a reverse).<br/>"
            "<b>Fill</b> Next bar open. Tag <b>SE</b> (or <b>LR</b> if this short was opened by reversing a long).<br/>"
            "<b>Stop / target</b> From that fill (Range = this AGGR’s range × RR).<br/>"
            "<b>Gate</b> Session window + Short side allowed.",
            "<b>Reverse (primary)</b> Buy AGGR while short → close short at <b>next bar open</b>. Tag <b>SR</b>, then open long (if Long side allowed).<br/>"
            "<b>Hard stop</b> Tick ≥ stop → <b>SSL</b> (or <b>SB</b> if BE locked). Does <b>not</b> reverse.<br/>"
            "<b>Target</b> Tick ≤ target → <b>ST</b>.<br/>"
            "<b>Flatten</b> <b>STX</b>.<br/>"
            "Blocked reverse on a loss → <b>SSL</b> instead of SR.",
        )
    )
    story.append(Spacer(1, 4 * mm))
    story.append(
        P(
            "<b>Scale-in (optional).</b> Same-side AGGR while the trade is already open and green after entry fees, "
            "and the next-bar slipped fill is through cost BE → add one Vol lot (max 3). Original stop is kept. "
            "Opposite AGGR still reverses — never a scale the other way.",
            s["body"],
        )
    )

    # --- Non-Directional ---
    story.append(PageBreak())
    story.append(P("3. Non-Directional  (ORB + reverse)", s["h1"]))
    story.append(
        P(
            "Wait = on. Any AGGR (Buy or Sell) builds a <b>shared ORB range</b> (that candle’s high/low). "
            "First entry is a <b>crossover</b> of that range on a later bar (not next-bar open). "
            "Opposite AGGR reverse fills when price takes the opposite candle’s high/low — "
            "<b>not</b> when the stop is hit. Stop is hard LSL/SSL.",
            s["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        quad(
            s,
            "<b>First entry</b> After any AGGR, on a later bar: price crosses <b>above ORB high</b> "
            "(tick first-touch, else bar proxy: open below high and high ≥ ORB high). Tag <b>LE</b>.<br/>"
            "<b>Reverse entry</b> While short, a Buy AGGR arms flip at that AGGR’s <b>high</b>; "
            "tick ≥ high → close short <b>SR</b> and open long at that fill.<br/>"
            "<b>Optional re-entry</b> After LSL, if Re-entry On: long again if price returns to the prior raw entry.",
            "<b>Reverse</b> Sell AGGR while long arms flip at that AGGR’s <b>low</b>. "
            "Tick ≤ low → <b>LR</b> (close long, open short if allowed).<br/>"
            "<b>Hard stop</b> Tick ≤ stop → <b>LSL</b> / <b>LB</b>. No reverse on stop.<br/>"
            "<b>Target</b> Tick ≥ target → <b>LT</b>.<br/>"
            "<b>Flatten</b> <b>LTX</b>; pending ORB is cancelled.",
            "<b>First entry</b> After any AGGR, later bar: price crosses <b>below ORB low</b>. Tag <b>SE</b>.<br/>"
            "<b>Reverse entry</b> While long, a Sell AGGR arms flip at that AGGR’s <b>low</b>; "
            "tick ≤ low → <b>LR</b> and open short at that fill.<br/>"
            "<b>Optional re-entry</b> After SSL, if Re-entry On: short again if price returns to the prior raw entry.",
            "<b>Reverse</b> Buy AGGR while short arms flip at that AGGR’s <b>high</b>. "
            "Tick ≥ high → <b>SR</b> (close short, open long if allowed).<br/>"
            "<b>Hard stop</b> Tick ≥ stop → <b>SSL</b> / <b>SB</b>. No reverse on stop.<br/>"
            "<b>Target</b> Tick ≤ target → <b>ST</b>.<br/>"
            "<b>Flatten</b> <b>STX</b>.",
        )
    )
    story.append(Spacer(1, 4 * mm))
    story.append(
        P(
            "<b>Trail (Non-Dir only, when Trail On).</b> A new same-session AGGR can tighten the stop from the new AGGR "
            "extreme; the target stays fixed. Opposite AGGR still uses the H/L fill reverse above.",
            s["body"],
        )
    )

    # --- Pro ---
    story.append(PageBreak())
    story.append(P("4. Pro  (Lo / Sh / Se / Co + VWAP band)", s["h1"]))
    story.append(
        P(
            "Pro = on (Wait forced off). Same next-bar-open fills as Directional, but the AGGR must "
            "classify vs prior close (LTP) <b>and</b> the whole candle must sit outside VWAP ± Nσ "
            "(low &gt; VWAP+Nσ or high &lt; VWAP−Nσ). Wick-touch of the band does <b>not</b> qualify. "
            "N is 1, 2, or 3. Reverse is opposite <b>Pro tag</b> at next bar open (LR/SR). No ORB trail.",
            s["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    tags = [
        ["Tag", "Δ%", "vs prior close (LTP)", "Bias"],
        ["Lo", "+Δ ≥ Thr%", "High ≥ LTP", "Long (buy)"],
        ["Co", "−Δ ≤ −Thr%", "High ≥ LTP (and not Sh)", "Long (short-covering)"],
        ["Sh", "−Δ ≤ −Thr%", "Low ≤ LTP", "Short (sell)"],
        ["Se", "+Δ ≥ Thr%", "Low ≤ LTP (and not Lo)", "Short (long-liquidation)"],
    ]
    tg = Table(
        [[P(c, s["cell"] if r else s["cellhd"]) for c in row] for r, row in enumerate(tags)],
        colWidths=[22 * mm, 38 * mm, 62 * mm, 54 * mm],
    )
    tg.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.35, LINE),
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("BACKGROUND", (0, 1), (-1, 1), LONG_BG),
                ("BACKGROUND", (0, 2), (-1, 2), LONG_BG),
                ("BACKGROUND", (0, 3), (-1, 3), SHORT_BG),
                ("BACKGROUND", (0, 4), (-1, 4), SHORT_BG),
            ]
        )
    )
    story.append(tg)
    story.append(Spacer(1, 3 * mm))
    story.append(
        quad(
            s,
            "<b>Signal</b> AGGR tagged <b>Lo or Co</b>, VWAP qualifier true, while flat. "
            "AGGR during an open trade does <b>not</b> queue a new LE after the exit.<br/>"
            "<b>Fill</b> Next bar open. Tag <b>LE</b> / Pro tag (or <b>SR</b> if opened by reverse).<br/>"
            "<b>Stop / target</b> Same Range×RR (or unit) as Directional from that AGGR.",
            "<b>Reverse</b> Open long + new AGGR tagged <b>Sh or Se</b> (and VWAP ok) → "
            "close long at <b>next bar open</b>, tag <b>LR</b>, open short.<br/>"
            "<b>Hard stop / target / flatten</b> LSL (LB) / LT / LTX — same as Directional. "
            "Stop does not reverse.",
            "<b>Signal</b> AGGR tagged <b>Sh or Se</b>, VWAP qualifier true, while flat.<br/>"
            "<b>Fill</b> Next bar open. Tag <b>SE</b> (or <b>LR</b> if opened by reverse).<br/>"
            "Failed VWAP test → AGGR-SKIP-VWAPnS; no arm.",
            "<b>Reverse</b> Open short + new AGGR tagged <b>Lo or Co</b> → "
            "close short at <b>next bar open</b>, tag <b>SR</b>, open long.<br/>"
            "<b>Hard stop / target / flatten</b> SSL (SB) / ST / STX.",
        )
    )

    # --- Pro-MTF ---
    story.append(PageBreak())
    story.append(P("5. Pro-MTF  (HTF invalidator, both sides, no LR/SR)", s["h1"]))
    story.append(
        P(
            "Pro-MTF = on. Base TF must be <b>strictly greater</b> than chart TF. "
            "<b>No VWAP. No LR/SR reverse.</b> Higher-timeframe AGGR sets bias and an invalidator line "
            "at HTF <b>close</b>. Latest HTF AGGR always replaces the line. "
            "LTF trades <b>both sides of the current line</b> with a whole-candle test, fill at next bar open. "
            "Wick through the line does <b>not</b> exit and does not change HTF bias.",
            s["body"],
        )
    )
    story.append(Spacer(1, 3 * mm))
    htf = [
        ["HTF AGGR", "Bias", "Invalidator", "Active from"],
        ["Buy (Δ% ≥ Base Thr%)", "Bull", "That bar’s low", "HTF bar close (open + Base TF)"],
        ["Sell (Δ% ≤ −Base Thr%)", "Bear", "That bar’s high", "HTF bar close"],
    ]
    ht = Table(
        [[P(c, s["cell"] if r else s["cellhd"]) for c in row] for r, row in enumerate(htf)],
        colWidths=[44 * mm, 28 * mm, 42 * mm, 62 * mm],
    )
    ht.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.35, LINE),
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("BACKGROUND", (0, 1), (-1, 1), LONG_BG),
                ("BACKGROUND", (0, 2), (-1, 2), SHORT_BG),
            ]
        )
    )
    story.append(ht)
    story.append(Spacer(1, 3 * mm))
    story.append(
        quad(
            s,
            "<b>LTF signal</b> Buy AGGR on the chart TF <b>and</b> whole candle above the line "
            "(low &gt; invalidator). No HTF line yet → no arm.<br/>"
            "<b>Fill</b> Next bar open. Tag <b>LE</b> (never SR).<br/>"
            "If a short is open and this Buy AGGR is a legal other-side trade, the short is flattened "
            "first at this open (<b>SMTFX</b>) then the long is armed/filled per next-bar rules.",
            "<b>Opposite LTF AGGR</b> While long, a Sell AGGR whose whole candle is below the line "
            "→ flatten at <b>next bar open</b>, tag <b>LMTFX</b> (not LR). Then arm/fill short if valid.<br/>"
            "<b>New HTF AGGR</b> Always replaces the line. Long + new bull → keep, use new invalidator. "
            "Long + new bear → flatten <b>LMTFX</b> unless the original signal candle is still a legal "
            "other-side trade vs the new line.<br/>"
            "<b>Hard stop / target / flatten</b> LSL (LB) / LT / LTX.",
            "<b>LTF signal</b> Sell AGGR <b>and</b> whole candle below the line "
            "(high &lt; invalidator).<br/>"
            "<b>Fill</b> Next bar open. Tag <b>SE</b> (never LR).<br/>"
            "Open long + valid Sell AGGR → flatten <b>LMTFX</b> at next open, then short.",
            "<b>Opposite LTF AGGR</b> While short, a Buy AGGR whole-candle above the line "
            "→ flatten at next open, tag <b>SMTFX</b> (not SR), then arm/fill long.<br/>"
            "<b>New HTF AGGR</b> Short + new bear → keep. Short + new bull → flatten <b>SMTFX</b> "
            "unless the original signal candle is still legal vs the new line.<br/>"
            "<b>Hard stop / target / flatten</b> SSL (SB) / ST / STX.",
        )
    )
    story.append(Spacer(1, 4 * mm))
    story.append(
        P(
            "<b>Not used in Pro-MTF:</b> VWAP qualifier, Lo/Sh/Se/Co tags, LR/SR reverse, ORB. "
            "Scale-in still requires the add to remain a legal LTF trade vs the current invalidator.",
            s["body"],
        )
    )

    story.append(PageBreak())
    story.append(P("6. Tag cheat-sheet", s["h1"]))
    cheat = [
        ["Tag", "Meaning"],
        ["LE / SE", "Long / short entry (first fill of that side)"],
        ["LE+ / SE+", "Same trade after at least one scale-in add"],
        ["LR", "Long closed by reverse → new short (Dir / Non-Dir / Pro only)"],
        ["SR", "Short closed by reverse → new long (Dir / Non-Dir / Pro only)"],
        ["LSL / SSL", "Hard stop (loss). Does not reverse"],
        ["LB / SB", "Stop after BreakEven lock"],
        ["LT / ST", "Target"],
        ["LTX / STX", "Session flatten"],
        ["LMTFX / SMTFX", "Pro-MTF flatten (long / short) — then other side may arm; not a reverse tag"],
        ["TTS", "Time stop (minutes in trade) — currently unused in the UI"],
    ]
    ch = Table(
        [[P(c, s["cell"] if r else s["cellhd"]) for c in row] for r, row in enumerate(cheat)],
        colWidths=[42 * mm, 134 * mm],
    )
    ch.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.35, LINE),
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f6f8fa")]),
            ]
        )
    )
    story.append(ch)
    story.append(Spacer(1, 5 * mm))
    story.append(
        P(
            "This PDF matches the hybrid engine as of v2.2.24. UI labels: Strategy dropdown "
            "Directional / Non-Directional / Pro / Pro-MTF. Changing SL, TP, Trail, BE, Thr%, RR, "
            "session clocks, or Sides changes fills but not these four signal grammars.",
            s["tiny"],
        )
    )

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return OUT


if __name__ == "__main__":
    path = build()
    print(path)
    sys.exit(0)
