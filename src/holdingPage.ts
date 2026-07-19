import type { SecondaryMessage } from './translations.js';

export type { SecondaryMessage } from './translations.js';

export interface HoldingPageContext {
  siteName: string;
  reasonLabel: string;
  closingLabel: string;
  untilLabel: string;
  /** Optional localized message shown below the Hebrew one (with a blank-line
   *  gap), for a visitor outside Israel, in their own browser language. Absent
   *  for visitors in Israel, Hebrew-speaking visitors, or when the visitor's
   *  location is unknown. */
  secondary?: SecondaryMessage;
}

/** Minimal HTML-escaping for text interpolated into the page. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderSecondary(secondary: SecondaryMessage | undefined): string {
  if (!secondary) {
    return '';
  }
  const lines = secondary.lines.map((line) => `    <p>${escapeHtml(line)}</p>`).join('\n');
  return `
    <div class="secondary" dir="${secondary.dir}">
${lines}
    </div>`;
}

/** Simple, centered, mobile-responsive holding page. Inline CSS only, no external assets. */
export function defaultRenderHoldingPage(ctx: HoldingPageContext): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(ctx.siteName)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0f2138;
    color: #f3efe4;
    text-align: center;
    padding: 24px;
  }
  .card { max-width: 480px; }
  h1 { font-size: 1.5rem; margin: 0 0 12px; }
  p { font-size: 1rem; line-height: 1.6; color: #c8a951; margin: 0 0 8px; }
  .until { font-size: 0.9rem; color: #9fb0c4; }
  /* The requested two blank lines of separation before the localized block. */
  .secondary { margin-top: 3rem; }
  .secondary p { font-size: 0.95rem; color: #d9d2c2; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(ctx.siteName)}</h1>
    <p>האתר סגור לכבוד ${escapeHtml(ctx.reasonLabel)}, ניפגש שוב אחרי צאת ${escapeHtml(ctx.closingLabel)}.</p>
    <p class="until">שעת פתיחה משוערת: ${escapeHtml(ctx.untilLabel)}</p>${renderSecondary(ctx.secondary)}
  </div>
</body>
</html>`;
}
