/*
  Sky TTLR — Custom Code (behavior)
  Prepared by MakeBuild

  Requires interact.js to be loaded separately before this file for the
  drag & drop quiz section — see README for the required <script> tag.
*/

// Memberstack's own <script> tag (loaded separately in Webflow, per README) sets
// window.$memberstackDom, but there's no guarantee it's already set by the time our
// Webflow.push callbacks run — a one-shot `if (!window.$memberstackDom) return`
// silently and permanently no-ops for that whole page load if it loses that race.
// This polls briefly instead of assuming either order.
function waitForMemberstack(timeoutMs = 5000) {
  if (window.$memberstackDom) {
    console.log('[ttlr] waitForMemberstack: already available');
    return Promise.resolve(window.$memberstackDom);
  }
  console.log('[ttlr] waitForMemberstack: not yet available, polling…');
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = window.setInterval(() => {
      if (window.$memberstackDom) {
        window.clearInterval(interval);
        console.log('[ttlr] waitForMemberstack: became available after ' + (Date.now() - start) + 'ms');
        resolve(window.$memberstackDom);
      } else if (Date.now() - start > timeoutMs) {
        window.clearInterval(interval);
        console.error('[ttlr] Memberstack was not available after ' + timeoutMs + 'ms — is its <script> tag present and loading?');
        resolve(null);
      }
    }, 100);
  });
}

// This site's compiled Webflow runtime (timetolearn.schunk...js) re-invokes
// already-registered Webflow.push callbacks more than once per page (an
// app-shell/route-transition re-render pattern, not a bug on our end) —
// confirmed 2026-08-27 via a live stack trace showing it calling back into
// initSeriesSwiper a second time on an element already carrying
// .swiper-initialized, which crashed inside Swiper's own internals
// (getComputedStyle on a non-Element). Without this wrapper, an uncaught
// throw in one feature's callback silently prevented every OTHER
// Webflow.push callback registered after it from ever running on that pass
// — which is why the series card badges and series count label (registered
// after the swiper) never even logged their "found N" line. Every ttlr
// Webflow.push callback goes through this now so one feature's failure
// can never cascade into another's.
function ttlrReady(label, fn) {
  window.Webflow ||= [];
  window.Webflow.push(function () {
    try {
      fn();
    } catch (err) {
      console.error('[ttlr] ' + label + ': uncaught error — other ttlr features are unaffected', err);
    }
  });
}

/* ---- Episode router: one visible episode at a time, Prev/Next
   navigation, completion tracking in Memberstack. ---- */

ttlrReady('episode router', function () {
  const lists = document.querySelectorAll('.ttlr_episode_cms_list');
  console.log('[ttlr] episode router: found ' + lists.length + ' .ttlr_episode_cms_list element(s) on this page');
  lists.forEach(initEpisodeRouter);
});

