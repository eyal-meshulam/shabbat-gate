/**
 * Broad, case-insensitive allowlist for search engine and AI crawlers.
 * Matches let a request through unconditionally, before any gate logic runs.
 * Erring toward "let more things through" is the safe direction for organic/AI
 * crawlers, since the whole point of this list is protecting SEO/crawlability.
 */
export const BOT_PATTERN =
  /bot|crawl|spider|slurp|googlebot|google-inspectiontool|bingbot|duckduckbot|baiduspider|yandex|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|applebot|gptbot|chatgpt-user|oai-searchbot|ccbot|claudebot|claude-web|anthropic-ai|perplexitybot|google-extended|bytespider|semrushbot|ahrefsbot|mj12bot|petalbot/i;

/**
 * Dedicated ad/shopping-network verification crawlers are deliberately NOT
 * allowed through the gate, even though their user agents also match the
 * generic `bot` term above (e.g. "AdsBot-Google" and "Storebot-Google" both
 * contain the substring "bot", "adidxbot" ends in it) - excluding them from
 * BOT_PATTERN's alternation alone would do nothing, since that bare substring
 * still matches.
 *
 * Unlike organic/AI indexing crawlers, these bots exist specifically to
 * verify that a live ad or shopping listing's destination page matches what a
 * human clicking it sees - Google Ads, Google Merchant Center/Shopping, and
 * Microsoft Advertising all require exactly that. Letting one bypass the gate
 * means it sees the real site during a closure window while a human visitor
 * sees the holding page - a textbook cloaking pattern, and the exact
 * violation Google's policy team cited when it suspended a consumer's Ads +
 * Merchant Center accounts over this (2026-08-29).
 *
 * - `adsbot-google` - AdsBot-Google / AdsBot-Google-Mobile, verifies Google
 *   Ads landing pages.
 * - `storebot-google` - verifies Google Shopping / Merchant Center product
 *   landing pages against the submitted feed.
 * - `adidxbot` - Microsoft Advertising's (Bing Ads) equivalent landing-page
 *   verification crawler.
 */
const AD_VERIFICATION_BOT_PATTERN = /adsbot-google|storebot-google|adidxbot/i;

export function isBot(userAgent: string): boolean {
  if (AD_VERIFICATION_BOT_PATTERN.test(userAgent)) return false;
  return BOT_PATTERN.test(userAgent);
}
