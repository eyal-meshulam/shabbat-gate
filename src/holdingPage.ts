export interface HoldingPageContext {
  siteName: string;
  reasonLabel: string;
  untilLabel: string;
}

/** Simple, centered, mobile-responsive holding page. Inline CSS only, no external assets. */
export function defaultRenderHoldingPage(ctx: HoldingPageContext): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${ctx.siteName}</title>
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
</style>
</head>
<body>
  <div class="card">
    <h1>${ctx.siteName}</h1>
    <p>האתר סגור לכבוד ${ctx.reasonLabel}, ניפגש שוב אחרי הצאת ${ctx.reasonLabel}.</p>
    <p class="until">שעת פתיחה משוערת: ${ctx.untilLabel}</p>
  </div>
</body>
</html>`;
}