function initEpisodeRouter(listEl) {
  const items = Array.from(listEl.querySelectorAll('.ttlr_episode_cms_item'));
  console.log('[ttlr] initEpisodeRouter: found ' + items.length + ' .ttlr_episode_cms_item inside this list', listEl);
  if (!items.length) {
    console.warn('[ttlr] initEpisodeRouter: bailing out, no .ttlr_episode_cms_item found — nothing in this section (episode paging, bookmarks, progress bar) will run.');
    return;
  }

  let currentIndex = 0;
  let hasShownOnce = false; // first show() is an instant cut, not a crossfade — nothing to fade from yet

  function numberOf(item) {
    const span = item.querySelector('.ttlr_episode_col_left-number');
    return span ? span.textContent.trim() : null;
  }

  const warnedMissingEpisodeId = new Set();
  function idOf(item, index) {
    if (item.dataset.episodeId) return item.dataset.episodeId;
    if (!warnedMissingEpisodeId.has(index)) {
      warnedMissingEpisodeId.add(index);
      console.warn(
        '[ttlr] .ttlr_episode_cms_item is missing data-episode-id — falling back to a ' +
        'page+number key. Add data-episode-id in Designer (Item ID, or Slug as a fallback) ' +
        'so completion survives independently of the visible episode number.'
      );
    }
    return `${window.location.pathname}#${numberOf(item) || index}`;
  }

  // ---- Series ID: required for series-level completion (drives the badge) ----
  // Every episode on this page belongs to the SAME series — this page IS
  // that series' own CMS template page — so the series ID only needs to be
  // read once, from a Custom Attribute on the list wrapper itself or an
  // ancestor of it, not per-episode. Bind data-series-id to the current
  // Series item's own Item ID (or Slug) via Designer's Custom Attributes.
  function resolveSeriesId() {
    const holder = listEl.closest('[data-series-id]') || listEl;
    if (holder.dataset.seriesId) return holder.dataset.seriesId;
    console.warn(
      '[ttlr] No data-series-id found on or above .ttlr_episode_cms_list — series-level ' +
      'completion (for the completion badge on the series card) will not be recorded. Add ' +
      "data-series-id in Designer, bound to this page's own Series Item ID or Slug."
    );
    return null;
  }
  const seriesId = resolveSeriesId();

  // ---- Memberstack: read/write completion in the ttl-progress Custom Field ----
  // Same mechanism as the app-launcher's stacked-apps field: a Custom Field
  // holding a JSON-stringified string, not Member JSON. Self-contained on
  // purpose — if a shared read/write helper for ttl-progress already exists
  // site-wide (e.g. from the progress/badges/bookmarks doc), prefer
  // consolidating into that rather than running two independent read-modify-
  // write cycles against the same field, which can race and clobber a badge/
  // bookmark write with a stale episodes object or vice versa.
  const PROGRESS_FIELD = 'ttl-progress';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';
  // Matches the stacked-apps launcher's own SAVE_WAIT_MS — same reasoning:
  // collapse rapid changes into a single Memberstack write instead of one per click.
  const SAVE_DEBOUNCE_MS = 500;

  function loadLocalProgress() {
    try {
      return JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
    } catch (err) {
      console.error('[ttlr] Failed to read local progress cache', err);
      return {};
    }
  }

  function saveLocalProgress(data) {
    try {
      window.localStorage.setItem(PROGRESS_LOCAL_KEY, JSON.stringify(data));
    } catch (err) {
      console.error('[ttlr] Failed to save local progress cache', err);
    }
  }

  // Additive merge: a completion recorded on EITHER side wins. Completion
  // never gets un-set by merging, only added — safe regardless of which
  // side (local cache vs Memberstack) is "newer".
  function mergeCompletionMaps(a, b) {
    const merged = { ...(a || {}) };
    Object.keys(b || {}).forEach((key) => {
      if (!merged[key] || (b[key]?.completed && !merged[key].completed)) merged[key] = b[key];
    });
    return merged;
  }

  // Local-first: read the cache synchronously so completion/progress state is
  // available instantly, before Memberstack has even started loading (same
  // pattern as the stacked-apps launcher's local-first render).
  let progressCache = loadLocalProgress();
  progressCache.episodes = progressCache.episodes || {};

  let progressSaveTimer = null;
  function saveProgressToMemberstackDebounced() {
    window.clearTimeout(progressSaveTimer);
    progressSaveTimer = window.setTimeout(async () => {
      const ms = await waitForMemberstack();
      if (!ms) return;
      try {
        const { data: member } = await ms.getCurrentMember();
        if (!member) {
          // Silent before — this is the #1 suspect for "local storage
          // updates fine, Memberstack never does": local-first means
          // saveLocalProgress() above already ran regardless of login
          // state, but there's genuinely nothing to write to Memberstack
          // if nobody's logged in as a member on this page.
          console.warn('[ttlr] progress: getCurrentMember() returned no member (not logged in?) — skipping the Memberstack write, only localStorage was updated.');
          return;
        }

        // Merge with whatever's on the server right now (not a blind
        // overwrite), in case another tab/device wrote since we last hydrated.
        let remote = {};
        const raw = member.customFields?.[PROGRESS_FIELD];
        if (raw) {
          try {
            remote = JSON.parse(raw);
          } catch (parseErr) {
            console.error('[ttlr] Could not parse existing ' + PROGRESS_FIELD + ', overwriting with local', parseErr);
          }
        }
        const merged = {
          episodes: mergeCompletionMaps(remote.episodes, progressCache.episodes),
          series: mergeCompletionMaps(remote.series, progressCache.series),
        };
        progressCache = merged;
        saveLocalProgress(merged);

        const { data: updatedMember } = await ms.updateMember({
          customFields: { [PROGRESS_FIELD]: JSON.stringify(merged) },
        });
        console.log('[ttlr] progress: synced to Memberstack ->', merged, '/ updateMember response customFields:', updatedMember?.customFields);
        if (!updatedMember?.customFields?.[PROGRESS_FIELD]) {
          // Same symptom previously confirmed for ttl-bookmarks: Memberstack
          // silently drops a customFields write whose key doesn't exactly
          // match the field's actual Key (as opposed to its dashboard Label).
          console.warn('[ttlr] progress: updateMember response did NOT include "' + PROGRESS_FIELD + '" — the write was likely silently rejected by Memberstack. Check Settings → Custom Fields → the progress field\'s exact Key matches PROGRESS_FIELD = "' + PROGRESS_FIELD + '" (not just its Label).');
        }
      } catch (err) {
        console.error('[ttlr] Failed to save episode completion to Memberstack', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // Updates local state + the visual instantly; the Memberstack write happens
  // afterward, debounced, in the background — no network round-trip on the
  // click path, so the UI never waits on it.
  function markComplete(episodeId) {
    console.log('[ttlr] markComplete called for episode', episodeId);
    if (!episodeId) return;
    if (progressCache.episodes[episodeId]?.completed) return; // already done, nothing to do

    progressCache.episodes[episodeId] = {
      ...(progressCache.episodes[episodeId] || {}),
      completed: true,
      completedAt: new Date().toISOString(),
    };

    // ---- Roll up to series-level completion (this drives the home page
    // card badge — see initSeriesCard). completedCount/total are written on
    // EVERY call, not just once the series is fully done, so the home page
    // can show a running "3/5" — not just a boolean. They all belong to the
    // same series (see resolveSeriesId above), so this is just a check
    // against ids already on the page — no extra fetch needed.
    if (seriesId) {
      progressCache.series = progressCache.series || {};
      const completedCount = items.filter((item, i) => progressCache.episodes[idOf(item, i)]?.completed).length;
      const total = items.length;
      const wasComplete = progressCache.series[seriesId]?.completed;
      const isComplete = completedCount === total;
      progressCache.series[seriesId] = {
        ...(progressCache.series[seriesId] || {}),
        completedCount,
        total,
        completed: isComplete,
        completedAt: isComplete ? (wasComplete ? progressCache.series[seriesId]?.completedAt : new Date().toISOString()) : undefined,
      };
    }

    saveLocalProgress(progressCache);
    console.log('[ttlr] markComplete: local state updated instantly, Memberstack sync queued', progressCache);
    saveProgressToMemberstackDebounced();
  }

  // ---- Progress bar: global (one per page, not per-episode) completed/total
  // display for this series. The fill percentage is applied via clip-path
  // (not width) so .ttlr_progress_fill's own box never changes size — that
  // matters because the segment mask below is computed in percentages of
  // THIS element's own box, and a mask-image's percentages are relative to
  // the masked element's current size. If width itself drove the fill %,
  // the mask would misalign every time the percentage changed.
  const progressFill = document.querySelector('.ttlr_progress_fill');
  const progressP = document.querySelector('.ttlr_episode_progress_p');
  // The bar's own immediate wrapper (holds the fill + segments) — hidden
  // alongside the count text on series completion, see showSeriesEndSuccess.
  const progressBarEl = document.querySelector('.ttlr_episode_progress_inner');
  console.log('[ttlr] progress bar: .ttlr_progress_fill', progressFill, '/ .ttlr_episode_progress_p', progressP, '/ .ttlr_episode_progress_inner', progressBarEl);

  let lastProgressPercent = null; // null = no comparison basis yet, so the first paint never "pulses"

  // Shows WHERE the learner currently is (currentIndex + 1 / total), not how
  // many episodes are marked complete — driven entirely by show(), not by
  // progressCache. Takes no argument on purpose: completion data (local or
  // Memberstack) no longer affects what this bar displays.
  function updateProgressDisplay() {
    const total = items.length;
    const current = total ? currentIndex + 1 : 0;
    const percent = total ? (current / total) * 100 : 0;
    console.log('[ttlr] updateProgressDisplay: episode ' + current + '/' + total + ' (' + percent.toFixed(1) + '%)');

    if (progressFill) {
      // Only ever reveals more/less of Designer's own gradient via clip-path —
      // never touches the gradient itself (background-image, position, size,
      // etc. are entirely Designer's). Confirmed intent: one continuous
      // gradient revealed proportionally, cut into pill segments purely by
      // the mask below — not a per-segment/panned color. `round 999px`
      // rounds the fill's own leading/trailing corners into a pill cap —
      // 999px is a common trick for "fully rounded regardless of height"
      // (clip-path's round value auto-clamps to half the box's own
      // height, so this doesn't need to match the real bar height
      // exactly). The mask below can't do the same for the gaps BETWEEN
      // segments — mask-image linear-gradient has no rounding syntax, so
      // those internal cuts stay sharp; only the fill's own two end caps
      // (start of the bar, and wherever the current progress cuts off)
      // can be rounded this way.
      progressFill.style.clipPath = `inset(0 ${100 - percent}% 0 0 round 999px)`;

      // Brief pulse on a genuine increase only (not on the initial paint, and
      // not on every re-render) — see .is-updated in sky-ttlr.css. Uses
      // filter (brightness), not background, so it still never touches
      // Designer's gradient.
      if (lastProgressPercent !== null && percent > lastProgressPercent) {
        progressFill.classList.add('is-updated');
        window.setTimeout(() => progressFill.classList.remove('is-updated'), 500);
      }
      lastProgressPercent = percent;
    }

    // Structure is <span>current</span><span>/</span><span>total</span><span class="...">COMPLETED</span>
    // — no distinguishing attribute on the count spans, so this relies on position.
    if (progressP) {
      const counts = progressP.children;
      if (counts[0]) counts[0].textContent = String(current);
      if (counts[2]) counts[2].textContent = String(total);
    }
  }

  // ---- Segment mask: measures each .ttlr_progress_segment's ACTUAL rendered
  // position (whatever Designer's own layout/CSS produces — flex, grid,
  // gaps, anything) and builds a matching mask-image on .ttlr_progress_fill,
  // rather than assuming a specific CSS stacking/background trick. This is
  // what makes the fill only show through where the segments are.
  function updateProgressMask() {
    if (!progressFill) return;
    const segmentEls = Array.from(document.querySelectorAll('.ttlr_progress_segment'));
    console.log('[ttlr] updateProgressMask: found ' + segmentEls.length + ' .ttlr_progress_segment element(s)');
    if (!segmentEls.length) return;

    const fillRect = progressFill.getBoundingClientRect();
    if (!fillRect.width) {
      console.warn('[ttlr] updateProgressMask: .ttlr_progress_fill has zero width, skipping — is it hidden or unstyled?');
      return;
    }

    // A linear-gradient mask (the previous approach) can only produce hard
    // cuts — there's no gradient syntax for rounding an internal edge. An
    // SVG mask can: each segment becomes a <rect> with its own rx/ry, so
    // the gaps BETWEEN segments get real rounded corners too (not just the
    // fill's own leading/trailing edge, which clip-path's own `round`
    // already handles in updateProgressDisplay above).
    //
    // viewBox is 0–100 on both axes (percent of the fill's own width/
    // height) with preserveAspectRatio="none" so it stretches to exactly
    // match the fill's actual box — but that non-uniform stretch means a
    // radius that's "50" in Y-percent (always exactly half the height,
    // fully rounding vertically) needs a DIFFERENT X-percent to represent
    // that same real-world pixel radius horizontally. radiusXPct converts
    // "half the fill's real height, in pixels" into "percent of the fill's
    // real width" — without this, the caps would render as flattened
    // ellipses instead of true semicircles once stretched.
    const radiusXPct = fillRect.height ? (fillRect.height / 2 / fillRect.width) * 100 : 0;

    const rects = [];
    let cursor = 0;
    segmentEls
      .map((seg) => seg.getBoundingClientRect())
      .sort((a, b) => a.left - b.left)
      .forEach((segRect) => {
        const startPct = Math.max(0, ((segRect.left - fillRect.left) / fillRect.width) * 100);
        const endPct = Math.min(100, ((segRect.right - fillRect.left) / fillRect.width) * 100);
        if (endPct <= cursor) return; // overlapping/degenerate — skip
        rects.push(`<rect x="${startPct}" y="0" width="${endPct - startPct}" height="100" rx="${radiusXPct}" ry="50" fill="black" />`);
        cursor = endPct;
      });

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">${rects.join('')}</svg>`;
    const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    progressFill.style.maskImage = maskUrl;
    progressFill.style.webkitMaskImage = maskUrl;
    progressFill.style.maskSize = '100% 100%';
    progressFill.style.webkitMaskSize = '100% 100%';
    progressFill.style.maskRepeat = 'no-repeat';
    progressFill.style.webkitMaskRepeat = 'no-repeat';
    console.log('[ttlr] updateProgressMask: applied SVG mask-image with ' + rects.length + ' rounded segment(s)', svg);
  }

  if (progressFill) {
    // Segment positions can shift after Webflow's own render pass settles
    // (CMS lists, fonts loading, etc.) — rAF + a short delayed re-check
    // catches that without needing a full ResizeObserver setup.
    requestAnimationFrame(updateProgressMask);
    window.setTimeout(updateProgressMask, 500);
    window.addEventListener('resize', () => {
      window.clearTimeout(progressFill._ttlrResizeTimer);
      progressFill._ttlrResizeTimer = window.setTimeout(updateProgressMask, 150);
    });
  }

  // Hydrate from Memberstack in the background and merge additively — picks
  // up completions recorded on another device/session, without blocking the
  // instant local-cache paint above.
  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;
      const raw = member.customFields?.[PROGRESS_FIELD];
      console.log('[ttlr] progress bar: remote ' + PROGRESS_FIELD + ' raw value from Memberstack:', raw);
      if (!raw) return;
      const remote = JSON.parse(raw);
      const merged = {
        episodes: mergeCompletionMaps(progressCache.episodes, remote.episodes),
        series: mergeCompletionMaps(progressCache.series, remote.series),
      };
      progressCache = merged;
      saveLocalProgress(merged);
    } catch (err) {
      console.error('[ttlr] Failed to read progress for progress bar', err);
    }
  });

  // ---- Series-end success screen: shown when "Finish Series" is clicked on
  // the last episode (see updateButtonStates / the click-wiring loop below).
  const seriesEndSuccessEl = document.querySelector('.ttlr_series-end_success');
  const completedEpisodeWrapEl = document.querySelector('.ttlr_completed_episode_wrap');
  const seriesSecondsEl = document.querySelector('[data-series-element="seconds"]');
  // Holds BOTH the "Up Next in X seconds:" countdown+button and the next-
  // series thumbnail card — hidden entirely (see startSeriesEndCountdown)
  // when there's no next series to advance to, since neither piece means
  // anything without one (the button would just sit there disabled, the
  // thumbnail would show a blank placeholder image).
  const completedEpisodeBottomEl = document.querySelector('.ttlr_completed_episode_bottom');
  // The whole section wrapping the episode viewer (cards, menu row, etc.) —
  // hidden alongside the episode item itself so the success screen truly
  // fills the whole screen, not just the space the episode item occupied.
  const episodeCardsSectionEl = document.querySelector('.ttlr_episode_cards_section');
  console.log('[ttlr] series-end: .ttlr_series-end_success', seriesEndSuccessEl, '/ .ttlr_completed_episode_wrap', completedEpisodeWrapEl, '/ [data-series-element="seconds"]', seriesSecondsEl, '/ .ttlr_completed_episode_bottom', completedEpisodeBottomEl, '/ .ttlr_episode_cards_section', episodeCardsSectionEl);

  // Force a clean closed state on load, regardless of whether the static
  // Designer markup happens to already have .is-active on either element
  // (e.g. left on from building/previewing it in Designer) — this screen
  // must only ever appear as a direct result of clicking "Finish Series".
  if (seriesEndSuccessEl?.classList.contains('is-active')) {
    console.warn('[ttlr] series-end: .ttlr_series-end_success had .is-active already present on load — removing it. Check the Designer markup isn\'t shipping this class by default.');
    seriesEndSuccessEl.classList.remove('is-active');
  }
  if (completedEpisodeWrapEl?.classList.contains('is-active')) {
    console.warn('[ttlr] series-end: .ttlr_completed_episode_wrap had .is-active already present on load — removing it. Check the Designer markup isn\'t shipping this class by default.');
    completedEpisodeWrapEl.classList.remove('is-active');
  }

  // Confetti is a third-party dependency (canvas-confetti) — self-loading
  // rather than requiring a separate Webflow <script> tag (same pattern as
  // the app-launcher's own loadMemberstack()): if it's not already present
  // and no matching <script> tag is already loading, this injects one
  // itself, so the celebration works without a manual setup step.
  function loadConfettiLib() {
    return new Promise((resolve) => {
      if (typeof window.confetti === 'function') return resolve(window.confetti);
      const existing = document.querySelector('script[src*="canvas-confetti"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.confetti || null));
        existing.addEventListener('error', () => resolve(null));
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1/dist/confetti.browser.min.js';
      s.onload = () => resolve(window.confetti || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }

  async function fireConfetti() {
    const confetti = await loadConfettiLib();
    if (typeof confetti !== 'function') {
      console.warn('[ttlr] confetti: could not load canvas-confetti (network/ad-blocker?) — no celebration effect this time.');
      return;
    }
    confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
  }

  // 30s countdown into [data-series-element="seconds"]. Guards against
  // overlapping intervals if "Finish Series" is somehow triggered more than
  // once (markComplete() itself is idempotent, but this screen can still be
  // re-shown) — always clears any previous countdown before starting a new one.
  let seriesEndCountdownInterval = null;
  function startSeriesEndCountdown() {
    // No next series to advance to at all — initSeriesNav (elsewhere in
    // this file) already marks [data-series-nav="next-btn"] .is-disabled
    // in that case, so this doesn't need its own separate "is there a next
    // series" lookup. Hide the whole "Up Next in X seconds" + thumbnail
    // block rather than running a countdown that has nothing to click at
    // the end, or showing a disabled button next to a blank thumbnail.
    const nextBtn = document.querySelector('[data-series-nav="next-btn"]');
    if (!nextBtn || nextBtn.classList.contains('is-disabled')) {
      console.log('[ttlr] series-end: no next series available — hiding .ttlr_completed_episode_bottom instead of starting a countdown with nothing to advance to');
      if (completedEpisodeBottomEl) completedEpisodeBottomEl.style.display = 'none';
      return;
    }
    // Series completed earlier in the same page view might have hidden
    // this — a genuine next series exists this time, so make sure it's
    // showing again.
    if (completedEpisodeBottomEl) completedEpisodeBottomEl.style.display = '';

    if (!seriesSecondsEl) {
      console.warn('[ttlr] series-end: [data-series-element="seconds"] not found — countdown cannot run (it will keep showing whatever static text is baked into the Designer markup).');
      return;
    }
    window.clearInterval(seriesEndCountdownInterval);
    let secondsLeft = 30;
    seriesSecondsEl.textContent = String(secondsLeft);
    console.log('[ttlr] series-end: countdown started at ' + secondsLeft + 's');
    seriesEndCountdownInterval = window.setInterval(() => {
      secondsLeft -= 1;
      seriesSecondsEl.textContent = String(Math.max(0, secondsLeft));
      if (secondsLeft <= 0) {
        window.clearInterval(seriesEndCountdownInterval);
        // Auto-advance to the next series. If there's no next series,
        // wireNavButton() (in initSeriesNav) never attaches a click handler
        // and strips the href on disabled buttons, so this is a harmless
        // no-op in that case — nothing to guard here.
        //
        // Navigate directly via the button's own href rather than calling
        // .click() on it: wireNavButton sets a real `href` on an <a> button
        // ("native navigation — no JS needed beyond this"), but a synthetic
        // .click() fired from a setInterval callback isn't a trusted user
        // gesture — if that <a> happens to carry target="_blank" (or a
        // browser is just stricter about it), the popup/tab it would open
        // can get silently blocked, which looks exactly like "the countdown
        // finishes but nothing happens." Setting location.href directly
        // always navigates in the current tab regardless.
        const nextBtns = Array.from(document.querySelectorAll('[data-series-nav="next-btn"]'));
        const nextHref = nextBtns.map((btn) => btn.href || btn.getAttribute('href')).find(Boolean);
        console.log('[ttlr] series-end: countdown reached 0, advancing to next series ->', nextHref);
        if (nextHref) {
          window.location.href = nextHref;
        } else {
          // No <a href> found on any matching button — must be a non-anchor
          // element wired via wireNavButton's own click-listener branch
          // instead. Fall back to a real click for that case.
          nextBtns.forEach((btn) => btn.click());
        }
      }
    }, 1000);
  }

  function showSeriesEndSuccess(episodeItem) {
    if (episodeItem) episodeItem.style.display = 'none'; // only the success screen should show, not the episode underneath it
    if (episodeCardsSectionEl) episodeCardsSectionEl.style.display = 'none'; // whole section, so the success screen fills the whole screen
    if (progressBarEl) progressBarEl.style.display = 'none'; // the episode progress bar shouldn't show once the series is done either
    if (progressP) progressP.style.display = 'none';
    if (bookmarkBtn) bookmarkBtn.style.display = 'none'; // bookmarking a finished episode isn't actionable from this screen
    if (seriesEndSuccessEl) seriesEndSuccessEl.classList.add('is-active');
    if (completedEpisodeWrapEl) completedEpisodeWrapEl.classList.add('is-active');
    fireConfetti();
    startSeriesEndCountdown();
  }

  // ---- Bookmarks: one global button (not per-episode) that bookmarks whichever
  // episode is currently displayed. Read/write in the ttl-bookmarks Custom Field —
  // kept separate from ttl-progress above so a bookmark toggle and a completion
  // write never contend over the same field's read-modify-write cycle.
  const BOOKMARKS_FIELD = 'ttl-bookmarks';
  const bookmarkBtn = document.querySelector('[bookmark="btn"]');
  console.log('[ttlr] bookmarks: [bookmark="btn"] element', bookmarkBtn);
  if (!bookmarkBtn) {
    console.warn('[ttlr] bookmarks: no element matches [bookmark="btn"] on this page — bookmark button will not do anything until that attribute exists in Designer.');
  }

  // The provided icon is a single path drawn with two subpaths + evenodd fill, which
  // renders as a hollow/outline ribbon (the second subpath is the outer boundary, the
  // first carves out the inner hole). Dropping the first subpath leaves just the outer
  // boundary as an ordinary filled shape — the "bookmarked" solid version of the icon.
  const BOOKMARK_OUTLINE_D = 'M6.10982 14.7059C6.48066 14.3969 7.01934 14.3969 7.39018 14.7059L12 18.5474V1.5H1.5V18.5474L6.10982 14.7059ZM6.75 16.125L12.2699 20.7249C12.7584 21.132 13.5 20.7846 13.5 20.1487V0.75C13.5 0.335786 13.1642 0 12.75 0H0.75C0.335786 0 0 0.335787 0 0.750001V20.1487C0 20.7846 0.741645 21.132 1.23014 20.7249L6.75 16.125Z';
  const BOOKMARK_SOLID_D = 'M6.75 16.125L12.2699 20.7249C12.7584 21.132 13.5 20.7846 13.5 20.1487V0.75C13.5 0.335786 13.1642 0 12.75 0H0.75C0.335786 0 0 0.335787 0 0.750001V20.1487C0 20.7846 0.741645 21.132 1.23014 20.7249L6.75 16.125Z';

  function setBookmarkVisual(isBookmarked) {
    if (!bookmarkBtn) return;
    const path = bookmarkBtn.querySelector('svg path');
    console.log('[ttlr] setBookmarkVisual(' + isBookmarked + ') — svg path found:', !!path);
    if (!path) {
      console.warn('[ttlr] bookmarks: [bookmark="btn"] has no <svg><path> inside it — the fill toggle has nothing to update. Check the SVG markup is a real <svg>/<path>, not a background-image.');
      return;
    }
    path.setAttribute('d', isBookmarked ? BOOKMARK_SOLID_D : BOOKMARK_OUTLINE_D);
    bookmarkBtn.classList.toggle('is-bookmarked', isBookmarked);
    bookmarkBtn.setAttribute('aria-pressed', String(isBookmarked));
  }

  const BOOKMARKS_LOCAL_KEY = 'ttlr-bookmarks-local';

  // Bookmarks are stored as SNAPSHOT objects, not bare id strings — captured
  // at the moment of bookmarking from [data-bookmark-thumbnail] (per episode
  // item: an <img> + a [data-bookmark-number]/data-bookmark-name element)
  // and data-bookmark-month on <body> (page-level — every episode on a
  // series page shares the same month) — see bookmarkDataFor below. This is
  // what the bookmarked-episodes carousel elsewhere on the site (see the
  // "bookmarks list" section near the end of this file) renders from,
  // without needing a live lookup against a full episode list. Completion
  // state is deliberately NOT snapshotted — that's read live from
  // ttl-progress at render time instead, so it can't go stale.
  // Old data (a plain array of id strings, from before this change)
  // normalizes into a stub object so .id lookups keep working — it'll just
  // render blank until that episode is bookmarked again.
  function normalizeBookmark(entry) {
    if (typeof entry === 'string') return { id: entry, title: '', month: '', imgSrc: '', imgSrcset: '', href: '' };
    return entry;
  }

  function loadLocalBookmarks() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(BOOKMARKS_LOCAL_KEY));
      return Array.isArray(parsed) ? parsed.map(normalizeBookmark) : [];
    } catch (err) {
      console.error('[ttlr] Failed to read local bookmarks cache', err);
      return [];
    }
  }

  function saveLocalBookmarks(bookmarks) {
    try {
      window.localStorage.setItem(BOOKMARKS_LOCAL_KEY, JSON.stringify(bookmarks));
    } catch (err) {
      console.error('[ttlr] Failed to save local bookmarks cache', err);
    }
  }

  function bookmarkDataFor(item, index) {
    const thumbWrap = item.querySelector('[data-bookmark-thumbnail]');
    const imgEl = thumbWrap?.querySelector('img');
    // data-bookmark-number/data-bookmark-name/data-bookmark-series all live
    // as ATTRIBUTES on this one element — its own text content is separate
    // (unused) placeholder text, not what to read.
    const fieldsEl = thumbWrap?.querySelector('[data-bookmark-number]');
    const titleH2 = item.querySelector('h2');
    const number = numberOf(item);
    const url = new URL(window.location.href);
    if (number) url.searchParams.set('episode', number);

    const episodeName = fieldsEl?.getAttribute('data-bookmark-name') || (titleH2 ? titleH2.textContent.trim() : '');
    const seriesNumber = document.body.getAttribute('data-bookmark-series-number') || '';
    const episodeNumber = fieldsEl?.getAttribute('data-bookmark-number') || number || '';
    const monthName = document.body.getAttribute('data-bookmark-month') || '';
    const year = document.body.getAttribute('data-bookmark-year') || '';

    return {
      id: idOf(item, index),
      // "S1 EP3: Getting it right" — falls back to the bare episode name if
      // series/episode numbers aren't available for some reason.
      title: seriesNumber && episodeNumber ? `S${seriesNumber} EP${episodeNumber}: ${episodeName}` : episodeName,
      // "July 2026"
      month: [monthName, year].filter(Boolean).join(' '),
      imgSrc: imgEl ? imgEl.src : '',
      // Webflow images are usually responsive (srcset + sizes) — capture it
      // too, not just src, so the bookmark card can load the right
      // resolution per viewport instead of always the largest/default one.
      imgSrcset: imgEl ? imgEl.srcset : '',
      href: url.toString(),
    };
  }

  // Local-first, same pattern as progress above (and the stacked-apps
  // launcher): read the cache synchronously so bookmark state is available —
  // and the icon paints correctly — instantly, before Memberstack loads.
  let bookmarksCache = loadLocalBookmarks();

  let bookmarksSaveTimer = null;
  function saveBookmarksToMemberstackDebounced() {
    window.clearTimeout(bookmarksSaveTimer);
    bookmarksSaveTimer = window.setTimeout(async () => {
      const ms = await waitForMemberstack();
      if (!ms) return;
      try {
        const { data: member } = await ms.getCurrentMember();
        if (!member) return; // not logged in — nothing to persist to

        // Write the current local state AS-IS — deliberately NOT merged
        // with whatever's remote. Unlike progress (monotonic, only ever
        // adds), a bookmark can be legitimately removed — union-merging
        // with a possibly-stale remote array silently resurrected anything
        // just unbookmarked (confirmed bug: unbookmarking, then trying to
        // re-bookmark, appeared to do nothing). bookmarksCache is always
        // the authoritative "what the user's actions actually resulted in".
        await ms.updateMember({
          customFields: { [BOOKMARKS_FIELD]: JSON.stringify(bookmarksCache) },
        });
        console.log('[ttlr] bookmarks: synced to Memberstack ->', bookmarksCache);
      } catch (err) {
        console.error('[ttlr] Failed to save bookmark to Memberstack', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  if (bookmarkBtn) {
    // Instant paint from the local cache — no waiting on Memberstack.
    setBookmarkVisual(bookmarksCache.some((b) => b.id === idOf(items[currentIndex], currentIndex)));

    // Hydrate from Memberstack in the background and merge (union, by id —
    // local's own copy of a bookmark wins on conflict since it reflects
    // whatever this session most recently did) — picks up bookmarks
    // recorded on another device/session, without blocking the paint above.
    waitForMemberstack().then(async (ms) => {
      if (!ms) return;
      try {
        const { data: member } = await ms.getCurrentMember();
        if (!member) return;
        const raw = member.customFields?.[BOOKMARKS_FIELD];
        console.log('[ttlr] bookmarks: remote ' + BOOKMARKS_FIELD + ' raw value from Memberstack:', raw);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const remote = (Array.isArray(parsed) ? parsed : []).map(normalizeBookmark);
        const byId = new Map();
        remote.forEach((b) => byId.set(b.id, b));
        bookmarksCache.forEach((b) => byId.set(b.id, b));
        const merged = Array.from(byId.values());
        bookmarksCache = merged;
        saveLocalBookmarks(merged);
        setBookmarkVisual(merged.some((b) => b.id === idOf(items[currentIndex], currentIndex)));
      } catch (err) {
        console.error('[ttlr] Failed to read bookmarks from Memberstack', err);
      }
    });

    // Synchronous now — no network wait before the icon updates. The
    // Memberstack write happens afterward, debounced, in the background.
    bookmarkBtn.addEventListener('click', () => {
      console.log('[ttlr] bookmark button clicked');
      const episodeId = idOf(items[currentIndex], currentIndex);
      const isBookmarked = bookmarksCache.some((b) => b.id === episodeId);
      bookmarksCache = isBookmarked
        ? bookmarksCache.filter((b) => b.id !== episodeId)
        : [...bookmarksCache, bookmarkDataFor(items[currentIndex], currentIndex)];

      saveLocalBookmarks(bookmarksCache);
      setBookmarkVisual(!isBookmarked);
      console.log('[ttlr] bookmark click: local state updated instantly ->', bookmarksCache);

      saveBookmarksToMemberstackDebounced();
    });
  }

  // ---- Show exactly one item; sync the URL; update button states ----
  const EPISODE_TRANSITION_MS = 400; // keep in sync with the CSS transition duration on .ttlr_episode_cms_item

  function show(index) {
    const outgoingItem = hasShownOnce ? items[currentIndex] : null;
    const incomingItem = items[index];
    currentIndex = index;
    updateProgressDisplay();

    if (!outgoingItem || outgoingItem === incomingItem) {
      // First paint (or somehow re-showing the same item): instant, no fade.
      items.forEach((item, i) => {
        item.style.display = i === index ? '' : 'none';
      });
      hasShownOnce = true;
    } else {
      // Sequential fade: fully hide the outgoing item before showing the
      // incoming one. A true simultaneous crossfade needs both items
      // absolutely positioned to overlap in place — without that, having
      // both in normal document flow at once (even briefly) visibly jumps
      // the page height/layout as they stack, which read as "glitchy".
      // Sequential is layout-safe regardless of Designer's markup.
      outgoingItem.classList.add('ttlr-episode-fade');
      window.setTimeout(() => {
        outgoingItem.style.display = 'none';
        outgoingItem.classList.remove('ttlr-episode-fade');

        incomingItem.style.display = '';
        incomingItem.classList.add('ttlr-episode-fade');
        // Force a reflow so the browser commits the opacity:0 starting state
        // before removing the class — otherwise add+remove in the same tick
        // would get coalesced into a no-op with nothing to animate from.
        void incomingItem.offsetWidth;
        incomingItem.classList.remove('ttlr-episode-fade');
      }, EPISODE_TRANSITION_MS);
    }

    const number = numberOf(items[index]);
    if (number) {
      const url = new URL(window.location.href);
      url.searchParams.set('episode', number);
      history.pushState({ episodeIndex: index }, '', url);
    }

    updateButtonStates(index);
    setBookmarkVisual(bookmarksCache.some((b) => b.id === idOf(items[index], index)));
  }

  function updateButtonStates(index) {
    const current = items[index];
    const prevBtn = current.querySelector('.ttlr_episode_button.is-prev');
    const nextBtn = current.querySelector('.ttlr_episode_button.is-next');

    if (prevBtn) {
      // On episode 1 there's nothing to go back to at all — hidden
      // entirely (not just dimmed/disabled) rather than showing "Back to:
      // EP1" in a disabled state with nowhere real to go.
      const disablePrev = index === 0;
      prevBtn.disabled = disablePrev;
      prevBtn.classList.toggle('is-disabled', disablePrev);
      prevBtn.setAttribute('aria-disabled', String(disablePrev));
      prevBtn.style.display = disablePrev ? 'none' : '';
    }

    if (nextBtn) {
      // Always actionable now: on every episode but the last it advances
      // (see the click-wiring loop below); on the last one it's relabeled
      // "Finish Series" and marks that episode complete + shows the
      // .ttlr_series-end_success screen instead of advancing anywhere.
      nextBtn.disabled = false;
      nextBtn.classList.remove('is-disabled');
      nextBtn.setAttribute('aria-disabled', 'false');
      if (index === items.length - 1) {
        nextBtn.textContent = 'Finish Series';
      }
    }

    // ---- [next-episode-number] / [prev-episode-number]: filled with the ----
    // adjacent episode's actual visible number, not index±1 (kept
    // consistent with numberOf() everywhere else, in case numbers are ever
    // non-contiguous). No Designer binding needed for either — the script
    // writes the attribute value AND mirrors it into the element's text,
    // so it works whether you style off the attribute (content:
    // attr(next-episode-number)) or just read the element's own text.
    const nextNumberTarget = current.querySelector('[next-episode-number]');
    if (nextNumberTarget) {
      const nextItem = items[index + 1];
      // Last episode: no next item — left blank rather than guessing at a
      // number that doesn't exist (the Next button itself becomes "Finish
      // Series" here instead, see above).
      const nextNumber = nextItem ? numberOf(nextItem) || '' : '';
      nextNumberTarget.setAttribute('next-episode-number', nextNumber);
      nextNumberTarget.textContent = nextNumber;
    }

    const prevNumberTarget = current.querySelector('[prev-episode-number]');
    if (prevNumberTarget) {
      const prevItem = items[index - 1];
      // First episode: no prev item — left blank, same reasoning as above.
      const prevNumber = prevItem ? numberOf(prevItem) || '' : '';
      prevNumberTarget.setAttribute('prev-episode-number', prevNumber);
      prevNumberTarget.textContent = prevNumber;
    }
  }

  // Plain navigation — no completion side effect. Used by Prev, so going
  // back to re-watch an earlier episode never marks the one you're leaving
  // as complete (only actively clicking Next on it does that, below).
  function goTo(targetIndex) {
    if (targetIndex < 0 || targetIndex >= items.length) return;
    show(targetIndex);
  }

  items.forEach((item, index) => {
    const prevBtn = item.querySelector('.ttlr_episode_button.is-prev');
    const nextBtn = item.querySelector('.ttlr_episode_button.is-next');
    if (prevBtn) prevBtn.addEventListener('click', () => goTo(index - 1));
    if (nextBtn) {
      const isLast = index === items.length - 1;
      nextBtn.addEventListener('click', () => {
        if (isLast) {
          console.log('[ttlr] "Finish Series" clicked on episode index ' + index);
          markComplete(idOf(item, index));
          showSeriesEndSuccess(item);
        } else {
          // Completion happens specifically on Next — landing on an episode
          // (via URL, Prev, or initial load) never marks it complete, only
          // actively moving forward past it does.
          markComplete(idOf(item, index));
          goTo(index + 1);
        }
      });
    }
  });

  // ---- Initial episode from ?episode= in the URL, defaulting to the first ----
  const requestedNumber = new URL(window.location.href).searchParams.get('episode');
  let startIndex = 0;
  if (requestedNumber) {
    const match = items.findIndex((item) => numberOf(item) === requestedNumber);
    if (match !== -1) startIndex = match;
  }
  show(startIndex);
}

/* ---- Drag & drop matching quiz (interact.js) ---- */

ttlrReady('drag-drop quiz', function () {
  if (typeof interact === 'undefined') {
    console.warn('[ttlr] drag-drop quiz: interact.js is not loaded (typeof interact === "undefined") — check its <script> tag is present and loads before this file.');
    return;
  }
  const wraps = document.querySelectorAll('.ttlr_dragdrop_wrap');
  console.log('[ttlr] drag-drop quiz: found ' + wraps.length + ' .ttlr_dragdrop_wrap element(s) on this page');
  wraps.forEach(initTtlrDragDrop);
});

function initTtlrDragDrop(root) {
  const tray = root.querySelector('.ttlr_dragdrop_props_wrap');
  const props = Array.from(root.querySelectorAll('.ttlr_dragdrop_prop_item[data-correct-zone]'));
  const resetBtn = root.querySelector('.ttlr_dragdrop_reset');
  const live = ensureLiveRegion(root);
  console.log('[ttlr] initTtlrDragDrop: tray', tray, '/ ' + props.length + ' prop(s) with data-correct-zone');

  if (!tray || !props.length) {
    console.warn('[ttlr] initTtlrDragDrop: bailing out — missing .ttlr_dragdrop_props_wrap or no .ttlr_dragdrop_prop_item[data-correct-zone] found.');
    return;
  }

  let complete = false;

  // ---- Build the zone registry: zoneId -> { wrapperEl, slotEl, label } ----
  const zones = new Map();
  root.querySelectorAll('.ttlr_dragdrop_label_item[data-zone-id]').forEach((wrapperEl) => {
    const slotEl = wrapperEl.querySelector('.ttlr_dragdrop_drop-zone');
    if (!slotEl) return;
    const zoneId = wrapperEl.dataset.zoneId;

    // Defensive: ignore/overwrite whatever the slot div's own data-zone-id
    // says (see note at top of file) — the wrapper is the source of truth.
    slotEl.removeAttribute('data-zone-id');
    slotEl.dataset.zoneId = zoneId;
    slotEl.dataset.dropRole = 'zone';
    slotEl.setAttribute('tabindex', '0');
    slotEl.setAttribute('role', 'button');
    slotEl.setAttribute('aria-roledescription', 'Drop target');

    const labelText = Array.from(wrapperEl.children)
      .find((child) => child !== slotEl && child.tagName !== 'IMG')
      ?.textContent.trim() || `Zone ${zoneId}`;

    zones.set(zoneId, { wrapperEl, slotEl, label: labelText });
  });
  console.log('[ttlr] drag-drop: zone registry ->', Array.from(zones.keys()));
  console.log('[ttlr] drag-drop: prop correctZone values ->', props.map((p) => p.dataset.correctZone));

  tray.dataset.dropRole = 'tray';
  tray.setAttribute('tabindex', '0');
  tray.setAttribute('role', 'button');
  tray.setAttribute('aria-roledescription', 'Drop target');

  const dropTargets = [tray, ...Array.from(zones.values()).map((z) => z.slotEl)];

  // ---- Helpers ----
  function labelFor(targetEl) {
    if (targetEl === tray) return 'the option tray';
    return zones.get(targetEl.dataset.zoneId)?.label || `Zone ${targetEl.dataset.zoneId}`;
  }

  function occupantOf(targetEl) {
    return targetEl === tray ? null : (targetEl.children[0] || null);
  }

  function resetTransform(el) {
    el.style.transform = '';
    el.removeAttribute('data-x');
    el.removeAttribute('data-y');
  }

  // The ONLY function that actually moves a prop in the DOM. Called
  // exactly once per prop, the moment it's correctly placed.
  function place(propEl, targetEl) {
    resetTransform(propEl);
    targetEl.appendChild(propEl);
  }

  function announce(message) {
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = message; });
  }

  function flashReject(propEl, zoneEl) {
    propEl.classList.add('is-rejected');
    window.setTimeout(() => propEl.classList.remove('is-rejected'), 300);
    if (zoneEl && zoneEl !== tray) {
      zoneEl.classList.add('is-rejected');
      window.setTimeout(() => zoneEl.classList.remove('is-rejected'), 400);
    }
  }

  function lockProp(propEl) {
    propEl.setAttribute('tabindex', '-1');
    propEl.setAttribute('aria-disabled', 'true');
    const action = interact(propEl);
    if (action) action.draggable(false);
  }

  // A drop is only ever accepted onto its correct, currently-empty zone.
  // Anything else just resets the transform — since the prop was never
  // actually moved out of the tray, "rejecting" it means doing nothing.
  function handleDrop(propEl, targetEl) {
    if (complete || propEl.classList.contains('is-correct')) return;

    if (targetEl === tray) {
      resetTransform(propEl); // back onto the tray it never left — settle visually
      return;
    }

    const isCorrectZone = targetEl.dataset.zoneId === propEl.dataset.correctZone;
    const isOccupied = !!occupantOf(targetEl);
    console.log('[ttlr] drag-drop: dropped prop (correctZone=' + propEl.dataset.correctZone + ') onto zone ' + targetEl.dataset.zoneId + ' — correctZone match: ' + isCorrectZone + ', occupied: ' + isOccupied);

    if (!isCorrectZone || isOccupied) {
      resetTransform(propEl); // reject — snaps back to its exact spot, nothing moved
      flashReject(propEl, targetEl);
      announce(`Not quite — try another zone for ${propEl.textContent.trim()}.`);
      return;
    }

    place(propEl, targetEl); // correct — the one real DOM move
    propEl.classList.add('is-correct');
    lockProp(propEl);
    announce(`Correct! ${propEl.textContent.trim()} placed in ${labelFor(targetEl)}.`);

    checkComplete();
  }

  function checkComplete() {
    if (!props.every((p) => p.classList.contains('is-correct'))) return;
    complete = true;
    root.classList.add('is-complete');
    announce(`Nice work — all ${props.length} matched correctly.`);
    root.dispatchEvent(new CustomEvent('ttlr:quizCompleted', {
      bubbles: true,
      detail: { total: props.length },
    }));
  }

  function resetAll() {
    complete = false;
    root.classList.remove('is-complete');
    props.forEach((p) => {
      const wasPlacedInZone = p.parentElement !== tray;
      p.classList.remove('is-correct', 'is-rejected', 'is-dragging');
      p.removeAttribute('aria-disabled');
      p.setAttribute('tabindex', '0');
      const action = interact(p);
      if (action) action.draggable(true);
      // Only move props that actually left the tray — leave the rest
      // untouched so resetting doesn't reshuffle props that never moved.
      if (wasPlacedInZone) place(p, tray);
      else resetTransform(p);
    });
    announce('Quiz reset. All answers returned to the tray.');
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', resetAll);
  }

  // ---- Pointer / touch drag: transform-only, never leaves the DOM ----
  props.forEach((propEl) => {
    propEl.setAttribute('tabindex', '0');
    propEl.setAttribute('role', 'button');
    propEl.setAttribute('aria-roledescription', 'Draggable answer');

    interact(propEl).draggable({
      inertia: false,
      autoScroll: true,
      listeners: {
        start(event) {
          if (complete) return;
          event.target.classList.add('is-dragging');
        },
        move(event) {
          if (complete) return;
          const el = event.target;
          const x = (parseFloat(el.getAttribute('data-x')) || 0) + event.dx;
          const y = (parseFloat(el.getAttribute('data-y')) || 0) + event.dy;
          el.style.transform = `translate(${x}px, ${y}px)`;
          el.setAttribute('data-x', x);
          el.setAttribute('data-y', y);
        },
        end(event) {
          const el = event.target;
          el.classList.remove('is-dragging');
          // Safety net regardless of drop/dragend firing order: if a
          // correct drop already handled + reset this, it's a no-op.
          // Otherwise this snaps it back to its resting spot — it was
          // never actually removed from the tray to begin with.
          if (!el.classList.contains('is-correct')) resetTransform(el);
        },
      },
    });
  });

  // ---- Dropzones (4 zone slots + tray) ----
  dropTargets.forEach((targetEl) => {
    interact(targetEl).dropzone({
      accept: '.ttlr_dragdrop_prop_item',
      // 'pointer' checks whether the cursor/touch point itself is inside the
      // target rect, rather than requiring the dragged element to cover a %
      // of the target's area (that was overlap: 0.4 — far too strict for a
      // small/thin .ttlr_dragdrop_drop-zone box, which is what was causing
      // correct drops to register as misses). Designer still needs the zone
      // to have real height/width — a genuinely 0-size target has no area
      // for the pointer to be "inside" either way.
      overlap: 'pointer',
      ondragenter(event) {
        event.target.classList.add('drop-hover');
      },
      ondragleave(event) {
        event.target.classList.remove('drop-hover');
      },
      ondrop(event) {
        event.target.classList.remove('drop-hover');
        handleDrop(event.relatedTarget, event.target);
      },
    });
  });

  // ---- Keyboard alternative: focus a prop, Enter to grab, Tab to a
  // zone, Enter to attempt a drop, Escape to cancel. Nothing moves in
  // the DOM here either until handleDrop confirms a correct placement. ----
  let grabbed = null;

  props.forEach((propEl) => {
    propEl.addEventListener('keydown', (evt) => {
      if (complete) return;
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        if (grabbed === propEl) {
          grabbed.classList.remove('is-grabbed');
          grabbed = null;
        } else {
          if (grabbed) grabbed.classList.remove('is-grabbed');
          grabbed = propEl;
          propEl.classList.add('is-grabbed');
          announce(`${propEl.textContent.trim()} picked up. Tab to a zone and press Enter to try it, or press Escape to cancel.`);
        }
      } else if (evt.key === 'Escape' && grabbed === propEl) {
        evt.preventDefault();
        grabbed.classList.remove('is-grabbed');
        announce(`${grabbed.textContent.trim()} placement cancelled.`);
        grabbed = null;
      }
    });
  });

  dropTargets.forEach((targetEl) => {
    targetEl.addEventListener('keydown', (evt) => {
      if (complete || !grabbed) return;
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        const propEl = grabbed;
        grabbed.classList.remove('is-grabbed');
        grabbed = null;
        handleDrop(propEl, targetEl);
      }
    });
  });

  function ensureLiveRegion(el) {
    let liveEl = el.querySelector('.ttlr_dragdrop_live');
    if (!liveEl) {
      liveEl = document.createElement('div');
      liveEl.className = 'ttlr_dragdrop_live';
      liveEl.setAttribute('aria-live', 'polite');
      liveEl.setAttribute('role', 'status');
      el.appendChild(liveEl);
    }
    return liveEl;
  }
}

/* ---- Notes pad: resizable, localStorage-backed notepad. Content is a
   single shared note (not per-page), so it's the same everywhere this
   Webflow component is placed — localStorage is already global per
   browser/domain, so no page-scoping is needed for that to work. ---- */

ttlrReady('notes pad', function () {
  document.querySelectorAll('.notes_component_wrap').forEach(initNotesPad);
});

function initNotesPad(root) {
  // Unlike every other init function in this file, this one had no
  // top-level re-run guard — meaning every time this site's Webflow
  // runtime re-fires Webflow.push (confirmed behavior, see ttlrReady
  // above), this whole function ran again on the SAME root: a second
  // textarea input listener, a second copy/delete/drag-line listener, and
  // a second MutationObserver, all stacking up. The delete button is the
  // one where that's actually destructive, not just wasteful — two click
  // listeners firing on ONE click means the first arms .is-confirm and the
  // second (still handling that same click) sees it already armed and
  // deletes immediately, skipping the two-click confirm entirely. Root
  // cause of a 2026-08-27 "notes isn't working" report.
  if (root.dataset.ttlrNotesPadWired) return;
  root.dataset.ttlrNotesPadWired = 'true';

  const CONTENT_KEY = 'ttlr-notes-content';
  const WIDTH_KEY = 'ttlr-notes-width';
  const MIN_WIDTH = 528; // functional floor — narrower than this and the textarea stops being usable
  const VIEWPORT_MARGIN = 64; // keep the pad from ever fully covering the viewport

  const textarea = root.querySelector('.ttlr_notes_text-area');
  const dragLine = root.querySelector('.notes_drag_line');
  const form = root.querySelector('.ttlr_notes_form');
  const deleteBtn = root.querySelector('[data-notes-action="delete"]');
  const copyBtn = root.querySelector('[data-notes-action="copy"]');

  // Force a clean unarmed state on load, regardless of whether the static
  // Designer markup happens to already have .is-confirm on the delete
  // button (confirmed present in a live HTML dump) — without this, a single
  // click would immediately delete instead of arming the two-click confirm.
  if (deleteBtn?.classList.contains('is-confirm')) {
    console.warn('[ttlr] notes: delete button had .is-confirm already present on load — removing it. Check the Designer markup isn\'t shipping this class by default.');
    deleteBtn.classList.remove('is-confirm');
  }

  // This textarea lives inside a Webflow form component (for its built-in styling/
  // maxlength), but it's not meant to actually submit anywhere — guard against that.
  if (form) form.addEventListener('submit', (e) => e.preventDefault());

  function loadContent() {
    try {
      return window.localStorage.getItem(CONTENT_KEY) || '';
    } catch (err) {
      console.error('[ttlr] Failed to read notes from localStorage', err);
      return '';
    }
  }

  function saveContent(value) {
    try {
      window.localStorage.setItem(CONTENT_KEY, value);
    } catch (err) {
      console.error('[ttlr] Failed to save notes to localStorage', err);
    }
  }

  // If this component happens to appear more than once on the same page, keep every
  // instance's textarea showing the same content without moving anyone's caret/focus.
  function syncOtherInstances(value, exceptTextarea) {
    document.querySelectorAll('.ttlr_notes_text-area').forEach((el) => {
      if (el !== exceptTextarea && el.value !== value) el.value = value;
    });
  }

  if (textarea) {
    textarea.value = loadContent();
    textarea.addEventListener('input', () => {
      saveContent(textarea.value);
      syncOtherInstances(textarea.value, textarea);
    });
  }

  // ---- Copy: copies the note to the clipboard, flashes .notes_copy_success ----
  if (copyBtn) {
    // .notes_copy_success lives as a SIBLING of .notes_actions in Designer's
    // markup (not nested inside the copy button), so this searches the whole
    // component root rather than just copyBtn's own descendants.
    let successEl = root.querySelector('.notes_copy_success');
    console.log('[ttlr] notes: .notes_copy_success found in root?', !!successEl);
    if (!successEl) {
      // Fallback only if truly absent anywhere in this component — auto-created
      // so copy still gives feedback out of the box.
      successEl = document.createElement('div');
      successEl.className = 'notes_copy_success';
      successEl.textContent = 'Copied!';
      root.appendChild(successEl);
    }

    const successCloseBtn = successEl.querySelector('.notes_copy_close');
    if (successCloseBtn) {
      successCloseBtn.addEventListener('click', () => successEl.classList.remove('is-active'));
    }

    copyBtn.addEventListener('click', async () => {
      console.log('[ttlr] notes: copy clicked');
      if (!textarea) return;
      try {
        await navigator.clipboard.writeText(textarea.value);
        successEl.classList.add('is-active');
        window.setTimeout(() => successEl.classList.remove('is-active'), 2000);
      } catch (err) {
        console.error('[ttlr] Failed to copy notes to clipboard', err);
      }
    });
  }

  // The pad's own open/close state (is-open="true"/"false", toggled by a
  // separate script on [open-notes="btn"]) — used both to gate the
  // drag-resize width restore below and to reset the delete-confirm arm
  // state whenever the pad closes.
  function isOpen() {
    return root.getAttribute('is-open') === 'true';
  }

  // ---- Delete: first click arms .is-confirm, second click actually clears ----
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      console.log('[ttlr] notes: delete clicked, armed:', deleteBtn.classList.contains('is-confirm'));
      if (!deleteBtn.classList.contains('is-confirm')) {
        deleteBtn.classList.add('is-confirm');
        return;
      }
      if (textarea) textarea.value = '';
      saveContent('');
      syncOtherInstances('', textarea);
      deleteBtn.classList.remove('is-confirm');
    });
  }

  // ---- Drag line: resizes the pad by dragging its left edge ----
  // Assumes the pad is anchored to the right (drag_line sits before notes_pad in the
  // DOM, i.e. on its left edge), so dragging left grows it and dragging right shrinks
  // it. If the pad is actually anchored left, flip the sign in onPointerMove below.
  // Resizes .notes_wrap (the inner content wrapper), NOT .notes_component_wrap
  // (root) itself — root's width is what open/close controls (0 when
  // closed), separate from how wide the content area is once open.
  const notesWrapEl = root.querySelector('.notes_wrap');

  if (dragLine && notesWrapEl) {
    let startX = 0;
    let startWidth = 0;

    function onPointerMove(e) {
      const delta = e.clientX - startX;
      const maxWidth = window.innerWidth - VIEWPORT_MARGIN;
      const nextWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth - delta));
      notesWrapEl.style.width = `${nextWidth}px`;
    }

    function onPointerUp() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.documentElement.classList.remove('ttlr-is-resizing');
      try {
        window.localStorage.setItem(WIDTH_KEY, notesWrapEl.style.width);
      } catch (err) {
        console.error('[ttlr] Failed to save notes pad width to localStorage', err);
      }
    }

    dragLine.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startWidth = notesWrapEl.getBoundingClientRect().width;
      document.documentElement.classList.add('ttlr-is-resizing'); // suppress text selection while dragging
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });

    // A remembered drag width always loses to the pad's own closed state —
    // see the shared is-open observer below, set up regardless of whether
    // dragLine exists.
    function applySavedWidthIfOpen() {
      if (!isOpen()) return;
      try {
        const savedWidth = window.localStorage.getItem(WIDTH_KEY);
        if (savedWidth) notesWrapEl.style.width = savedWidth;
      } catch (err) {
        console.error('[ttlr] Failed to read notes pad width from localStorage', err);
      }
    }

    applySavedWidthIfOpen();
  } else if (dragLine && !notesWrapEl) {
    console.warn('[ttlr] notes: .notes_drag_line found but no .notes_wrap inside this component root — drag-resize will not run.');
  }

  // Watches is-open regardless of what else changes it (jQuery/GSAP toggle,
  // dev tools, anything) and regardless of whether dragLine/deleteBtn exist —
  // the moment it's not "true": clears our own inline width so nothing we've
  // set can hold the pad open past a close action, AND resets the delete
  // button's confirm-arm state, so reopening the pad after closing it mid-arm
  // (armed, then closed without confirming) always starts fresh.
  new MutationObserver(() => {
    if (isOpen()) return;
    // Deliberately does NOT touch root.style.width anymore — open/close
    // width is fully owned by the external jQuery+GSAP script again (see
    // the "Open/close toggle" note further up), and GSAP animates that
    // SAME property on that SAME element frame-by-frame. This used to
    // clear it to '' the instant is-open flipped to false, which raced
    // against GSAP's tween just starting — root cause of a reported "no
    // movement when opening/closing" after this script stopped handling
    // open/close (2026-08-27). Only the delete-confirm reset is ours now.
    if (deleteBtn?.classList.contains('is-confirm')) deleteBtn.classList.remove('is-confirm');
  }).observe(root, { attributes: true, attributeFilter: ['is-open'] });
}

