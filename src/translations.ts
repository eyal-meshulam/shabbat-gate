/**
 * Localized secondary holding-page messages, shown *below* the Hebrew message
 * to a visitor physically outside Israel, in their own browser language.
 *
 * Deliberately generic: each pack only distinguishes "Shabbat" from "a Jewish
 * holiday" and states the approximate reopen time - it never tries to name the
 * specific holiday (Shmini Atzeret, Shavuot, ...), since reliably translating
 * every occasion name into every language is out of scope. The exact occasion
 * name stays on the Hebrew line only.
 */

export type SupportedLanguage = 'en' | 'fr' | 'ru' | 'es' | 'de' | 'ar';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['en', 'fr', 'ru', 'es', 'de', 'ar'];

interface LanguagePack {
  dir: 'ltr' | 'rtl';
  /** "This site is closed in observance of Shabbat." */
  shabbat: string;
  /** "This site is closed in observance of a Jewish holiday." */
  holiday: string;
  /** "We'll be back after nightfall, around {time}." */
  until: (time: string) => string;
}

const PACKS: Record<SupportedLanguage, LanguagePack> = {
  en: {
    dir: 'ltr',
    shabbat: 'This site is closed in observance of Shabbat.',
    holiday: 'This site is closed in observance of a Jewish holiday.',
    until: (time) => `We'll be back after nightfall, around ${time}.`,
  },
  fr: {
    dir: 'ltr',
    shabbat: 'Ce site est fermé en observance du Chabbat.',
    holiday: 'Ce site est fermé en observance d’une fête juive.',
    until: (time) => `Nous serons de retour après la tombée de la nuit, vers ${time}.`,
  },
  ru: {
    dir: 'ltr',
    shabbat: 'Этот сайт закрыт в честь субботы (Шаббата).',
    holiday: 'Этот сайт закрыт в честь еврейского праздника.',
    until: (time) => `Мы вернёмся после наступления темноты, примерно в ${time}.`,
  },
  es: {
    dir: 'ltr',
    shabbat: 'Este sitio está cerrado en observancia del Shabat.',
    holiday: 'Este sitio está cerrado en observancia de una festividad judía.',
    until: (time) => `Volveremos después del anochecer, alrededor de las ${time}.`,
  },
  de: {
    dir: 'ltr',
    shabbat: 'Diese Website ist zu Ehren des Schabbat geschlossen.',
    holiday: 'Diese Website ist zu Ehren eines jüdischen Feiertags geschlossen.',
    until: (time) => `Wir sind nach Einbruch der Nacht wieder da, gegen ${time}.`,
  },
  ar: {
    dir: 'rtl',
    shabbat: 'هذا الموقع مغلق احترامًا ليوم السبت (شابات).',
    holiday: 'هذا الموقع مغلق احترامًا لعيد يهودي.',
    until: (time) => `سنعود بعد حلول الظلام، حوالي ${time}.`,
  },
};

/**
 * Picks the visitor's display language from an `Accept-Language` header value.
 * Walks the header's tags in the browser's stated order and returns the first
 * one we have a pack for. Returns `'he'` (a signal to skip the second block
 * entirely) if Hebrew is the visitor's top preference - they already read the
 * Hebrew message, a translated copy would be redundant. Falls back to `'en'`
 * when nothing matches.
 */
export function resolveVisitorLanguage(acceptLanguage: string): SupportedLanguage | 'he' {
  const tags = acceptLanguage
    .split(',')
    .map((part) => part.trim().split(';')[0].toLowerCase())
    .filter(Boolean);

  for (const tag of tags) {
    const primary = tag.split('-')[0];
    if (primary === 'he' || primary === 'iw') {
      return 'he';
    }
    if ((SUPPORTED_LANGUAGES as readonly string[]).includes(primary)) {
      return primary as SupportedLanguage;
    }
  }

  return 'en';
}

export interface SecondaryMessage {
  /** Text direction for the localized block (all current packs are `ltr`). */
  dir: 'ltr' | 'rtl';
  /** Localized lines to render, in order: [closed-reason, reopen-time]. */
  lines: string[];
}

/** Builds the localized two-line block for a given language + occasion. */
export function buildSecondaryMessage(
  language: SupportedLanguage,
  isShabbat: boolean,
  untilTime: string,
): SecondaryMessage {
  const pack = PACKS[language];
  return {
    dir: pack.dir,
    lines: [isShabbat ? pack.shabbat : pack.holiday, pack.until(untilTime)],
  };
}
