import type { Flag, FlagParams, FlagSeatRef, FlagShiftRef } from "../types";
import type { Lang } from "./i18n";
import { localDate } from "./dates";

// Hebrew rendering of the review flags (user decision 2026-07-02, reversing the earlier
// "flag prose stays English" rule): the backend ships each flag's machine-readable form
// (`msg` + `params`) alongside its authoritative English `title`/`detail`; here the
// STATIC sentence parts translate while every configurable value — role, project,
// employee and shift-type names — renders exactly as the user entered it. Dates
// localize ("שבת, 4 ביולי"). An unknown/missing msg falls back to the English text,
// so a new backend flag can never render blank.

// Bidi isolation (FSI…PDI) around every configured value: a Latin name like
// "QA · Apollo" embedded in a Hebrew sentence can otherwise visually reorder its
// punctuation. The marks are invisible; copy/paste keeps working.
const iso = (v: unknown) => `⁨${String(v)}⁩`;

function heDate(isoDate: string | undefined): string {
  if (!isoDate) return "";
  const d = localDate(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
}

function heShift(s: FlagShiftRef | undefined): string {
  if (!s) return "";
  return `${iso(s.name)} · ${heDate(s.date)}`;
}

function heSeat(s: FlagSeatRef | undefined): string {
  if (!s) return "";
  if (s.kind === "manager") return `אחראי משמרת · ${iso(s.team ?? "")}`;
  return `${iso(s.role ?? "")} · ${iso(s.project ?? "")}`;
}

const h1 = (n: number | undefined) => (n ?? 0).toFixed(1);

type Renderer = (p: FlagParams) => { title: string; detail: string };

const HE: Record<string, Renderer> = {
  r1_double_booked: (p) => ({
    title: `${p.employee} — שיבוץ כפול`,
    detail: `שיבוץ לשתי משמרות חופפות: ${heShift(p.shift_a)} וגם ${heShift(p.shift_b)}. ` +
      `אף אחד מהשיבוצים אינו נחשב מאויש.`,
  }),
  r2_no_day_off: (p) => ({
    title: `ל־${p.employee} אין יום חופש`,
    detail: `עבודה בכל ${p.days} ימי השבוע — נשברת חובת יום החופש השבועי.`,
  }),
  r8_six_days: (p) => ({
    title: `${p.employee} — שבוע של 6 ימי עבודה`,
    detail: `רק יום חופש אחד השבוע; יום החופש השני המועדף לא ניתן.`,
  }),
  r5_multi_per_day: (p) => ({
    title: `ל־${p.employee} יש ${p.count} משמרות ב${heDate(p.date)}`,
    detail: `יותר ממשמרת אחת באותו יום.`,
  }),
  r3_short_rest: (p) => ({
    title: `${p.employee} — מנוחה קצרה מדי`,
    detail: `רק ${h1(p.gap_h)} שעות בין ${heShift(p.shift_a)} לבין ${heShift(p.shift_b)} ` +
      `(המינימום החוקי: ${h1(p.min_h)} שעות).`,
  }),
  r6_night_recovery: (p) => ({
    title: `${p.employee} — התאוששות קצרה ממשמרת לילה`,
    detail: `רק ${h1(p.gap_h)} שעות אחרי משמרת הלילה ${heShift(p.shift)} ` +
      `(מומלץ: ${h1(p.rec_h)} שעות).`,
  }),
  r3_carry: (p) => ({
    title: `${p.employee} — מנוחה קצרה מדי מהשבוע שעבר`,
    detail: p.overlap
      ? `חפיפה עם המשמרת האחרונה של השבוע שעבר — אין מנוחה לפני ${heShift(p.shift)}.`
      : `רק ${h1(p.gap_h)} שעות בין המשמרת האחרונה של השבוע שעבר לבין ${heShift(p.shift)} ` +
        `(המינימום החוקי: ${h1(p.min_h)} שעות).`,
  }),
  r6_carry: (p) => ({
    title: `${p.employee} — התאוששות קצרה ממשמרת לילה של השבוע שעבר`,
    detail: p.overlap
      ? `חפיפה עם משמרת הלילה של השבוע שעבר — אין התאוששות לפני ${heShift(p.shift)}.`
      : `רק ${h1(p.gap_h)} שעות אחרי משמרת הלילה של השבוע שעבר לפני ${heShift(p.shift)} ` +
        `(מומלץ: ${h1(p.rec_h)} שעות).`,
  }),
  r7_second_weekend: (p) => ({
    title: `${p.employee} — סופ״ש שני ברצף`,
    detail: `שיבוץ למשמרת סופ״ש (${heShift(p.shift)}) אחרי עבודה בסופ״ש שעבר.`,
  }),
  r10_avoided: (p) => ({
    title: `${p.employee} במשמרת שביקש/ה להימנע ממנה`,
    detail: `${p.employee} העדיף/ה לא לעבוד ב־${heShift(p.shift)}.`,
  }),
  r11_nonpreferred: (p) => ({
    title: `${p.employee} בסוג משמרת לא מועדף`,
    detail: `${p.employee} שובץ/ה ל־${heShift(p.shift)} — סוג שאינו בין סוגי המשמרות ` +
      `המועדפים עליו/ה.`,
  }),
  exc_signoff: (p) => ({
    title: `${p.employee} — שיבוץ חריג`,
    detail: p.unavailable
      ? `${p.employee} אינו/ה זמין/ה ב${heDate(p.date)} אך שובץ/ה ל־${heSeat(p.seat)} — ` +
        `נדרש אישור.`
      : `${p.employee} מחוץ לזכאות הרגילה עבור ${heSeat(p.seat)} — נדרש אישור.`,
  }),
  r4_unfilled: (p) => ({
    title: `לא מאויש: ${heSeat(p.seat)}`,
    detail: `אין עובד זמין עבור ${heSeat(p.seat)} במשמרת ${heShift(p.shift)}.`,
  }),
  r9_imbalance: (p) => ({
    title: `חוסר איזון בעומס ב־${p.team}`,
    detail: `משמרות עומס (לילה/סופ״ש) אינן מחולקות באופן שווה ב־${p.team}: פער של ` +
      `${p.spread} בין העובד העמוס ביותר לעמוס הכי פחות (העמוס ביותר: ${p.top}).`,
  }),
};

export function flagText(f: Flag, lang: Lang): { title: string; detail: string } {
  if (lang === "he" && f.msg && f.params) {
    const render = HE[f.msg];
    if (render) {
      // A malformed/incomplete params object must never surface "undefined" in a
      // user-facing sentence — the English original is always a safe fallback.
      const out = render(f.params);
      if (!/undefined|NaN/.test(out.title + out.detail)) return out;
    }
  }
  return { title: f.title, detail: f.detail };
}