/* ---- Series navigation: Next/Previous Series buttons. Same mechanism as
   the Refokus "CMS Prev/Next" tool (replicated natively here rather than
   loading their script, to stay dependency-free like the rest of this
   project): a hidden Collection List bound to the Series collection, in
   whatever order you want navigation to follow, is used purely as a lookup
   table — match the current page's URL against each item's own link to find
   its position, then Next/Prev just point at the adjacent item's link.
   Setup instructions were given directly in chat, not documented in the
   README (by request) — ask if you need them again. ---- */

ttlrReady('series nav', function () {
  document.querySelectorAll('[data-series-nav="source"]').forEach(initSeriesNav);
});

function initSeriesNav(sourceEl) {
  const itemEls = Array.from(sourceEl.querySelectorAll('.w-dyn-item'));
  console.log('[ttlr] series nav: found ' + itemEls.length + ' item(s) in [data-series-nav="source"]');
  if (!itemEls.length) return;

  const items = itemEls
    .map((itemEl, i) => {
      const link = itemEl.tagName === 'A' ? itemEl : itemEl.querySelector('a[href]');
      if (!link) {
        console.warn('[ttlr] series nav: item ' + i + ' in [data-series-nav="source"] has no <a href> (itself or a descendant) — skipping it. Its markup:', itemEl.outerHTML);
        return null;
      }
      // number/name are read from dedicated [data-series-nav-field="..."]
      // elements inside the item, since a single link's combined text can't
      // be split back into separate pieces — text/img stay as whole-link
      // fallbacks for anyone who doesn't need them split out.
      //
      // The live markup has TWO elements both tagged data-series-nav-
      // field="number" per item — a static "Series" label alongside the
      // actual value ("2") — confirmed via a live HTML dump 2026-08-27.
      // querySelector() would always grab whichever comes first (the
      // "Series" label, never the number), which is why "Up Next" showed
      // the literal word "Series" instead of a number. Pick whichever
      // match is purely numeric instead of just the first one.
      const numberEls = Array.from(itemEl.querySelectorAll('[data-series-nav-field="number"]'));
      const numberMatch = numberEls.map((el) => el.textContent.trim()).find((t) => /^\d+$/.test(t));
      return {
        href: link.href,
        text: link.textContent.trim(),
        number: numberMatch || '',
        name: itemEl.querySelector('[data-series-nav-field="name"]')?.textContent.trim() || '',
        imgSrc: itemEl.querySelector('[data-series-nav-field="img"]')?.src
          || link.querySelector('img')?.src
          || itemEl.querySelector('img')?.src
          || '',
      };
    })
    .filter(Boolean);
  console.log('[ttlr] series nav: extracted items ->', items);

  const currentPath = window.location.pathname.replace(/\/$/, '');
  const currentIndex = items.findIndex((item) => new URL(item.href).pathname.replace(/\/$/, '') === currentPath);
  console.log('[ttlr] series nav: current page matched at index ' + currentIndex + ' of ' + items.length);
  if (currentIndex === -1) {
    console.warn('[ttlr] series nav: current page URL did not match any item in [data-series-nav="source"] — check the hidden list includes every series and each links to its own real, published page.');
  }

  const nextItem = currentIndex !== -1 ? items[currentIndex + 1] || null : null;
  const prevItem = currentIndex !== -1 ? items[currentIndex - 1] || null : null;

  function wireNavButton(direction, item) {
    // Optional: an outer wrapper around the whole next/prev block (label,
    // thumbnail, button — everything), fully hidden when there's genuinely
    // no next/prev series (e.g. the last series in the list has no "next").
    // Without this, the button/text/img fields above still exist but are
    // blank/disabled, which can look broken (empty image, an inert-looking
    // but still-visible button) rather than the block just not being there.
    // Opt-in — if this attribute isn't added in Designer, behavior is
    // unchanged from before.
    document.querySelectorAll(`[data-series-nav="${direction}-wrap"]`).forEach((el) => {
      el.style.display = item ? '' : 'none';
    });

    document.querySelectorAll(`[data-series-nav="${direction}-btn"]`).forEach((btn) => {
      if (!item) {
        btn.classList.add('is-disabled');
        btn.setAttribute('aria-disabled', 'true');
        if (btn.tagName === 'A') btn.removeAttribute('href');
        return;
      }
      btn.classList.remove('is-disabled');
      btn.setAttribute('aria-disabled', 'false');
      if (btn.tagName === 'A') {
        btn.href = item.href; // native navigation — no JS needed beyond this
      } else {
        btn.addEventListener('click', () => { window.location.href = item.href; });
      }
    });
  }

  function fillNavContent(direction, item) {
    document.querySelectorAll(`[data-series-nav="${direction}-text"]`).forEach((el) => {
      el.textContent = item ? item.text : '';
    });
    document.querySelectorAll(`[data-series-nav="${direction}-number"]`).forEach((el) => {
      el.textContent = item ? item.number : '';
    });
    document.querySelectorAll(`[data-series-nav="${direction}-name"]`).forEach((el) => {
      el.textContent = item ? item.name : '';
    });
    document.querySelectorAll(`[data-series-nav="${direction}-img"]`).forEach((el) => {
      if (item && item.imgSrc) el.src = item.imgSrc;
    });
  }

  wireNavButton('next', nextItem);
  wireNavButton('prev', prevItem);
  fillNavContent('next', nextItem);
  fillNavContent('prev', prevItem);
}

