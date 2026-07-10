# Project: shabbat-gate (npm package)

> Save this file as `CLAUDE.md` at the root of the new project folder. Claude Code auto-loads
> it as project instructions on every session start, so this replaces re-explaining context.

## First thing to check: this folder has the wrong scaffolding in it

The folder was created via `npm create astro@latest -- --template basics` (there's a default
Astro starter's `astro.config.mjs`, `src/pages/index.astro`, `src/components/Welcome.astro`,
`src/layouts/Layout.astro`, `public/favicon.svg`, a generic starter `README.md`, and this very
`CLAUDE.md` was itself the Astro starter's default boilerplate before being overwritten with this
file). **None of that is needed** - this project is a small reusable TypeScript *library*
(published to npm), not a website. There's nothing to deploy, no pages, no Astro.

First session action: remove the Astro-specific files (`astro.config.mjs`, `src/pages/`,
`src/components/`, `src/layouts/`, `public/favicon.svg`, `tsconfig.json` if it's Astro-flavored)
and the `astro`/related dependencies from `package.json`, then set up a clean minimal TypeScript
library `package.json` + `tsconfig.json` as described below. Also worth a quick look: there's an
unexplained `sefaria_jewish_library.log` file in the folder root - check what it is (probably
leftover from an unrelated experiment) before deciding whether to keep or delete it.

## Who's asking for this / why

Eyal Meshulam is building a small, open-source npm package that any Cloudflare Pages / Workers
site can use to automatically close itself to human visitors during Shabbat and major Jewish
holidays (Israel-observance rules), while always letting search engines and AI crawlers through
(so SEO is unaffected). He wants to publish it publicly on npm so other developers can use it
too - not just keep it private for his own sites.

The **first real-world consumer** will be `tehilagames.com` (a separate existing project, a kids'
Astro + Cloudflare Pages site owned by his daughter Tehila), but do not touch that project from
here - this session's job is to build and publish the standalone package. Integration into
tehilagames.com (and Eyal's other sites: bht.co.il, banksecrets.co.il, eyalmeshulam.com) is a
later, separate step.

## Language

**Always respond to the user in Hebrew**, in every conversation, regardless of what language
they write in. This applies to every project of theirs, not just this one - it's a standing
preference, not something specific to shabbat-gate. Code, comments, commit messages, and
technical identifiers stay in English as normal - only the actual back-and-forth conversation
with the user is in Hebrew.

## Environment - already set up, don't re-discover this

- **OS**: Windows 11. PowerShell is the primary shell tool; Bash (git-bash) is also available.
  Use whichever tool's native syntax matches the command.

- **Cloudflare** - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  (`9bf5104fb50208eb3337b151db8945ab`) are already set as **persistent Windows User environment
  variables** (set once, outside any project - they're not read from a `.env` file or repo
  config). Any *freshly-opened* terminal inherits them automatically, so `wrangler` and direct
  `curl` / `Invoke-RestMethod` calls to `api.cloudflare.com` just work with zero setup.
  - Verify a terminal has them: PowerShell `echo $env:CLOUDFLARE_API_TOKEN` (Bash:
    `echo $CLOUDFLARE_API_TOKEN`) - if empty, the terminal was opened before the vars were set on
    this machine; open a brand new terminal window and try again (don't try to set them yourself,
    they're already there machine-wide).
  - There's nothing further to "connect" - no login step, no `wrangler login` needed, the token
    is already how auth happens.
  - Not actually needed for *this* repo's core work (building/publishing the npm package has
    nothing to deploy to Cloudflare) - it only matters once a *consuming* site's Pages Function
    uses this package and gets deployed. Documented here anyway since it's project-independent
    context worth having on hand.

- **Git / GitHub** - the `gh` CLI is already authenticated in this environment; so is plain `git`
  (global `user.name`/`user.email` are already configured machine-wide - don't set them per-repo
  unless something looks wrong). Git user / GitHub account: Eyal Meshulam.
  - Verify: `gh auth status` (should show a logged-in account, no login flow needed).
  - This folder already has a `.git` init (see `ls -la` output from when the folder was first
    created) - check `git remote -v` before assuming there's no remote yet. If there's no remote,
    creating the GitHub repo and attaching it in one step is exactly what
    `gh repo create shabbat-gate --public --source=. --remote=origin --push` does (see Publishing
    steps below) - no separate manual "connect to GitHub" step needed beyond that command.
  - Normal commit workflow otherwise: `git add`, `git commit`, `git push` - nothing
    project-specific here beyond the usual care around not committing secrets/`node_modules`.

- **npm** - check whether `npm whoami` already returns a logged-in user. If not, Eyal needs an
  npmjs.com account (create one at https://www.npmjs.com/signup if he doesn't have one), then
  `npm login` (opens a browser auth flow, or prompts for username/password/OTP). This is the one
  piece of auth in this whole workflow that may genuinely not be set up yet - unlike Cloudflare
  and GitHub, there's no evidence an npm login already exists on this machine.

## What to build

A small TypeScript library, working name **`shabbat-gate`** (check availability first - see
Publishing steps below - fall back to a scoped name like `@eyalmeshulam/shabbat-gate` if the
plain name is taken).

### Public API (draft - refine as needed)

```ts
export interface ShabbatGateConfig {
  siteName: string;
  /** Decimal lat/long for zmanim. Both default to Jerusalem (31.7683, 35.2137) if omitted -
   *  that's a fine single reference point for all of Israel at this granularity (differences
   *  between cities are only a few minutes, irrelevant for "block the whole site or not"). */
  latitude?: number;
  longitude?: number;
  /** Query param name + required value that bypasses the gate entirely, for the site owner to
   *  preview/test on any day. Example: bypassParam:'preview', bypassValue:'letmein-<random>'.
   *  Keep the value non-guessable - this is a testing convenience, not real auth. */
  bypassParam?: string;
  bypassValue?: string;
  /** Optional custom holding-page renderer. If omitted, use a sensible default (Hebrew, mobile-
   *  responsive, shows siteName + when the site reopens). */
  renderHoldingPage?: (ctx: { siteName: string; reasonLabel: string; untilLabel: string }) => string;
}

/** Returns a Cloudflare Pages Functions-compatible handler. Usage in a consuming site's
 *  functions/_middleware.ts:
 *
 *    import { createShabbatGate } from 'shabbat-gate';
 *    const gate = createShabbatGate({ siteName: 'tehila·games' });
 *    export const onRequest: PagesFunction = (context) => gate(context);
 */
export function createShabbatGate(config: ShabbatGateConfig): PagesFunction;
```

### Core logic

1. **Bot allowlist (check first, before anything else)** - match `request.headers.get('user-agent')`
   against a broad case-insensitive regex and let matches through unconditionally, no gate logic
   runs at all for them:

   ```
   /bot|crawl|spider|slurp|googlebot|google-inspectiontool|adsbot-google|bingbot|duckduckbot|
   baiduspider|yandex|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|
   discordbot|applebot|gptbot|chatgpt-user|oai-searchbot|ccbot|claudebot|claude-web|
   anthropic-ai|perplexitybot|google-extended|bytespider|semrushbot|ahrefsbot|mj12bot|petalbot/i
   ```

   (Feel free to extend this list - erring toward "let more things through" is the safe
   direction, since the whole point is protecting SEO/crawlability.)

2. **Bypass check** - if `config.bypassParam` is set and the request URL's query string has that
   param equal to `config.bypassValue`, skip the gate (let the real site through). Useful for the
   site owner to test/preview without waiting for an actual Friday evening.

3. **Time windows to block** - fetch (with caching, see below) two lists from Hebcal's free public
   JSON API (no key required) and merge them:

   - **Shabbat candle-lighting/havdalah**:
     `https://www.hebcal.com/shabbat?cfg=json&latitude={lat}&longitude={lon}&tzid=Asia/Jerusalem&M=on&start={ISO}&end={ISO}`
     → `items[]` entries with `category:"candles"` (start) and `category:"havdalah"` (end), in
     chronological order.

   - **Major holidays, Israel single-day Yom Tov mode, with their own candle-lighting/havdalah**:
     `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=off&mod=off&nx=off&mf=off&ss=off&c=on&i=on&geonameid=281184&start={ISO}&end={ISO}`
     - `i=on` is **critical** - without it you get diaspora 2-day Yom Tov reckoning, which is
       wrong for an Israel-facing gate.
     - `c=on` is **critical** - it's what makes the response include `category:"candles"` /
       `category:"havdalah"` entries attached to the holidays, not just bare calendar dates.
     - `maj=on` + everything else `off` = only real work-restricted Yom Tov days (Rosh Hashana,
       Yom Kippur, Sukkot I, Shmini Atzeret/Simchat Torah, Pesach I, Pesach VII, Shavuot) -
       explicitly excludes Chol HaMoed (intermediate) days, minor holidays (Chanukah, Purim, Tu
       BiShvat...), fast days, Rosh Chodesh, and "modern" days (Yom HaAtzma'ut etc.) - none of
       those carry work restrictions, so the site should stay open on them.
     - `geonameid=281184` = Jerusalem. (Verified live during planning - this exact query shape
       works and returns candle-lighting entries correctly attached to holiday dates.)

   - **Pairing algorithm (important correctness detail)**: multi-day holidays like Rosh Hashana
     emit TWO `candles` events (one per evening) but only ONE `havdalah` at the very end - do
     **not** naively pair every `candles` with the next `havdalah` 1:1. Instead: when you see a
     `candles` event and no window is currently open, open one (record its time as `start`).
     Ignore any further `candles` events while a window is already open. When you see a
     `havdalah` event and a window is open, close it (record `end`), then reset. This correctly
     produces one continuous `[start, end]` window spanning the whole multi-day holiday with no
     false gap in the middle.

   - Merge the Shabbat windows and holiday windows into one flat list of
     `{ start: number; end: number; label: string }` (epoch ms + a human label like "שבת" or the
     holiday's Hebrew title from the API response).

4. **Caching** - use Cloudflare's built-in `caches.default` (the standard Cache API, no KV
   binding needed) to store the merged window list for ~24h, keyed by a fixed internal cache-key
   `Request` (e.g. `new Request('https://internal.cache/shabbat-gate-windows-v1')`). Fetch a
   window ~45 days into the future each time so the cache rarely needs a cold refetch. This keeps
   the middleware fast and avoids hammering Hebcal's free API on every page load.

5. **Decision** - `now = Date.now()`. If `now` falls inside any cached window
   (`start <= now < end`), serve the holding page (HTTP 200, custom HTML from
   `config.renderHoldingPage` or the default). Otherwise call `next()` to let the real site through.

6. **Fail open, always** - wrap the fetch + cache logic in try/catch. On *any* error (network
   failure, bad JSON, unexpected shape, whatever), log it and fall through to `next()`. An
   accidental block on a regular Tuesday is a real, visible bug; an occasional missed block during
   an error is a minor, invisible one. Availability wins ties.

### Default holding page

Simple, centered, mobile-responsive HTML/CSS (inline, no external assets - this is a Workers
response, not a build step). Hebrew by default. Show `siteName`, something like "האתר סגור לכבוד
{שבת/החג}, ניפגש שוב אחרי ה{הבדלה/חג}" and (nice-to-have) the actual local end time formatted for
Asia/Jerusalem.

## Package structure

```
shabbat-gate/
  src/
    index.ts          # createShabbatGate + types, the whole public API
    botPattern.ts      # the bot-detection regex (its own file = easy to extend/test)
    hebcal.ts           # fetchWindows(lat, lon) -> Window[], the pairing algorithm
    holdingPage.ts       # default renderHoldingPage
  package.json
  tsconfig.json
  README.md            # install, config options, usage example, license
  LICENSE              # MIT is the natural choice for a small open-source utility
```

Compile TypeScript to a `dist/` folder (a simple `tsc` build is enough for a library this small -
no bundler needed; target ESM since Cloudflare Workers is ESM-native). `package.json` should
have `"type": "module"`, `"main"`/`"types"` pointing into `dist/`, and a `"files"` field limiting
what actually gets published (just `dist/` + `README.md` + `LICENSE`).

## Publishing steps

1. `npm init -y`, then hand-edit `package.json` (name, version `0.1.0`, description, keywords
   like `cloudflare-pages`, `shabbat`, `jewish-holidays`, license `MIT`, repository field once the
   GitHub repo exists).
2. Check the name is free: `npm view shabbat-gate` - a 404/"not found" error means it's available.
   If taken, use a scoped name: `@eyalmeshulam/shabbat-gate` (scoped packages are always
   available under your own npm username/org and can still be published `--access public`).
3. Write the source (see structure above), `npm run build` (add a `build` script wrapping `tsc`).
4. `npm login` if `npm whoami` doesn't already show a user.
5. `npm publish` (add `--access public` if using a scoped name - unscoped public publish doesn't
   need the flag but it doesn't hurt to always include it).
6. Create the GitHub repo and push: `gh repo create shabbat-gate --public --source=. --remote=origin --push`.
   Write a clear README - since this is going out to strangers, include: what it does, why
   (`i=on` Israel-mode explanation, bot-allowlist rationale for SEO), install command, a full
   config example, and a note that it fails open on errors.

## Testing before publishing

- `wrangler pages dev` can run a local Pages+Functions dev server to exercise the middleware
  against real HTTP requests without deploying anywhere.
- Test cases to actually run through:
  - A request with a Googlebot/GPTBot-style User-Agent gets the real site regardless of what time
    it is.
  - The bypass query param works (real site shown) and an absent/wrong bypass value doesn't.
  - Extract the window-finding logic as a pure function `isBlocked(windows, now)` so it can be
    unit-tested directly with hand-built window lists and injected `now` values, without needing
    to wait for an actual Friday evening or mock global `Date`.
  - Simulate a Hebcal fetch failure (e.g. temporarily point at a bad URL, or throw inside a test
    double) and confirm the result is "let the request through," not an error page.

## Later (not this session's job, just context)

Once published, integrating into `tehilagames.com` means: `npm install shabbat-gate` there, add
a `functions/_middleware.ts` calling `createShabbatGate({...})`, test with the bypass param on
the live preview URL, then deploy for real. That's a separate task in that project's own session.
