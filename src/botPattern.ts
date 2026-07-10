/**
 * Broad, case-insensitive allowlist for search engine and AI crawlers.
 * Matches let a request through unconditionally, before any gate logic runs.
 * Erring toward "let more things through" is the safe direction here, since
 * the whole point of this list is protecting SEO/crawlability.
 */
export const BOT_PATTERN =
  /bot|crawl|spider|slurp|googlebot|google-inspectiontool|adsbot-google|bingbot|duckduckbot|baiduspider|yandex|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|applebot|gptbot|chatgpt-user|oai-searchbot|ccbot|claudebot|claude-web|anthropic-ai|perplexitybot|google-extended|bytespider|semrushbot|ahrefsbot|mj12bot|petalbot/i;

export function isBot(userAgent: string): boolean {
  return BOT_PATTERN.test(userAgent);
}