/* ---- Series swiper: landing/hero page series carousel (Swiper.js).
   Swiper's own bundled CSS IS loaded (added directly in Webflow Custom Code
   Head, alongside the existing swiper-bundle.min.js — outside this repo).
   Its default stylesheet would otherwise reposition/reglyph
   .swiper-button-prev/-next (Designer's own custom SVG-icon buttons, not
   Swiper's default arrows) — sky-ttlr.css neutralizes just that part, so
   everything else (slide sizing, wrapper transform/scroll, cssMode's own
   base styling if ever needed again) comes from the official stylesheet
   instead of being manually replicated here, which is what caused a real
   clipping regression the one time this project tried to run without it
   (2026-09-05, cssMode's manual overflow-x:auto — see initSeriesSwiper's
   own comment below for the full history). ---- */

// Calls initSeriesSwiper on one element without letting a throw escape —
// critical because this is used inside Array.prototype.forEach, and forEach
// does NOT continue past an uncaught exception in one callback invocation;
// a single element failing to init would otherwise silently abort every
// element still left in the loop. Confirmed 2026-09-04: this is exactly why
// EVERY nested .ttlr_cms_series-wrapper inside .ttlr_prev-episodes_wrap
// (8 of them, one per month) stayed uninitialized while the hero/Re-Watch-
// outer/bookmarks wrappers (all earlier in document order, or initialized
// via a wholly separate code path — see the bookmarks list's own render())
// worked fine — whatever throws on the FIRST nested wrapper it reaches was
// silently killing the whole rest of that querySelectorAll pass.
function initSeriesSwiperSafe(root) {
  try {
    initSeriesSwiper(root);
  } catch (err) {
    console.error('[ttlr] series swiper: initSeriesSwiper threw for this element — every OTHER element still gets processed, but this one stays un-swiped', root, err);
  }
}

