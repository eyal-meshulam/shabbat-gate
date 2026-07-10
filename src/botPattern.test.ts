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
});
