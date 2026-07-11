# shabbat-gate

Middleware ל-Cloudflare Pages / Workers שסוגר אתר לגולשים אנושיים בזמן שבת וחגי ישראל
המרכזיים (לפי כללי שמירת שבת בישראל) - תוך מתן גישה תמידית למנועי חיפוש ולסורקי AI, כך
שה-SEO לא נפגע.

[English README](README.md)

## למה זה עובד ככה

- **יום טוב חד-יומי לפי ישראל, לא ספירת חו"ל.** לוח החגים נשלף מה-API החינמי של Hebcal
  עם הפרמטר `i=on`, שקריטי - בלעדיו מתקבלת ספירת חו"ל (יום חסימה מיותר) במקום יום טוב
  חד-יומי, כפי שנהוג בישראל.
- **בוטים תמיד עוברים.** רשימת אלוול רחבה, לא תלוית רישיות, של user-agent (Googlebot,
  Bingbot, GPTBot, ClaudeBot ורבים נוספים) נבדקת ראשונה, לפני כל שאר הלוגיקה. השער משפיע
  רק על גולשים אנושיים - סורקים ומנועי אינדוקס רואים את האתר האמיתי 24/7, כך שדירוג
  וניראות ב-AI-search לא נפגעים מכך שהאתר "סגור".
- **נכשל פתוח (Fail open).** כל שגיאה (תקלת רשת, תשובת API לא תקינה, מה שלא יהיה) גורמת
  למעבר לאתר האמיתי במקום הצגת דף שגיאה. חסימה בטעות ביום שלישי רגיל היא באג אמיתי וגלוי;
  אי-חסימה נדירה בזמן שגיאה היא תקלה קטנה ובלתי נראית.

## התקנה

```sh
npm install shabbat-gate
```

## שימוש

בפרויקט Cloudflare Pages, מוסיפים קובץ `functions/_middleware.ts`:

```ts
import { createShabbatGate } from 'shabbat-gate';

const gate = createShabbatGate({ siteName: 'שם האתר שלי' });

export const onRequest: PagesFunction = (context) => gate(context);
```

### שימוש עם Worker רגיל + assets binding (לא Pages)

`createShabbatGate` מחזירה handler בצורה של Pages Functions (`(context) => Response`), וזה
לא מתאים ל-signature של `fetch(request, env)` של Worker רגיל (אין `next()`). במקום זאת יש
להשתמש ב-`createShabbatGateForWorker` - היא מחזירה `null` כשצריך לתת לאתר האמיתי לעבור, ו-
`Response` כשצריך להציג את דף ה"סגור":

```ts
import { createShabbatGateForWorker } from 'shabbat-gate';

const gate = createShabbatGateForWorker({ siteName: 'שם האתר שלי' });

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }) {
    const blocked = await gate(request);
    return blocked ?? env.ASSETS.fetch(request);
  },
};
```

**מוקש שמבטל את כל השער בשקט:** Cloudflare Worker עם `assets` binding מגיש כל בקשה שתואמת
קובץ בתיקיית ה-assets **ישירות**, בלי להריץ בכלל את ה-`fetch` handler של ה-Worker - אלא אם
מגדירים `run_worker_first: true`. בלי זה, קוד השער רץ ונראה מחובר נכון, הבדיקות עוברות, אבל
בקשות אמיתיות לעמודים (שכמעט תמיד תואמות קובץ סטטי) אף פעם לא מגיעות אליו, אז האתר בפועל
אף פעם לא נסגר. ב-`wrangler.jsonc`:

```jsonc
{
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": true
  }
}
```

## קונפיגורציה