ttlrReady('series swiper', function () {
  if (typeof Swiper === 'undefined') {
    console.warn('[ttlr] series swiper: Swiper is not loaded — check its <script> tag is present and loads before this file.');
    return;
  }
  document.querySelectorAll('.ttlr_cms_series-wrapper').forEach(initSeriesSwiperSafe);

  // Fallback for the (separate, still-possible) case of genuinely
  // asynchronously-inserted CMS content this one-time scan can't see yet —
  // catches any .ttlr_cms_series-wrapper added to the DOM after this point.
  const seriesSwiperObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.matches?.('.ttlr_cms_series-wrapper')) initSeriesSwiperSafe(node);
        node.querySelectorAll?.('.ttlr_cms_series-wrapper').forEach(initSeriesSwiperSafe);
      });
    });
  });
  seriesSwiperObserver.observe(document.body, { childList: true, subtree: true });
});

function initSeriesSwiper(root) {
  // This site's Webflow runtime re-fires Webflow.push callbacks more than
  // once per page (confirmed 2026-08-27) — calling `new Swiper()` again on
  // an element that already has a live instance throws inside Swiper's own
  // internals (getComputedStyle on a stale/non-Element reference), which
  // used to also block every OTHER ttlr feature registered after this one
  // (see ttlrReady). Swiper stores its instance on the container element
  // itself once mounted — bail out if it's already there instead of
  // re-initializing.
  if (root.swiper) {
    console.log('[ttlr] series swiper: already initialized on this element, skipping re-init', root);
    return;
  }

  // Nav buttons are siblings of the swiper container (not descendants), so
  // scope the lookup to the shared parent first. The page-wide
  // .swiper-button-next/-prev fallback is deliberately restricted to the
  // hero series carousel (.ttlr_hero_series-wrap) — .ttlr_cms_series-wrapper
  // is reused by other carousels on the same page (Re-Watch, bookmarks), and
  // falling back to a page-wide lookup for those too would bind the SAME
  // shared buttons to multiple Swiper instances at once. A carousel outside
  // the hero wrap only gets nav buttons if it has its own local siblings.
  const scope = root.parentElement || document;
  const isHeroSeries = !!root.closest('.ttlr_hero_series-wrap');
  const nextEl = scope.querySelector('.swiper-button-next') || (isHeroSeries ? document.querySelector('.swiper-button-next') : undefined);
  const prevEl = scope.querySelector('.swiper-button-prev') || (isHeroSeries ? document.querySelector('.swiper-button-prev') : undefined);

  console.log('[ttlr] series swiper: initializing', root, '/ isHeroSeries', isHeroSeries, '/ next', nextEl, '/ prev', prevEl);

  // slidesPerView: 'auto' uses each .ttlr_cms_series-item's own CSS width —
  // that width needs to be set explicitly in Designer for this to size
  // correctly (unlike a fixed slidesPerView number, which doesn't need it).
  //
  // NOT running cssMode (2026-09-05, reverted): the Re-Watch outer
  // month-list carousel briefly ran in cssMode because its default
  // transform-based drag mechanic used to break the layout of the nested
  // per-month episode swiper living inside its slides (a transformed
  // ancestor becomes the containing block for position:absolute/fixed
  // descendants). That's no longer the mechanism in play — the OPEN month's
  // nested swiper is now physically relocated out of the slide into a
  // static slot the instant it opens (see initPrevContentCards below), so
  // it's never actually a descendant of this carousel's transformed wrapper
  // while visible/interactive. cssMode's own manual CSS replication (no
  // bundled Swiper CSS was loaded) introduced a real regression of its own
  // (overflow-x:auto forces overflow-y to clip too, cropping Designer's
  // .is-open/:hover scale(1.1) card effect) — reverted in favor of loading
  // Swiper's own bundled CSS instead (added directly in Webflow Custom Code
  // Head, outside this repo) plus a small override in sky-ttlr.css keeping
  // .swiper-button-prev/-next on Designer's own layout instead of Swiper's
  // default absolute-positioned arrow glyphs.
  // Hero carousel only: 'auto' sizes each slide from its own CSS width
  // instead of splitting evenly into a fixed count — paired with the
  // aspect-ratio: 16/9 rule on .ttlr_hero_series-wrap .ttlr_cms_series-item
  // in sky-ttlr.css, so each card's width is DERIVED from its height
  // rather than the other way around, keeping it genuinely 16:9 regardless
  // of viewport width. 'auto' mode naturally shows fewer cards on a
  // narrower viewport on its own, so no separate tablet breakpoint is
  // needed here (unlike the fixed-count carousels below).
  new Swiper(root, {
    slidesPerView: isHeroSeries ? 'auto' : 3,
    spaceBetween: 20,
    // Tablet shows 1.5 slides on the fixed-count carousels (a deliberate
    // "peek" of the next one) — breakpoint keys match Webflow's own
    // standard breakpoints (tablet is 768–991px; already visible elsewhere
    // on this page's own media queries). 992px+ reverts to the base 3-up
    // desktop view; anything below 768px (mobile) is untouched, still the
    // base slidesPerView. Not applied to the hero carousel — 'auto' mode
    // already adapts on its own.
    breakpoints: isHeroSeries ? undefined : {
      768: { slidesPerView: 1.5 },
      992: { slidesPerView: 3 },
    },
    navigation: (nextEl || prevEl) ? { nextEl, prevEl } : undefined,
  });
}

