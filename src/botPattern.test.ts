import { describe, expect, it } from 'vitest';
import { isBot } from './botPattern.js';

describe('isBot', () => {
  it('matches common search engine and AI crawler user agents', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
    expect(isBot('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe(true);
    expect(isBot('GPTBot/1.0')).toBe(true);
    expect(isBot('ClaudeBot/1.0')).toBe(true);
    expect(isBot('facebookexternalhit/1.1')).toBe(true);
  });

  it('does not match a regular browser user agent', () => {
    expect(
      isBot(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
    ).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isBot('GOOGLEBOT')).toBe(true);
  });

  it('does not match dedicated ad/shopping-network landing-page verification bots', () => {
    // Regression test: these UAs all contain the substring "bot" (AdsBot,
    // Storebot, adidxbot), so they still match the generic /bot/i alternative
    // even after removing an explicit term from BOT_PATTERN's alternation.
    // Letting one of these bypass the gate is cloaking under Google Ads /
    // Merchant Center / Microsoft Advertising policy - each must see the
    // holding page exactly like a human visitor does.
    expect(isBot('AdsBot-Google (+http://www.google.com/adsbot.html)')).toBe(false);
    expect(isBot('AdsBot-Google-Mobile (+http://www.google.com/mobile/adsbot.html)')).toBe(false);
    expect(
      isBot(
        'Mozilla/5.0 (X11; Linux x86_64; Storebot-Google/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(isBot('Mozilla/5.0 (compatible; adidxbot/2.0; +http://www.bing.com/bingbot.htm)')).toBe(false);
  });
});