```ts
export interface ShabbatGateConfig {
  siteName: string;

  /** קווי אורך/רוחב עשרוניים לחישוב זמנים. ברירת מחדל לשניהם היא ירושלים (31.7683,
   *  35.2137) אם לא סופקו - נקודת ייחוס טובה לכל ישראל ברזולוציה הזו. */
  latitude?: number;
  longitude?: number;

  /** שם פרמטר + ערך נדרש ב-query string שעוקפים את השער לגמרי, כדי שבעל האתר יוכל
   *  לבדוק/לתצוגה מקדימה בכל יום. חשוב לבחור ערך שלא ניתן לניחוש - זו נוחות לבדיקות,
   *  לא הרשאה אמיתית. */
  bypassParam?: string;
  bypassValue?: string;

  /** פונקציית רינדור מותאמת אישית לדף ה"סגור", אופציונלית. ברירת המחדל היא דף בעברית,
   *  רספונסיבי למובייל, שמציג את שם האתר ומתי הוא ייפתח מחדש. `reasonLabel` ו-`closingLabel`
   *  שונים דקדוקית עבור שבת רגילה ("שבת קודש" בפתיחה מול "השבת" בסגירה) - יש להשתמש
   *  ב-`closingLabel` עבור "ניפגש שוב אחרי ___", לא לחזור על `reasonLabel`. */
  renderHoldingPage?: (ctx: {
    siteName: string;
    reasonLabel: string;
    closingLabel: string;
    untilLabel: string;
  }) => string;

  /** דקות לסגור את האתר *לפני* הדלקת נרות ולפתוח אותו *אחרי* הבדלה, מעל החלון הגולמי
   *  מ-Hebcal. ברירת מחדל: 0. שימושי כרפידת בטחון מול סחיפת שעון / גלישה של הרגע
   *  האחרון בדיוק בגבול החלון. */
  bufferMinutes?: number;
}
```

דוגמה מלאה:

```ts
import { createShabbatGate } from 'shabbat-gate';

const gate = createShabbatGate({
  siteName: 'tehila·games',
  latitude: 31.7683,
  longitude: 35.2137,
  bypassParam: 'preview',
  bypassValue: 'letmein-9f3a7c',
  bufferMinutes: 10,
});

export const onRequest: PagesFunction = (context) => gate(context);
```

## איך זה עובד

1. בדיקת בוט (regex אלוול על header ה-`user-agent`) - התאמה עוברת ישירות.
2. בדיקת bypass - אם פרמטר ה-query וערכו תואמים, עוברים ישירות.
3. שליפה (עם caching לכ-24 שעות דרך Workers Cache API) של רשימת חלונות שבת וחגים
   מאוחדת מ-Hebcal, כ-45 יום קדימה - קריאה אחת ל-endpoint `/hebcal` (`ss=on` לשבתות
   שבועיות + `maj=on` לחגים מרכזיים), עם `latitude`/`longitude` מועברים ישירות, כך שכל
   חלון מחושב נכון למיקום שהוגדר, לא רק החלון הקרוב ביותר.
4. אם הוגדר `bufferMinutes`, הוא מוחל מעל החלונות שנשלפו לפני בדיקת הזמן.
5. אם הזמן הנוכחי נופל בתוך חלון, מוצג דף ה"סגור" (HTTP 200). אחרת, האתר האמיתי עובר.
6. כל שגיאה בדרך גורמת למעבר לאתר האמיתי.

## מפתח קאש פנימי

רשימת החלונות המאוחדת נשמרת בקאש תחת מפתח פנימי קבוע
(`https://internal.cache/shabbat-gate-windows-v1`, מיוצא בשם `INTERNAL_CACHE_KEY_URL`) לכ-24
שעות דרך Workers Cache API. אם הקוד שלכם עושה caching משלו לנתונים נגזרים (למשל חלונות עם
buffer משלכם), כדאי להשתמש במפתח אחר - שימוש חוזר במפתח הזה יגרום בשקט להחזרת נתונים ישנים
ולא-מעובדים למשך עד 24 שעות.

## היסטוריית שינויים

ב-[CHANGELOG.md](CHANGELOG.md) (באנגלית) מתועד מה השתנה בכל גרסה, כולל הסבר לשורש כל
באג שתוקן.

## רישיון

MIT