/* ---- Series cards: per-series completion badge on the home page carousel
   cards ("3/5" or "COMPLETED"), rolled up from the SAME ttl-progress Custom
   Field the episode router writes .series[seriesId].completedCount/total/
   completed into on every markComplete() call (see initEpisodeRouter above)
   — nothing series-specific is computed here, this just reads that rollup.
   Local-first like everything else: paints from localStorage instantly,
   then re-renders once Memberstack hydrates in the background. ---- */

ttlrReady('series card', function () {
  // data-series-id lives on .ttlr_badge (inside .ttlr_completion_tag-wrap),
  // NOT on .ttlr_series_card-wrap itself — confirmed via a live HTML dump
  // 2026-08-27 (an earlier version of this assumed the wrong element and
  // never matched anything on the live page).
  const badges = document.querySelectorAll('.ttlr_badge[data-series-id]');
  console.log('[ttlr] series card: found ' + badges.length + ' .ttlr_badge[data-series-id] element(s)');
  badges.forEach(initSeriesCard);
});

function initSeriesCard(badgeEl) {
  const PROGRESS_FIELD = 'ttl-progress';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';

  const seriesId = badgeEl.dataset.seriesId;
  // .ttlr_completion_tag-wrap is what actually gets hidden entirely for a
  // not-yet-started series — .ttlr_badge is just the pill inside it.
  const wrapEl = badgeEl.closest('.ttlr_completion_tag-wrap') || badgeEl;
  const textEl = badgeEl.querySelector('div') || badgeEl;
  // Optional mini fill bar on the card thumbnail — a sibling of this badge
  // inside the same .ttlr_series_card-wrap, not a descendant of it.
  const cardEl = badgeEl.closest('.ttlr_series_card-wrap');
  const fillEl = cardEl?.querySelector('.ttlr_series_card-inner');
  console.log('[ttlr] initSeriesCard: seriesId', seriesId, '/ wrap', wrapEl, '/ text el', textEl, '/ fill el', fillEl);

  function render(seriesProgress) {
    const entry = seriesProgress?.[seriesId];
    // Not started yet (no entry at all, or zero episodes completed) — hide
    // the badge entirely rather than showing Designer's static "Completed"
    // placeholder or a misleading "0/5".
    if (!entry || !entry.completedCount) {
      wrapEl.style.display = 'none';
      return;
    }
    wrapEl.style.display = '';
    textEl.textContent = entry.completed ? 'Completed' : `${entry.completedCount}/${entry.total} Completed`;
    cardEl?.classList.toggle('is-completed', !!entry.completed);
    if (fillEl && entry.total) fillEl.style.width = `${Math.min(100, (entry.completedCount / entry.total) * 100)}%`;
  }

  let local = {};
  try {
    local = JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
  } catch (err) {
    console.error('[ttlr] initSeriesCard: failed to read local progress cache', err);
  }
  render(local.series);

  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;
      const raw = member.customFields?.[PROGRESS_FIELD];
      if (!raw) return;
      const remote = JSON.parse(raw);
      render(remote.series);
    } catch (err) {
      console.error('[ttlr] initSeriesCard: failed to read remote progress', err);
    }
  });
}

/* ---- Re-Watch nested series card fill: the per-month episode cards inside
   .ttlr_prev-episodes_wrap (e.g. "Test Month 1 - Series 1") use the
   "previous-content" card variant, which has NO badge/data-series-id
   element at all (confirmed via a live HTML dump 2026-09-08) — unlike the
   home-page cards initSeriesCard handles above. That's why watching
   episodes there never moved anything here: nothing was watching these
   cards at all. Deliberately kept fully separate from initSeriesCard (a
   badge-INDEPENDENT version of this was attempted once before and broke
   the badge+fill for every card, home-page included, for a reason that was
   never diagnosed — this only ever touches .ttlr_series_card-inner on
   cards found inside .ttlr_prev-episodes_wrap specifically, and only ones
   that don't already have their own badge, so it can't ever run against
   the same element initSeriesCard does). Series id is derived from the
   card's own href (/serie/<slug>), same technique already proven safe in
   the read-only "prev-content month badge" feature below. ---- */

ttlrReady('prev-content series card fill', function () {
  const cards = Array.from(document.querySelectorAll('.ttlr_prev-episodes_wrap .ttlr_series_card-wrap'))
    .filter((card) => !card.querySelector('.ttlr_badge[data-series-id]'));
  console.log('[ttlr] prev-content series card fill: found ' + cards.length + ' badge-less card(s) inside .ttlr_prev-episodes_wrap');
  cards.forEach(initPrevContentSeriesCardFill);
});

function initPrevContentSeriesCardFill(cardEl) {
  const PROGRESS_FIELD = 'ttl-progress';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';

  let seriesId = null;
  try {
    const path = new URL(cardEl.href, window.location.origin).pathname;
    seriesId = path.match(/\/serie\/([^/]+)/)?.[1] || null;
  } catch (err) {
    console.error('[ttlr] prev-content series card fill: failed to derive seriesId from href', cardEl.href, err);
  }
  const fillEl = cardEl.querySelector('.ttlr_series_card-inner');
  console.log('[ttlr] prev-content series card fill: seriesId', seriesId, '/ fill el', fillEl, '/ card', cardEl);
  if (!seriesId || !fillEl) return;

  function render(seriesProgress) {
    const entry = seriesProgress?.[seriesId];
    if (!entry || !entry.total) return;
    fillEl.style.width = `${Math.min(100, (entry.completedCount / entry.total) * 100)}%`;
  }

  let local = {};
  try {
    local = JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
  } catch (err) {
    console.error('[ttlr] prev-content series card fill: failed to read local progress cache', err);
  }
  render(local.series);

  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;
      const raw = member.customFields?.[PROGRESS_FIELD];
      if (!raw) return;
      const remote = JSON.parse(raw);
      render(remote.series);
    } catch (err) {
      console.error('[ttlr] prev-content series card fill: failed to read remote progress', err);
    }
  });
}

/* ---- Series count label: #series-number shows how many series are in the
   CMS-bound list — content data (how many Series items exist here), not
   member progress, so this is independent of ttl-progress/localStorage.
   Independent of Swiper too (doesn't require it to have loaded/initialized).
   Counts .ttlr_cms_series-item directly (not scoped through
   .ttlr_cms_series-wrapper) — that wrapper class is ALSO used by the
   bookmarked-episodes carousel (see the "bookmarks list" section below),
   so a single querySelector('.ttlr_cms_series-wrapper') would be ambiguous
   about which one it found on a page with both. .ttlr_cms_series-item is
   unique to the real series list (bookmarks use .ttlr_cms_month-item). ---- */

ttlrReady('series count label', function () {
  const labelEl = document.querySelector('#series-number');
  const items = document.querySelectorAll('.ttlr_cms_series-item');
  console.log('[ttlr] series count label: #series-number', labelEl, '/ .ttlr_cms_series-item count', items.length);
  if (!labelEl) return;

  if (!items.length) {
    labelEl.style.display = 'none';
    return;
  }
  const textEl = labelEl.querySelector('div') || labelEl;
  textEl.textContent = `${items.length} Series`;
  console.log('[ttlr] series count label: wrote "' + textEl.textContent + '"');
});

/* ---- Bookmarked episodes carousel: clones a single Designer-authored
   template slide (.ttlr_cms_month-item, kept as the source — never itself
   shown) once per bookmark, filling in the SNAPSHOT data captured at
   bookmark time (see bookmarkDataFor in initEpisodeRouter above) — no live
   episode lookup needed, so this works on any page regardless of which
   episodes are actually rendered there. Completion state is read live from
   ttl-progress (not snapshotted), so a badge here can't go stale. ---- */

ttlrReady('bookmarks list', function () {
  // Scoped to #bookmarks specifically — .ttlr_cms_month-list is NOT unique
  // to this section (the Re-Watch carousel and its own per-month episode
  // lists all reuse the same class), confirmed via a live HTML dump
  // 2026-08-27. A page-wide querySelector would grab whichever one happens
  // to come first in the DOM, not necessarily this one.
  const listEl = document.querySelector('#bookmarks .ttlr_cms_month-list');
  const templateEl = listEl?.querySelector('.ttlr_cms_month-item');
  const sectionEl = document.querySelector('#bookmarks');
  console.log('[ttlr] bookmarks list: #bookmarks .ttlr_cms_month-list', listEl, '/ template item', templateEl, '/ section', sectionEl);
  if (!listEl || !templateEl) return;

  const BOOKMARKS_FIELD = 'ttl-bookmarks';
  const BOOKMARKS_LOCAL_KEY = 'ttlr-bookmarks-local';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';
  const PROGRESS_FIELD = 'ttl-progress';

  function normalizeBookmark(entry) {
    if (typeof entry === 'string') return { id: entry, title: '', month: '', imgSrc: '', imgSrcset: '', href: '' };
    return entry;
  }

  function loadLocalBookmarks() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(BOOKMARKS_LOCAL_KEY));
      return Array.isArray(parsed) ? parsed.map(normalizeBookmark) : [];
    } catch (err) {
      console.error('[ttlr] bookmarks list: failed to read local bookmarks cache', err);
      return [];
    }
  }

  function loadLocalCompletedIds() {
    try {
      const local = JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
      const episodes = local.episodes || {};
      return new Set(Object.keys(episodes).filter((id) => episodes[id]?.completed));
    } catch (err) {
      console.error('[ttlr] bookmarks list: failed to read local progress cache', err);
      return new Set();
    }
  }

  function removeBookmark(id) {
    const current = loadLocalBookmarks().filter((b) => b.id !== id);
    window.localStorage.setItem(BOOKMARKS_LOCAL_KEY, JSON.stringify(current));
    console.log('[ttlr] bookmarks list: removed bookmark', id, '-> local state now', current);

    // Same debounce-free, write-as-is approach as the main bookmark toggle
    // in initEpisodeRouter — no merge with remote on save, since a removal
    // is a real, intentional action that must not get resurrected by a
    // stale remote array.
    waitForMemberstack().then(async (ms) => {
      if (!ms) return;
      try {
        const { data: member } = await ms.getCurrentMember();
        if (!member) return;
        await ms.updateMember({ customFields: { [BOOKMARKS_FIELD]: JSON.stringify(current) } });
        console.log('[ttlr] bookmarks list: removal synced to Memberstack ->', current);
      } catch (err) {
        console.error('[ttlr] bookmarks list: failed to sync removal to Memberstack', err);
      }
    });

    return current;
  }

  function render(bookmarks, completedIds) {
    console.log('[ttlr] bookmarks list: rendering ' + bookmarks.length + ' bookmark(s)');
    // Whole section hidden, not just the list, when there's nothing to show.
    if (sectionEl) sectionEl.style.display = bookmarks.length ? '' : 'none';
    listEl.querySelectorAll('.ttlr_cms_month-item').forEach((el) => el.remove());

    bookmarks.forEach((bookmark) => {
      const card = templateEl.cloneNode(true);
      card.href = bookmark.href || '#';

      const imgEl = card.querySelector('img');
      if (imgEl && bookmark.imgSrc) {
        imgEl.src = bookmark.imgSrc;
        // The cloned template's own srcset (if any) takes priority over src
        // in the browser's image selection — left as-is, it would keep
        // showing the template's default image at matching viewport widths
        // even after src is updated. Overwrite it with the snapshotted
        // srcset (or clear it if none was captured) so src is what actually
        // renders.
        imgEl.srcset = bookmark.imgSrcset || '';
      }

      const monthEl = card.querySelector('[data-bookmark="month"]');
      if (monthEl) monthEl.textContent = bookmark.month || '';

      const episodeEl = card.querySelector('[data-bookmark="episode"]');
      if (episodeEl) episodeEl.textContent = bookmark.title || '';

      const tagWrapEl = card.querySelector('.ttlr_completion_tag-wrap');
      if (tagWrapEl) tagWrapEl.style.display = completedIds.has(bookmark.id) ? '' : 'none';

      const removeBtn = card.querySelector('[data-bookmark="btn"]');
      if (removeBtn) {
        // Every card here IS a bookmark by definition — always shown filled/
        // bookmarked, no outline-vs-filled toggle needed like the episode
        // page's own bookmark button. Designer styles .is-bookmarked however
        // it wants (fill color, background, etc.).
        removeBtn.classList.add('is-bookmarked');
        removeBtn.addEventListener('click', (evt) => {
          evt.preventDefault(); // the card itself is a link — don't navigate on remove
          evt.stopPropagation();
          render(removeBookmark(bookmark.id), completedIds);
        });
      }

      listEl.appendChild(card);
    });

    // Swiper mutates/measures slide DOM at mount — if it's already
    // initialized on this list (via initSeriesSwiper above, which targets
    // .ttlr_cms_series-wrapper generically and doesn't know or care that
    // this is the bookmarks list), it needs to be told the slide count
    // changed rather than left with stale internal measurements. If it was
    // NEVER initialized in the first place — e.g. the 'series swiper'
    // registration ran before this section had any real cards to measure —
    // initialize it now instead of silently leaving the list non-swiping
    // forever; initSeriesSwiper's own root.swiper guard makes this safe to
    // call every render() without ever double-initializing.
    const swiperRoot = listEl.closest('.swiper');
    if (swiperRoot) {
      if (swiperRoot.swiper) {
        swiperRoot.swiper.update();
      } else if (typeof Swiper !== 'undefined') {
        initSeriesSwiperSafe(swiperRoot);
      }
    }
  }

  render(loadLocalBookmarks(), loadLocalCompletedIds());

  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;

      const raw = member.customFields?.[BOOKMARKS_FIELD];
      if (raw) {
        const parsed = JSON.parse(raw);
        const remote = (Array.isArray(parsed) ? parsed : []).map(normalizeBookmark);
        // Union by id, local wins on conflict — same reasoning as the merge
        // in initEpisodeRouter's own hydrate step.
        const byId = new Map();
        remote.forEach((b) => byId.set(b.id, b));
        loadLocalBookmarks().forEach((b) => byId.set(b.id, b));
        const merged = Array.from(byId.values());
        window.localStorage.setItem(BOOKMARKS_LOCAL_KEY, JSON.stringify(merged));
        render(merged, loadLocalCompletedIds());
      }

      const progressRaw = member.customFields?.[PROGRESS_FIELD];
      if (progressRaw) {
        const remoteEpisodes = JSON.parse(progressRaw).episodes || {};
        const remoteCompleted = new Set(Object.keys(remoteEpisodes).filter((id) => remoteEpisodes[id]?.completed));
        render(loadLocalBookmarks(), remoteCompleted);
      }
    } catch (err) {
      console.error('[ttlr] bookmarks list: failed to hydrate from Memberstack', err);
    }
  });
});

/* ---- Prev-content expandable cards: clicking a .ttlr_card-wrap.is-rewatch
   opens its month's episode panel (.ttlr_prev-episodes_wrap) — accordion,
   only one open at a time. The panel lives inside .ttlr_cms_month-item,
   which is itself a swiper-slide of the Re-Watch month-list carousel — as a
   DOM descendant it scrolls/moves along with that slide no matter what
   Swiper mode is used, but the design needs it fixed in place regardless of
   carousel position (confirmed 2026-09-05 via a design comparison + live
   devtools). The only way to make it truly unmovable is to physically
   relocate it OUT of the sliding structure on open, into a static slot
   that's a SIBLING of the swiper root — never a descendant of anything
   Swiper transforms or scrolls — and move it back to its original slide
   position on close. Wrapped in ttlrReady/guarded the same as every other
   feature in this file, since this site's Webflow runtime can re-fire
   Webflow.push callbacks more than once per page. ---- */

ttlrReady('prev-content cards', function () {
  if (document.body.dataset.ttlrPrevContentWired) {
    console.log('[ttlr] prev-content cards: already wired on this <body>, skipping re-run (this is where a stale/soft-navigated page would silently stop getting new behavior)');
    return;
  }
  document.body.dataset.ttlrPrevContentWired = 'true';

  const cards = document.querySelectorAll('.ttlr_card-wrap.is-rewatch');
  console.log('[ttlr] prev-content cards: wiring up, found ' + cards.length + ' .ttlr_card-wrap.is-rewatch element(s)');

  // One slot per Re-Watch carousel, created lazily right after the swiper
  // root (both children of .ttlr_prev-content_wrap) — reused across opens.
  function getSlot(monthItem) {
    const swiperRoot = monthItem.closest('.ttlr_cms_series-wrapper.swiper');
    const container = swiperRoot?.parentElement;
    if (!swiperRoot || !container) {
      console.warn('[ttlr] prev-content cards: could not find the Re-Watch swiper root (or its parent) as an ancestor of this month item — panel cannot be relocated', monthItem);
      return null;
    }
    let slot = container.querySelector(':scope > .ttlr_prev-content_slot');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'ttlr_prev-content_slot';
      swiperRoot.insertAdjacentElement('afterend', slot);
      console.log('[ttlr] prev-content cards: created .ttlr_prev-content_slot', slot);
    }
    return slot;
  }

  let openPanel = null; // { panel, originalParent, originalNextSibling, slot }
  // Bumped on every openMonth() call — lets a still-in-flight switch
  // recognize it's been superseded by an even newer click (e.g. the user
  // clicked a third month before the second's fade even finished) and skip
  // its own "show" step instead of fighting the newer one.
  let openSeq = 0;

  // Content-only fade (opacity) used when SWITCHING between two already-
  // open months — the slot itself stays at its full expanded height the
  // whole time, only the card content underneath fades out/in. Driven
  // entirely from JS inline styles (not a CSS class) so this doesn't
  // depend on any particular class the Designer-authored .is-open height
  // transition uses.
  const CONTENT_FADE_MS = 180;
  // The slot's OWN height transition — keep in sync with the
  // `.ttlr_prev-content_slot .ttlr_prev-episodes_wrap` transition duration
  // in sky-ttlr.css (450ms). Only ever triggered on a genuine first-open
  // (nothing was open before) or a genuine final close (nothing left open
  // after), never mid-switch. This is exactly that CSS duration, not extra
  // buffer on top of it — the panel is moved back to its original slide the
  // instant the collapse finishes, not noticeably before or after.
  const CLOSE_ANIMATION_MS = 450;
  // How long the slot's own height transition (see CLOSE_ANIMATION_MS
  // above) takes to fully expand on a first open — used to delay the
  // auto-scroll below until the slot has actually reached its final
  // height, not just started growing.
  const SLOT_EXPAND_MS = 450;

  function fadeOut(panel, onDone) {
    panel.style.transition = `opacity ${CONTENT_FADE_MS}ms ease`;
    panel.style.opacity = '0';
    window.setTimeout(onDone, CONTENT_FADE_MS);
  }

  function fadeIn(panel) {
    panel.style.opacity = '0';
    void panel.offsetWidth; // force a reflow so the fade-in actually animates from 0
    panel.style.transition = `opacity ${CONTENT_FADE_MS}ms ease`;
    panel.style.opacity = '1';
  }

  function clearFadeStyles(panel) {
    panel.style.opacity = '';
    panel.style.transition = '';
  }

  function openMonth(monthItem) {
    const panel = monthItem.querySelector(':scope > .ttlr_prev-episodes_wrap');
    const slot = getSlot(monthItem);
    console.log('[ttlr] prev-content cards: openMonth', monthItem, '/ panel found', !!panel, '/ slot found', !!slot);
    if (!panel || !slot) return;

    openSeq++;
    const seq = openSeq;

    // Clean up any OTHER stray .is-open item (e.g. from static markup shipping
    // more than one) that isn't the one we're precisely tracking below — that
    // one's removal is deferred to the moment its panel actually leaves, not
    // done here.
    document.querySelectorAll('.ttlr_cms_month-item.is-open').forEach((item) => {
      if (item === monthItem) return;
      if (openPanel && item === openPanel.originalParent) return;
      item.classList.remove('is-open');
    });

    function showNewPanel() {
      if (seq !== openSeq) return; // superseded by an even newer click meanwhile
      // Only flip .is-open on the row at the SAME instant the panel actually
      // leaves it for the slot — the page has its OWN Designer-authored CSS
      // keyed off `.ttlr_cms_month-item.is-open .ttlr_prev-episodes_wrap`
      // (separate from our slot-scoped rule below). Flipping this any
      // earlier (e.g. up front, before the panel has moved) lets that rule
      // match while the panel is still sitting in its original row and
      // animate it open IN PLACE, right before we yank it into the slot —
      // that's the visible "jump" this whole function exists to avoid.
      monthItem.classList.add('is-open'); // still drives the card's own highlight styling
      openPanel = { panel, originalParent: monthItem, originalNextSibling: panel.nextSibling, slot };
      slot.classList.add('is-open'); // expands the slot itself — a no-op if it's already expanded
      slot.appendChild(panel);
      fadeIn(panel);
      console.log('[ttlr] prev-content cards: panel relocated into slot', panel, '->', slot);
    }

    if (!openPanel) {
      showNewPanel(); // nothing was open — slot expands + content fades in together
      // Genuine first open only (not a switch between two already-open
      // months, which the user can already see) — the expanded panel can
      // land below the viewport with nothing to suggest anything happened,
      // so nudge the page down once the slot has actually finished
      // expanding to its full height.
      window.setTimeout(() => {
        if (seq !== openSeq) return; // superseded by a newer click meanwhile
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, SLOT_EXPAND_MS);
      return;
    }

    // Something else is already open: fade its content out and restore it
    // to its original slide position, WITHOUT touching the slot's own
    // height/'.is-open' at all, then fade the new one in — the slot stays
    // at full height the entire time; only the content underneath swaps.
    const old = openPanel;
    openPanel = null;
    // Removed instantly, right on click — safe even though the panel itself
    // isn't moved back out of the slot until after the fade: the panel isn't
    // a descendant of this row again until that later insertBefore, so
    // Designer's `.ttlr_cms_month-item.is-open .ttlr_prev-episodes_wrap`
    // rule has nothing to match here either way.
    old.originalParent.classList.remove('is-open');
    fadeOut(old.panel, () => {
      old.originalParent.insertBefore(old.panel, old.originalNextSibling);
      clearFadeStyles(old.panel);
      showNewPanel();
    });
  }

  function closeMonth(monthItem) {
    monthItem.classList.remove('is-open'); // instant, right on click — see the note in openMonth's switch branch for why this is safe before the panel actually moves back
    if (!openPanel) return;
    const { panel, originalParent, originalNextSibling, slot } = openPanel;
    openPanel = null;
    // Genuine final close (nothing opening after this one) — fade the
    // content out first, THEN collapse the slot's own height, so the box
    // doesn't visibly shrink around still-visible content.
    fadeOut(panel, () => {
      slot.classList.remove('is-open');
      window.setTimeout(() => {
        originalParent.insertBefore(panel, originalNextSibling);
        clearFadeStyles(panel);
      }, CLOSE_ANIMATION_MS);
    });
  }

  cards.forEach((card) => {
    card.addEventListener('click', function () {
      const monthItem = this.closest('.ttlr_cms_month-item');
      if (!monthItem) return;
      if (monthItem.classList.contains('is-open')) {
        closeMonth(monthItem);
      } else {
        openMonth(monthItem);
      }
    });
  });

  // Static Designer markup can ship with a month already marked .is-open by
  // default (confirmed present on the first month in a live dump) — sync
  // that to the relocated-panel behavior on load too, not just on click.
  const initiallyOpen = document.querySelector('.ttlr_cms_month-item.is-open');
  console.log('[ttlr] prev-content cards: initial sync, month already .is-open in static markup?', initiallyOpen);
  if (initiallyOpen) openMonth(initiallyOpen);
});

/* ---- Hero "Let's get started" / "Resume" button: if nothing's been
   started, shows "Let's get started" linking to the first series in the
   hero carousel. If some series has partial progress, shows "Resume:
   Series N EP{completedCount+1}" linking straight to that next episode
   (?episode= query param, same as the router already reads). Falls back
   to "Let's get started" if every series is either untouched or fully
   completed. Reads ttl-progress directly (local-first + Memberstack
   hydrate) rather than depending on initSeriesCard's own DOM mutations, so
   it doesn't matter which registration order the two run in. The series
   cards are only ever used here as a lookup table (href, displayed series
   number) — scoped to .ttlr_hero specifically, since .ttlr_cms_series-
   wrapper/.ttlr_series_card-wrap are reused by other sections on the same
   page (Re-Watch, bookmarks) that aren't relevant here. ---- */

ttlrReady('hero cta', function () {
  const btnEl = document.querySelector('.ttlr_hero .ttlr_hero_heading-wrap .secondary-button-link');
  // Structural, not class-based — the inner text div's class (previously
  // .body-body-medium) was removed from the Designer markup since this was
  // first written, confirmed via a live HTML dump 2026-08-27.
  const textEl = btnEl?.querySelector('.secondary-light-button > div');
  const cards = Array.from(document.querySelectorAll('.ttlr_hero .ttlr_cms_series-wrapper .ttlr_series_card-wrap'));
  console.log('[ttlr] hero cta: button', btnEl, '/ text el', textEl, '/ found ' + cards.length + ' series card(s)');
  if (!btnEl || !textEl || !cards.length) return;

  const PROGRESS_FIELD = 'ttl-progress';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';

  const seriesInfo = new Map();
  cards.forEach((card) => {
    const seriesId = card.querySelector('.ttlr_badge[data-series-id]')?.dataset.seriesId;
    if (!seriesId) return;
    const number = card.querySelectorAll('.series-number_wrap > div')[1]?.textContent.trim() || '';
    seriesInfo.set(seriesId, { href: card.href, number });
  });
  console.log('[ttlr] hero cta: seriesInfo keys (from each hero card\'s data-series-id) ->', Array.from(seriesInfo.keys()));

  function render(seriesProgress) {
    // Logged in full so a mismatch between a hero card's data-series-id and
    // whatever key the episode page actually wrote progress under (e.g. a
    // slug/casing difference) is visible directly, instead of just silently
    // falling through to "Let's get started" with no way to tell why.
    console.log('[ttlr] hero cta: render() called with seriesProgress ->', seriesProgress, '/ known series ids ->', Array.from(seriesInfo.keys()));
    let resumeSeriesId = null;
    let resumeEntry = null;
    for (const [seriesId] of seriesInfo) {
      const entry = seriesProgress?.[seriesId];
      console.log('[ttlr] hero cta: checking seriesId', JSON.stringify(seriesId), '-> progress entry', entry);
      if (entry && entry.completedCount > 0 && !entry.completed) {
        resumeSeriesId = seriesId;
        resumeEntry = entry;
        break; // first partially-started series in carousel order
      }
    }

    if (resumeSeriesId) {
      const info = seriesInfo.get(resumeSeriesId);
      const nextEpisode = resumeEntry.completedCount + 1;
      textEl.textContent = `Resume: S${info.number} EP${nextEpisode}`;
      const url = new URL(info.href, window.location.origin);
      url.searchParams.set('episode', nextEpisode);
      btnEl.href = url.toString();
    } else {
      textEl.textContent = "Let's get started";
      const firstCard = cards[0];
      if (firstCard) btnEl.href = firstCard.href;
    }
    console.log('[ttlr] hero cta: rendered ->', textEl.textContent, btnEl.href);
  }

  let local = {};
  try {
    local = JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
  } catch (err) {
    console.error('[ttlr] hero cta: failed to read local progress cache', err);
  }
  render(local.series);

  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;
      const raw = member.customFields?.[PROGRESS_FIELD];
      if (!raw) return;
      const remote = JSON.parse(raw);
      render(remote.series);
    } catch (err) {
      console.error('[ttlr] hero cta: failed to read remote progress', err);
    }
  });
});

/* ---- Prev-content month badge: .ttlr_completion_tag-wrap on each month's
   own .ttlr_card-wrap.is-rewatch is "Completed" in Designer's static
   markup unconditionally — this hides it unless EVERY series featured that
   month (the nested .ttlr_series_card-wrap cards inside its own
   .ttlr_prev-episodes_wrap) is fully completed. Read-only with respect to
   those nested cards — only their href is read (to derive each series id,
   same /serie/<slug> technique used elsewhere), nothing about them is
   written, so this can't interact with initSeriesCard or any other
   series-card feature the way the now-reverted fill-bar attempt did. ---- */

ttlrReady('prev-content month badge', function () {
  const monthItems = Array.from(document.querySelectorAll('.ttlr_prev-content_wrap .ttlr_cms_month-item'));
  console.log('[ttlr] prev-content month badge: found ' + monthItems.length + ' .ttlr_cms_month-item element(s)');
  if (!monthItems.length) return;

  const entries = monthItems
    .map((monthItem) => {
      const badgeEl = monthItem.querySelector(':scope > .ttlr_card-wrap.is-rewatch > .ttlr_completion_tag-wrap');
      const seriesIds = Array.from(monthItem.querySelectorAll('.ttlr_prev-episodes_wrap .ttlr_series_card-wrap'))
        .map((card) => {
          try {
            const path = new URL(card.href, window.location.origin).pathname;
            return path.match(/\/serie\/([^/]+)/)?.[1] || null;
          } catch (err) {
            return null;
          }
        })
        .filter(Boolean);
      return { badgeEl, seriesIds };
    })
    .filter((entry) => entry.badgeEl && entry.seriesIds.length);
  console.log('[ttlr] prev-content month badge: ' + entries.length + ' month(s) with a badge + series id(s)', entries);
  if (!entries.length) return;

  const PROGRESS_FIELD = 'ttl-progress';
  const PROGRESS_LOCAL_KEY = 'ttlr-progress-local';

  function render(seriesProgress) {
    entries.forEach(({ badgeEl, seriesIds }) => {
      const allComplete = seriesIds.every((id) => seriesProgress?.[id]?.completed);
      badgeEl.style.display = allComplete ? '' : 'none';
    });
  }

  let local = {};
  try {
    local = JSON.parse(window.localStorage.getItem(PROGRESS_LOCAL_KEY)) || {};
  } catch (err) {
    console.error('[ttlr] prev-content month badge: failed to read local progress cache', err);
  }
  render(local.series);

  waitForMemberstack().then(async (ms) => {
    if (!ms) return;
    try {
      const { data: member } = await ms.getCurrentMember();
      if (!member) return;
      const raw = member.customFields?.[PROGRESS_FIELD];
      if (!raw) return;
      const remote = JSON.parse(raw);
      render(remote.series);
    } catch (err) {
      console.error('[ttlr] prev-content month badge: failed to read remote progress', err);
    }
  });
});

/* ---- Share link: [share-link="btn"] copies the current page URL to the
   clipboard and shows "Copied URL" in place of the button's own label for
   ~5s before reverting. ---- */

ttlrReady('share link', function () {
  const buttons = document.querySelectorAll('[share-link="btn"]');
  console.log('[ttlr] share link: found ' + buttons.length + ' [share-link="btn"] element(s)');

  const COPIED_RESET_MS = 5000;

  buttons.forEach((btn) => {
    // Prefer a nested text-bearing child (common Webflow pattern: an icon
    // next to a text div) so swapping the label doesn't wipe out an icon
    // that might live directly on the button itself.
    const textEl = Array.from(btn.children).find((el) => el.textContent.trim()) || btn;
    const originalText = textEl.textContent;
    let resetTimer = null;

    btn.addEventListener('click', async (event) => {
      // Guard against a bare <button> defaulting to type="submit" if it's
      // ever sitting inside a <form> — without this, a native form submit
      // could fire (and possibly navigate/reload) before the async
      // clipboard write below even resolves, which would look exactly like
      // "clicking does nothing."
      event.preventDefault();
      console.log('[ttlr] share link: clicked, copying', window.location.href);
      try {
        await navigator.clipboard.writeText(window.location.href);
      } catch (err) {
        console.error('[ttlr] share link: failed to copy URL to clipboard', err);
        return;
      }
      window.clearTimeout(resetTimer);
      textEl.textContent = 'URL Copied!';
      resetTimer = window.setTimeout(() => {
        textEl.textContent = originalText;
      }, COPIED_RESET_MS);
    });
  });
});
