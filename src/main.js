import { Actor } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add stealth plugin
chromium.use(StealthPlugin());

// ============================================
// FILTER AUTOMATION HELPERS
// ============================================

async function applyFilters(page, filters, searchRadius) {
    console.log('🎯 Applying UI filters...');

    if (!await setSearchRadius(page, searchRadius)) return false;
    if (!await applyBodyTypeFilter(page, filters.bodyTypes)) return false;
    if (filters.makes && filters.makes.length > 0) {
        if (!await applyMakeFilter(page, filters.makes)) return false;
    }
    if (!await applyPriceFilter(page)) return false;
    if (!await applyDealRatingFilter(page, filters.dealRatings)) return false;
    if (!await applySortByNewest(page)) return false;

    console.log('✅ All filters applied successfully!');
    return true;
}

async function ensureAccordionOpen(page, triggerSelector, contentSelector, name) {
    const trigger = page.locator(triggerSelector).first();
    const content = page.locator(contentSelector).first();

    await trigger.waitFor({ state: 'visible', timeout: 90000 });

    for (let attempt = 1; attempt <= 3; attempt++) {
        const triggerExpanded = await trigger.getAttribute('aria-expanded').catch(() => null);
        const contentState = await content.getAttribute('data-state').catch(() => null);

        if (triggerExpanded === 'true' || contentState === 'open') {
            console.log(`  ✅ ${name} accordion is open`);
            return true;
        }

        await trigger.scrollIntoViewIfNeeded({ timeout: 10000 });
        await trigger.click({ timeout: 10000, force: true });
        await page.waitForTimeout(800);

        const updatedExpanded = await trigger.getAttribute('aria-expanded').catch(() => null);
        const updatedContentState = await content.getAttribute('data-state').catch(() => null);

        if (updatedExpanded === 'true' || updatedContentState === 'open') {
            console.log(`  ✅ Opened ${name} accordion`);
            return true;
        }
    }

    throw new Error(`${name} accordion did not open`);
}

async function findDistanceDropdown(page) {
    const selectors = [
        'select[data-testid="select-filter-distance"]',
        'select[aria-label="Distance from me"]',
        'select',
    ];

    for (const selector of selectors) {
        const matches = page.locator(selector);
        const count = await matches.count();

        for (let i = 0; i < count; i++) {
            const locator = matches.nth(i);

            try {
                await locator.waitFor({ state: 'visible', timeout: 3000 });

                const optionInfo = await locator.evaluate((select) =>
                    Array.from(select.options).map((option) => ({
                        value: option.value,
                        label: option.getAttribute('label'),
                        ariaLabel: option.getAttribute('aria-label'),
                        text: option.textContent.trim(),
                    }))
                );

                const hasExpectedOption = optionInfo.some((option) =>
                    option.value === '50000' ||
                    option.label?.toLowerCase() === 'nationwide' ||
                    option.ariaLabel?.toLowerCase() === 'nationwide' ||
                    option.text?.toLowerCase() === 'nationwide'
                );

                if (!hasExpectedOption) continue;

                console.log(`  ✅ Found distance dropdown using selector: ${selector}`);
                console.log(`  🔎 Distance options: ${JSON.stringify(optionInfo)}`);
                return locator;
            } catch (_) {
                // Try next visible match
            }
        }
    }

    return null;
}

async function setSearchRadius(page, searchRadius) {
    try {
        console.log(`🌍 Setting search radius to: ${searchRadius === 50000 ? 'Nationwide' : searchRadius + ' km'}`);

        const dropdown = await findDistanceDropdown(page);

        if (!dropdown) {
            throw new Error('Could not find distance dropdown using any known selector');
        }

        const options = await dropdown.evaluate((select) =>
            Array.from(select.options).map((option) => ({
                value: option.value,
                label: option.getAttribute('label'),
                ariaLabel: option.getAttribute('aria-label'),
                text: option.textContent.trim(),
            }))
        );

        let optionValue = searchRadius.toString();

        if (searchRadius === 50000) {
            const nationwideOption = options.find((option) =>
                option.value === '50000' ||
                option.label?.toLowerCase() === 'nationwide' ||
                option.ariaLabel?.toLowerCase() === 'nationwide' ||
                option.text?.toLowerCase() === 'nationwide'
            );

            if (!nationwideOption) {
                throw new Error(`Nationwide option not found. Available options: ${JSON.stringify(options)}`);
            }

            optionValue = nationwideOption.value;
            console.log(`  🌍 Nationwide option resolved to value: ${optionValue}`);
        }

        await dropdown.selectOption(optionValue, { timeout: 90000 });
        await page.waitForTimeout(2000);

        const selectedValue = await dropdown.inputValue();

        if (selectedValue !== optionValue) {
            throw new Error(`Distance dropdown value mismatch. Expected ${optionValue}, got ${selectedValue}`);
        }

        console.log(`  ✅ Search radius set successfully: ${selectedValue}`);
        return true;

    } catch (error) {
        console.log(`  ❌ Search radius failed: ${error.message}`);

        try {
            await Actor.setValue(
                `debug-distance-dropdown-${Date.now()}.png`,
                await page.screenshot({ fullPage: true }),
                { contentType: 'image/png' }
            );
        } catch (_) {}

        return false;
    }
}

// ============================================================
// DETACH-PROOF CHECKBOX FALLBACK (failure-mode #1)
// ------------------------------------------------------------
// CarGurus re-renders the filter panel (live result counts) while we interact
// with it. That detaches the element mid-action, so the normal
// scrollIntoViewIfNeeded()+click throws "element is not stable / not attached
// to the DOM" and the whole filter attempt aborts. This fallback never holds a
// handle across a re-render: it re-locates the checkbox fresh on every attempt,
// scrolls via raw DOM (no stability wait), force-clicks, then re-reads the
// state from a fresh locator. Only invoked AFTER the normal path has thrown, so
// the happy path is left exactly as it was.
// ============================================================
async function clickCheckboxDetachProof(page, selector, name, maxAttempts = 6) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const cb = page.locator(selector).first();
            await cb.waitFor({ state: 'attached', timeout: 15000 });

            const before = await cb.getAttribute('aria-checked').catch(() => null);
            if (before === 'true') {
                console.log(`  ✅ [detach-proof] ${name} already selected`);
                return true;
            }

            // Raw-DOM scroll cannot throw "element is not stable"; then force-click.
            await cb.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
            await cb.click({ timeout: 8000, force: true });
            await page.waitForTimeout(600);

            // Re-read from a FRESH locator — the clicked handle may be detached.
            const after = await page.locator(selector).first()
                .getAttribute('aria-checked').catch(() => null);
            if (after === 'true') {
                console.log(`  ✅ [detach-proof] ${name} selected (attempt ${attempt}/${maxAttempts})`);
                return true;
            }

            console.log(`  ⚠️ [detach-proof] ${name} still ${after} after attempt ${attempt}/${maxAttempts} — retrying`);
        } catch (err) {
            console.log(`  ⚠️ [detach-proof] ${name} attempt ${attempt}/${maxAttempts} threw: ${err.message} — re-locating`);
        }

        await page.waitForTimeout(700);
    }

    console.log(`  ❌ [detach-proof] ${name} could not be selected after ${maxAttempts} attempts`);
    return false;
}

async function applyBodyTypeFilter(page, bodyTypes) {
    try {
        console.log(`🚗 Setting body types: ${bodyTypes.join(', ')}`);

        await ensureAccordionOpen(page, '#BodyStyle-accordion-trigger', '#BodyStyle-accordion-content', 'Body Style');

        const clickCheckboxByAriaLabelContains = async (groupName, labelText) => {
            // Classic aria-label form stays FIRST, so a healthy run resolves on the
            // first probe and behaves exactly as it always has. The rest cover the
            // redesigned panel, where body types are keyed by group id
            // (bodyTypeGroupIds=7,5 → 7 = SUV / Crossover, 5 = Pickup Truck) and the
            // aria-label we key on today may not be present at all.
            const groupId = labelText.includes('SUV') ? '7'
                : labelText.includes('Pickup') ? '5'
                : null;

            const candidates = [
                `button[role="checkbox"][aria-label*="${labelText}"]`,
                ...(groupId ? [
                    `[data-testid="checkbox-FILTER.BODY_TYPE_GROUP.${groupId}"]`,
                    `button[role="checkbox"][id="FILTER.BODY_TYPE_GROUP.${groupId}"]`,
                    `[data-testid*="BODY_TYPE_GROUP.${groupId}"]`,
                ] : []),
                `button[role="checkbox"][aria-label*="${labelText.split(' / ')[0]}"]`,
            ];

            // The classic selector keeps a generous budget so a slow-rendering panel
            // still resolves exactly as it did before; the added fallbacks only need
            // a short probe, since by then the panel has demonstrably rendered.
            const probe = async (firstTimeout, restTimeout) => {
                for (const [i, cand] of candidates.entries()) {
                    const hit = await page.locator(cand).first()
                        .waitFor({ state: 'attached', timeout: i === 0 ? firstTimeout : restTimeout })
                        .then(() => true)
                        .catch(() => false);
                    if (hit) return cand;
                }
                return null;
            };

            let selector = await probe(30000, 5000);
            if (!selector) {
                // Nothing matched. Same lazily-mounted-accordion problem the Price
                // drops filter hits — expand the panel and probe once more.
                console.log(`  ⚠️ ${groupName}: ${labelText} not in the DOM — expanding filter sections and retrying`);
                if (await expandFilterSections(page)) {
                    selector = await probe(5000, 3000);
                }
            }

            const resolved = selector !== null;
            if (!resolved) {
                // Record what the panel really looks like so the next occurrence
                // gives us the selector instead of another guess.
                await captureVariantDiagnostics(page, `bodytype-missing-${labelText.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
                selector = candidates[0];
            } else if (selector !== candidates[0]) {
                console.log(`  ℹ️ ${groupName}: ${labelText} resolved via fallback selector: ${selector}`);
            }

            // ---- PRIMARY PATH (unchanged — this is what works on a good run) ----
            try {
                const checkbox = page.locator(selector).first();

                // Already proved attached above when resolved, so the long timeout
                // costs nothing on a good run. When nothing matched, fail in 5s
                // instead of burning 90s on a selector that cannot succeed.
                await checkbox.waitFor({ state: 'attached', timeout: resolved ? 90000 : 5000 });
                await checkbox.scrollIntoViewIfNeeded({ timeout: 10000 });

                const checkedBefore = await checkbox.getAttribute('aria-checked');
                if (checkedBefore === 'true') {
                    console.log(`  ✅ ${groupName}: ${labelText} already selected`);
                    return true;
                }

                await checkbox.click({ timeout: 30000, force: true });
                await page.waitForTimeout(700);

                const checkedAfter = await checkbox.getAttribute('aria-checked');
                if (checkedAfter !== 'true') {
                    throw new Error(`${groupName}: clicked ${labelText}, but aria-checked is ${checkedAfter}`);
                }

                console.log(`  ✅ ${groupName}: Added ${labelText}`);
                return true;
            } catch (primaryError) {
                // ---- FALLBACK: panel re-rendered and detached the element ----
                // Only worth the 6 x 15s retry cycle if we know some selector does
                // resolve — that is the transient detach this fallback exists for.
                // If nothing ever matched, retrying cannot help, so fail fast.
                if (!resolved) {
                    throw new Error(`${groupName}: ${labelText} checkbox is not present in the panel (no known selector matched)`);
                }
                console.log(`  ⚠️ ${groupName}: ${labelText} primary click failed (${primaryError.message}) — engaging detach-proof fallback`);
                const ok = await clickCheckboxDetachProof(page, selector, `${groupName}: ${labelText}`);
                if (!ok) {
                    throw new Error(`${groupName}: ${labelText} could not be selected (primary + fallback both failed)`);
                }
                return true;
            }
        };

        for (const bodyType of bodyTypes) {
            if (bodyType.includes('SUV')) {
                await clickCheckboxByAriaLabelContains('Body type', 'SUV / Crossover');
            }

            if (bodyType.includes('Pickup')) {
                await clickCheckboxByAriaLabelContains('Body type', 'Pickup Truck');
            }
        }

        await page.waitForTimeout(2000);
        return true;
    } catch (error) {
        console.log(`  ❌ Body type filter failed: ${error.message}`);
        return false;
    }
}

function normalizeMakeName(make) {
    const map = {
        ram: 'RAM',
        gmc: 'GMC',
        bmw: 'BMW',
        fiat: 'FIAT',
        mini: 'MINI',
        infiniti: 'INFINITI',
        'alfa romeo': 'Alfa_Romeo',
        'land rover': 'Land_Rover',
        'mercedes benz': 'Mercedes-Benz',
        'mercedes-benz': 'Mercedes-Benz',
    };

    const key = make.trim().toLowerCase();
    return map[key] || make.trim().replace(/\s+/g, '_');
}

async function clickMakeCheckbox(page, make) {
    const normalizedMake = normalizeMakeName(make);

    const selectors = [
        `button[data-testid="checkbox-FILTER.MAKE_MODEL.${normalizedMake}"]`,
        `button[data-cg-ft="checkbox-FILTER.MAKE_MODEL.${normalizedMake}"]`,
        `button[id="FILTER.MAKE_MODEL.${normalizedMake}"]`,
        `button[role="checkbox"][aria-label="${make}"]`,
        `button[role="checkbox"][aria-label="${normalizedMake}"]`,
        `label:has-text("${make}")`,
        `label:has-text("${normalizedMake}")`,
    ];

    for (const selector of selectors) {
        const locator = page.locator(selector).first();

        try {
            await locator.waitFor({ state: 'attached', timeout: 3000 });
            await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
            await page.waitForTimeout(300);

            const checkbox = page.locator(`button[role="checkbox"][id="FILTER.MAKE_MODEL.${normalizedMake}"]`).first();
            const checkedBefore = await checkbox.getAttribute('aria-checked').catch(() => null);

            if (checkedBefore === 'true') {
                console.log(`  ✅ ${make} already selected`);
                return true;
            }

            await locator.click({ timeout: 10000, force: true });
            await page.waitForTimeout(700);

            const checkedAfter = await checkbox.getAttribute('aria-checked').catch(() => null);

            if (checkedAfter === 'true') {
                console.log(`  ✅ Added ${make} using selector: ${selector}`);
                return true;
            }

            console.log(`  ⚠️ Clicked ${make}, but checkbox state is still: ${checkedAfter}`);
        } catch (_) {
            // Try next selector
        }
    }

    // FALLBACK: every known selector failed — most likely the panel re-rendered
    // and detached the element mid-action (same failure-mode #1 as body type).
    // Only runs after the normal path is already exhausted, so it can't affect
    // a good run.
    console.log(`  ⚠️ ${make}: all selectors failed — engaging detach-proof fallback`);
    const idSelector = `button[role="checkbox"][id="FILTER.MAKE_MODEL.${normalizedMake}"]`;
    if (await clickCheckboxDetachProof(page, idSelector, make)) {
        return true;
    }

    return false;
}

async function applyMakeFilter(page, makes) {
    try {
        console.log(`🏭 Setting makes: ${makes.join(', ')}`);

        await ensureAccordionOpen(page, '#MakeAndModel-accordion-trigger', '#MakeAndModel-accordion-content', 'Make & Model');

        const showAllMakesButton = page.locator('button:has-text("Show all makes")').first();
        if (await showAllMakesButton.isVisible().catch(() => false)) {
            await showAllMakesButton.click({ timeout: 5000 });
            await page.waitForTimeout(1000);
            console.log('  ✅ Expanded make list');
        }

        await page.locator('#FILTER\\.MAKE_MODEL, ul[id="FILTER.MAKE_MODEL"]').first()
            .waitFor({ state: 'visible', timeout: 90000 });

        for (const make of makes) {
            const success = await clickMakeCheckbox(page, make);

            if (!success) {
                console.log(`  ❌ Could not click ${make}`);

                const availableMakes = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('button[role="checkbox"][id^="FILTER.MAKE_MODEL."]'))
                        .map((button) => ({
                            id: button.id,
                            ariaLabel: button.getAttribute('aria-label'),
                            checked: button.getAttribute('aria-checked'),
                            visibleText: button.closest('li')?.textContent?.trim(),
                        }));
                });

                console.log(`  🔎 Available makes: ${JSON.stringify(availableMakes)}`);
                return false;
            }

            await page.waitForTimeout(800);
        }

        await page.waitForTimeout(2500); // Wait for results to update
        return true;
    } catch (error) {
        console.log(`  ❌ Make filter failed: ${error.message}`);
        return false;
    }
}

async function applyPriceFilter(page) {
    try {
        console.log(`💰 Setting minimum price to: $35,000 CAD`);

        await ensureAccordionOpen(page, '#Price-accordion-trigger', '#Price-accordion-content', 'Price');

        // Find the MINIMUM slider specifically (not maximum)
        const minSlider = page.locator('[role="slider"][aria-label="Minimum"]');
        await minSlider.waitFor({ state: 'visible', timeout: 90000 });

        // Click on the minimum slider to focus it
        await minSlider.click({ timeout: 90000 });
        await page.waitForTimeout(500);

        // Set the slider value to 24 (which equals $35,000 CAD)
        // Using keyboard arrow keys: press Home to go to 0, then Right arrow 24 times
        await page.keyboard.press('Home'); // Reset to 0
        await page.waitForTimeout(300);

        // Press Right arrow 24 times to reach position 24 ($35,000)
        for (let i = 0; i < 24; i++) {
            await page.keyboard.press('ArrowRight');
            await page.waitForTimeout(50); // Small delay between presses
        }

        console.log(`  ✅ Minimum price set to $35,000`);
        await page.waitForTimeout(2000); // Wait for results to update
        return true;

    } catch (error) {
        console.log(`  ❌ Price filter failed: ${error.message}`);
        return false;
    }
}

async function applyDealRatingFilter(page, dealRatings) {
    try {
        console.log(`⭐ Setting deal ratings: ${dealRatings.join(', ')}`);

        await ensureAccordionOpen(page, '#DealRating-accordion-trigger', '#DealRating-accordion-content', 'Deal Rating');

        // Click checkboxes for each deal rating
        for (const rating of dealRatings) {
            try {
                // Click with 6-minute timeout
                await page.click(`#FILTER\\.DEAL_RATING\\.${rating}`, { timeout: 90000 });
                console.log(`  ✅ Added ${rating.replace('_', ' ')}`);
                await page.waitForTimeout(300);
            } catch (error) {
                console.log(`  ❌ Could not click ${rating}: ${error.message}`);
                return false;
            }
        }

        await page.waitForTimeout(2000); // Wait for results to update
        return true;
    } catch (error) {
        console.log(`  ❌ Deal rating filter failed: ${error.message}`);
        return false;
    }
}

async function applySortByNewest(page) {
    try {
        console.log(`🆕 Setting sort order to: Newest listings first`);

        // Click the sort dropdown button to open it
        const sortButton = page.locator('button[role="combobox"][aria-label="Sort by:"]');
        await sortButton.waitFor({ state: 'visible', timeout: 90000 });
        await sortButton.click({ timeout: 90000 });

        console.log(`  ✅ Opened sort dropdown`);
        await page.waitForTimeout(1000);

        // Click the actual dropdown option (div with role="option")
        await page.click('div[role="option"]:has-text("Newest listings first")', { timeout: 90000 });

        console.log(`  ✅ Selected "Newest listings first"`);
        await page.waitForTimeout(2000); // Wait for results to update
        return true;

    } catch (error) {
        console.log(`  ❌ Sort by newest failed: ${error.message}`);
        return false;
    }
}

// ============================================================
// SRP LAYOUT COMPATIBILITY (fallback-first)
// ------------------------------------------------------------
// As of Aug 2026 CarGurus serves two different search-results layouts to
// different sessions. Confirmed from live diagnostics — the redesigned page
// renders results and pagination perfectly, it just renamed the testids:
//
//   CLASSIC     cards  a[data-testid="car-blade-link"]
//               pager  button[data-testid="srp-desktop-page-navigation-next-page"]
//
//   REDESIGNED  cards  a[data-testid="tile-link"]   (inside srp-listing-tile)
//               pager  button[data-testid="page-navigation-next-page"]
//               also   page-navigation-last-page carries the true page count
//
// Everything below tries CLASSIC first and only falls through to REDESIGNED,
// so runs that work today keep taking exactly the same path.
// ============================================================

const LISTING_SELECTORS = [
    'a[data-testid="car-blade-link"]',   // classic — tried first, behaviour unchanged
    'a[data-testid="tile-link"]',        // redesigned SRP
];

const NEXT_BUTTON_SELECTOR =
    'button[data-testid="srp-desktop-page-navigation-next-page"], ' +
    'button[data-testid="page-navigation-next-page"]';

// Which card selector actually matches on this page? Returns the classic one
// with count 0 when neither matches, so callers always get a usable string.
async function resolveListingSelector(page) {
    for (const selector of LISTING_SELECTORS) {
        const count = await page
            .evaluate((s) => document.querySelectorAll(s).length, selector)
            .catch(() => 0);

        if (count > 0) {
            if (selector !== LISTING_SELECTORS[0]) {
                console.log(`  ℹ️ Redesigned SRP detected — using ${selector}`);
            }
            return { selector, count };
        }
    }
    return { selector: LISTING_SELECTORS[0], count: 0 };
}

// What page does the pager say we are on? null when it cannot be determined,
// in which case callers fall back to the previous (assumed) behaviour.
async function readCurrentPageFromDom(page) {
    return await page.evaluate(() => {
        const el = document.querySelector(
            '[data-testid^="page-navigation-page-"][class*="_selected_"], ' +
            '[data-testid^="srp-desktop-page-navigation-page-"][class*="_selected_"], ' +
            '[data-testid^="page-navigation-page-"][aria-current="true"], ' +
            '[data-testid^="srp-desktop-page-navigation-page-"][aria-current="true"]'
        );
        if (!el) return null;
        const n = parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }).catch(() => null);
}

// Total pages available for the current filter set. null when unavailable.
async function readTotalPagesFromDom(page) {
    return await page.evaluate(() => {
        const last = document.querySelector(
            'button[data-testid="page-navigation-last-page"], ' +
            'button[data-testid="srp-desktop-page-navigation-last-page"]'
        );
        if (last) {
            const n = parseInt((last.textContent || '').replace(/[^\d]/g, ''), 10);
            if (Number.isFinite(n) && n > 0) return n;
        }
        const nums = Array.from(document.querySelectorAll(
            '[data-testid^="page-navigation-page-"], ' +
            '[data-testid^="srp-desktop-page-navigation-page-"]'
        ))
            .map((el) => parseInt((el.textContent || '').replace(/[^\d]/g, ''), 10))
            .filter((n) => Number.isFinite(n) && n > 0);
        return nums.length ? Math.max(...nums) : null;
    }).catch(() => null);
}

// How many results does the SRP claim to have? Present on BOTH layouts, which
// makes it the only page-count signal we can rely on when the pager markup
// changes underneath us.
async function readResultCountFromDom(page) {
    return await page.evaluate(() => {
        const m = document.body.innerText.match(/([\d,]{2,})\s+(?:results|listings|matches)/i);
        if (!m) return null;
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }).catch(() => null);
}

// Are we sitting on the last page of the result set? A missing Next button only
// means "the end" when a pager is actually on screen — otherwise we cannot tell
// the end of results apart from a layout we do not recognise, and we return
// false so the caller keeps its existing behaviour.
async function isAtLastPage(page) {
    return await page.evaluate(() => {
        const next = document.querySelector(
            'button[data-testid="srp-desktop-page-navigation-next-page"], ' +
            'button[data-testid="page-navigation-next-page"]'
        );
        if (next
            && !next.disabled
            && next.getAttribute('aria-disabled') !== 'true'
            && !/_disabled_/.test((next.className || '').toString())) {
            return false;
        }
        const pagerPresent = !!document.querySelector(
            '[data-testid*="page-navigation-prev-page"], ' +
            '[data-testid*="page-navigation-first-page"], ' +
            '[data-testid*="page-navigation-page-"]'
        );
        return pagerPresent;
    }).catch(() => false);
}

// Identity of the listings currently rendered. Comparing this before and after a
// navigation attempt is the only layout-independent way to prove we actually
// moved — the pager cannot always be read, but the cards always can.
async function readPageFingerprint(page) {
    const { selector } = await resolveListingSelector(page);
    return await page.evaluate((s) => {
        const hrefs = Array.from(document.querySelectorAll(s))
            .slice(0, 3)
            .map((a) => a.getAttribute('href') || '');
        return hrefs.length ? hrefs.join('|') : null;
    }, selector).catch(() => null);
}

// Open every collapsed section in the filter panel. The redesigned SRP mounts
// accordion contents lazily, so a collapsed section's controls are absent from
// the DOM rather than merely hidden. Scoped to the panel so we can never click
// page chrome; a no-op when the panel cannot be identified.
async function expandFilterSections(page) {
    const panelSelectors = ['[data-testid="desktop-filters-panel"]', '[data-testid="accordion-wrapper"]'];
    let panel = null;
    for (const sel of panelSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count().then((n) => n > 0).catch(() => false)) {
            panel = loc;
            break;
        }
    }
    if (!panel) {
        console.log('  ℹ️ No filter panel container found — skipping section expansion');
        return false;
    }

    // Repeated passes: every click re-renders the list and invalidates the
    // indices we are iterating over.
    let opened = 0;
    for (let pass = 1; pass <= 3; pass++) {
        const triggers = panel.locator('button[aria-expanded="false"], [role="button"][aria-expanded="false"]');
        const count = await triggers.count().catch(() => 0);
        if (count === 0) break;

        let clickedThisPass = 0;
        for (let i = 0; i < count; i++) {
            const trigger = triggers.nth(i);
            try {
                if (await trigger.getAttribute('aria-expanded') !== 'false') continue;
                await trigger.scrollIntoViewIfNeeded({ timeout: 3000 });
                await trigger.click({ timeout: 3000, force: true });
                clickedThisPass++;
                opened++;
                await page.waitForTimeout(250);
            } catch (_) {
                // Detached mid-iteration — the next pass re-reads the list.
            }
        }
        if (clickedThisPass === 0) break;
    }

    if (opened > 0) {
        console.log(`  📂 Expanded ${opened} collapsed filter section(s)`);
        await page.waitForTimeout(1000);
        return true;
    }
    return false;
}

// ============================================================
// VARIANT DIAGNOSTICS (read-only — never throws, never alters flow)
// ------------------------------------------------------------
// CarGurus serves a redesigned SRP to a share of sessions. On that variant the
// results render fine but `a[data-testid="car-blade-link"]` and
// `button[data-testid="srp-desktop-page-navigation-next-page"]` do not exist,
// so the scraper sees an empty page. Screenshots proved the cars are there but
// can't tell us what to select. This dumps the page's ACTUAL selectors so we
// can target the new layout.
//
// Only called from paths that already failed, so it cannot affect a good run.
// Every failure is swallowed — diagnostics must never break a scrape.
// ============================================================
async function captureVariantDiagnostics(page, label) {
    try {
        const diag = await page.evaluate(() => {
            const out = {};

            // What the scraper looks for today
            out.scraperCardSelector = document.querySelectorAll('a[data-testid="car-blade-link"]').length;
            out.scraperNextButton = !!document.querySelector('button[data-testid="srp-desktop-page-navigation-next-page"]');

            // Page identity / block detection
            out.url = location.href;
            out.title = document.title;
            out.bodyChars = document.body.innerText.length;
            out.iframes = document.querySelectorAll('iframe').length;
            out.looksBlocked = /captcha|access denied|unusual traffic|are you a robot/i
                .test(document.body.innerText.slice(0, 4000));

            // Where CarGurus thinks we are (failing runs resolved to zip=20149 / Ashburn VA)
            const zipUrl = location.href.match(/[?&]zip=([^&]+)/);
            out.zipInUrl = zipUrl ? zipUrl[1] : null;

            // How many results the page claims to have
            const rc = document.body.innerText.match(/([\d,]{2,})\s+(?:results|listings|cars|matches)/i);
            out.resultCountText = rc ? rc[0] : null;

            // EVERY data-testid on the page, by frequency — the new card/pager
            // testids will stand out as high-count entries.
            const ids = {};
            document.querySelectorAll('[data-testid]').forEach((el) => {
                const k = el.getAttribute('data-testid');
                ids[k] = (ids[k] || 0) + 1;
            });
            // Cap raised from 60: sorting by frequency pushed every single-occurrence
            // filter testid (checkbox-FILTER.*) past the cut, which is exactly the
            // set we need to read the real selector back from.
            out.testIds = Object.entries(ids).sort((a, b) => b[1] - a[1]).slice(0, 400);

            // Every filter control in the panel, with enough attributes to build a
            // selector from without guessing. Also records which sections are open,
            // since the redesigned SRP does not mount a collapsed section's contents.
            out.filterControls = Array.from(document.querySelectorAll(
                '[role="checkbox"], input[type="checkbox"], [data-testid^="checkbox-"]'
            )).slice(0, 200).map((el) => ({
                tag: el.tagName.toLowerCase(),
                testid: el.getAttribute('data-testid'),
                id: el.getAttribute('id'),
                aria: el.getAttribute('aria-label'),
                checked: el.getAttribute('aria-checked'),
                text: (el.closest('li,label,div')?.textContent || '').trim().slice(0, 40),
            }));

            out.filterSections = Array.from(document.querySelectorAll('[aria-expanded], [data-state]'))
                .slice(0, 80)
                .map((el) => ({
                    tag: el.tagName.toLowerCase(),
                    testid: el.getAttribute('data-testid'),
                    id: el.getAttribute('id'),
                    expanded: el.getAttribute('aria-expanded'),
                    state: el.getAttribute('data-state'),
                    text: (el.textContent || '').trim().slice(0, 40),
                }));

            // Anchors that point at a vehicle detail page = the cards, whatever they're called now
            const vdpRe = /(inventorylisting|vdp\.action|\/Cars\/link\/|listingId=)/i;
            const cards = Array.from(document.querySelectorAll('a[href]'))
                .filter((a) => vdpRe.test(a.getAttribute('href') || ''));
            out.vdpAnchorCount = cards.length;
            out.vdpAnchorSample = cards.slice(0, 5).map((a) => ({
                href: (a.getAttribute('href') || '').slice(0, 120),
                testid: a.getAttribute('data-testid'),
                cls: (a.className || '').toString().slice(0, 100),
                dataAttrs: Array.from(a.attributes).map((x) => x.name).filter((n) => n.startsWith('data-')),
                parentTestid: a.parentElement ? a.parentElement.getAttribute('data-testid') : null,
                parentCls: a.parentElement ? (a.parentElement.className || '').toString().slice(0, 100) : null,
            }));

            // The first card's surrounding markup — shows us the wrapper to target
            out.firstCardHtml = cards[0] && cards[0].closest('article,li,div')
                ? cards[0].closest('article,li,div').outerHTML.slice(0, 1200)
                : null;

            // Anything that smells like pagination
            const pagerRe = /next|pagination|page-nav|paging/i;
            out.pagerCandidates = Array.from(document.querySelectorAll('button,a,nav,[role="navigation"]'))
                .filter((el) => {
                    const t = el.getAttribute('data-testid') || '';
                    const al = el.getAttribute('aria-label') || '';
                    const cl = (el.className || '').toString();
                    return pagerRe.test(t) || pagerRe.test(al) || pagerRe.test(cl);
                })
                .slice(0, 15)
                .map((el) => ({
                    tag: el.tagName.toLowerCase(),
                    testid: el.getAttribute('data-testid'),
                    aria: el.getAttribute('aria-label'),
                    cls: (el.className || '').toString().slice(0, 80),
                    text: (el.innerText || '').trim().slice(0, 30),
                    visible: el.getClientRects().length > 0,
                }));

            return out;
        });

        // Compact summary straight into the Apify run log (greppable, no KV needed)
        console.log(`  🔬 [diag:${label}] cardSel=${diag.scraperCardSelector} nextBtn=${diag.scraperNextButton} vdpAnchors=${diag.vdpAnchorCount} iframes=${diag.iframes} blocked=${diag.looksBlocked} zip=${diag.zipInUrl} results="${diag.resultCountText}"`);
        console.log(`  🔬 [diag:${label}] topTestIds=${JSON.stringify(diag.testIds.slice(0, 12))}`);
        // Surface the filter controls we actually care about straight in the log,
        // so the real selector is one grep away instead of a KV download.
        const wantRe = /price[\s_-]?drop|pickup|truck|suv|crossover|body/i;
        const hits = (diag.filterControls || []).filter((c) =>
            wantRe.test(`${c.testid} ${c.id} ${c.aria} ${c.text}`));
        if (hits.length > 0) {
            console.log(`  🔬 [diag:${label}] filterControls=${JSON.stringify(hits.slice(0, 12))}`);
        }
        const sectionHits = (diag.filterSections || []).filter((s) =>
            wantRe.test(`${s.testid} ${s.id} ${s.text}`));
        if (sectionHits.length > 0) {
            console.log(`  🔬 [diag:${label}] filterSections=${JSON.stringify(sectionHits.slice(0, 8))}`);
        }
        if (diag.vdpAnchorSample.length > 0) {
            console.log(`  🔬 [diag:${label}] cardAnchor=${JSON.stringify(diag.vdpAnchorSample[0])}`);
        }
        if (diag.pagerCandidates.length > 0) {
            console.log(`  🔬 [diag:${label}] pager=${JSON.stringify(diag.pagerCandidates.slice(0, 4))}`);
        }

        // Full dump + screenshot for offline analysis
        await Actor.setValue(`diag-${label}.json`, diag);
        await Actor.setValue(
            `diag-${label}.png`,
            await page.screenshot({ fullPage: false }),
            { contentType: 'image/png' }
        );
    } catch (err) {
        console.log(`  ⚠️ [diag:${label}] capture failed (ignored): ${err.message}`);
    }
}

// ============================================
// MAIN SCRAPER
// ============================================

await Actor.main(async () => {
    const input = await Actor.getInput();

    const {
        searchRadius = 50000,
        currentPage = null,
        maxPages = 73,
        maxResults = 24,
        filters = {
            makes: ['Ford', 'GMC', 'Chevrolet', 'Cadillac'],
            bodyTypes: ['SUV / Crossover', 'Pickup Truck'],
            maxMileage: 140000,
            minPrice: 35000,
            dealRatings: ['GREAT_PRICE', 'GOOD_PRICE', 'FAIR_PRICE']
        }
    } = input;

    console.log('🚀 Starting CarGurus Stealth Scraper with UI Filters...');

    // Open persistent Key-Value Store (survives between runs)
    const kv = await Actor.openKeyValueStore('scraper-state-newest');

    // Get or initialize page state with daily reset
    let startPage = currentPage;
    if (!startPage) {
        const state = await kv.getValue('state') || {};
        const today = new Date().toISOString().split('T')[0]; // "2025-11-13"

        // Check if we need to reset (new day or first run)
        if (state.lastScrapedDate === today) {
            // Same day → continue from where we left off
            startPage = state.nextPage || 1;

            // If we've exceeded maxPages, restart from page 1
            if (startPage > maxPages) {
                startPage = 1;
                console.log(`📅 All pages completed! Restarting from page 1 (same day: ${today})`);
            } else {
                console.log(`📅 Continuing from page ${startPage} (same day: ${today})`);
            }
        } else {
            // Different day or first run → reset to page 1
            startPage = 1;
            if (state.lastScrapedDate) {
                console.log(`📅 New day detected! Resetting to page 1 (previous: ${state.lastScrapedDate}, today: ${today})`);
            } else {
                console.log(`📅 First run! Starting from page 1`);
            }
        }
    }

    // Calculate the 3-page batch
    let pagesToScrape = [];
    for (let i = 0; i < 3; i++) {
        const pageNum = startPage + i;
        if (pageNum <= maxPages) {
            pagesToScrape.push(pageNum);
        }
    }

    // Safety check
    if (pagesToScrape.length === 0) {
        console.log(`✅ All pages scraped! (Last page: ${maxPages})`);
        return;
    }

    console.log(`📄 Scraping ${pagesToScrape.length} pages this run: ${pagesToScrape.join(', ')} of ${maxPages} total`);
    console.log(`🌍 Search radius: ${searchRadius === 50000 ? 'Nationwide' : searchRadius + ' km'}`);
    console.log(`📊 Max results per page: ${maxResults}`);

    const baseUrl = 'https://www.cargurus.ca/Cars/l-Used-SUV-Crossover-bg7';

    // Launch browser, apply filters — full browser restart on failure (up to 3 attempts)
    let browser, context, page;
    let filtersSucceeded = false;

    for (let filterAttempt = 1; filterAttempt <= 3; filterAttempt++) {
        // Fresh browser every attempt
        if (browser) {
            await browser.close().catch(() => {});
        }

        console.log(`\n🔄 Starting fresh browser (attempt ${filterAttempt}/3)...`);

        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
            ],
        });

        context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale: 'en-CA',
            timezoneId: 'America/Toronto',
            geolocation: { longitude: -79.3832, latitude: 43.6532 },
            permissions: ['geolocation'],
        });

        page = await context.newPage();

        try {
            console.log(`\n🌐 Visiting base page: ${baseUrl}`);
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

            console.log('⏳ Waiting for page to load...');
            await page.waitForTimeout(5000);

            console.log('🖱️ Simulating human behavior...');
            await page.mouse.move(100, 200);
            await page.waitForTimeout(500);
            await page.mouse.move(300, 400);
            await page.waitForTimeout(1000);

            const result = await applyFilters(page, filters, searchRadius);

            if (result) {
                filtersSucceeded = true;
                break;
            }
        } catch (e) {
            console.log(`  ❌ Browser attempt ${filterAttempt} crashed: ${e.message}`);
        }

        if (filterAttempt < 3) {
            console.log(`⚠️ Filter attempt ${filterAttempt}/3 failed — closing browser and starting fresh...`);
        } else {
            console.log(`❌ All 3 filter attempts failed — aborting run`);
        }
    }

    if (!filtersSucceeded) {
        if (browser) await browser.close().catch(() => {});
        console.log('🛑 Could not apply filters after 3 attempts. Will retry on next scheduled run.');
        return;
    }

    try {
        // STEP 3: Get the filtered URL with searchId
        const filteredUrl = page.url();
        const baseUrlWithFilters = filteredUrl.split('#')[0];

        console.log(`✅ Filters applied! Generated URL with searchId`);

        // Read back what the price slider ACTUALLY produced. The slider is driven by
        // counting arrow-key presses, so if CarGurus rescales it we would silently
        // filter at the wrong floor while still logging the intended number.
        const appliedMinPrice = (filteredUrl.match(/[?&]minPrice=(\d+)/) || [])[1];
        if (appliedMinPrice) {
            const applied = Number(appliedMinPrice);
            console.log(`💵 minPrice actually applied: $${applied.toLocaleString()}`);
            if (applied !== 35000) {
                console.log(`  ⚠️ PRICE DRIFT: intended $35,000 but the slider landed on $${applied.toLocaleString()} — the step scale has changed`);
            }
        } else {
            console.log(`💵 ⚠️ No minPrice in the URL — the price filter may not have applied at all`);
        }

        // The pager exposes the true page count. Clamp DOWNWARD only: we never
        // scrape beyond the configured maxPages, we just stop walking past the end
        // of the real results. If the pager can't be read, behaviour is unchanged.
        // Prefer the pager. When it cannot be read — which is exactly what happens
        // on the classic layout — derive the count from the "N results" text, which
        // both layouts render. Still a downward-only clamp either way: we never
        // scrape past the configured maxPages, we just stop walking off the end.
        let detectedTotalPages = await readTotalPagesFromDom(page);
        let pageCountSource = 'pager';
        if (!detectedTotalPages) {
            const resultCount = await readResultCountFromDom(page);
            if (resultCount) {
                detectedTotalPages = Math.ceil(resultCount / maxResults);
                pageCountSource = `${resultCount} results / ${maxResults} per page`;
            }
        }
        if (detectedTotalPages) {
            console.log(`📊 ${detectedTotalPages} total pages available via ${pageCountSource} (configured maxPages: ${maxPages})`);
            const dropped = pagesToScrape.filter((p) => p > detectedTotalPages);
            if (dropped.length > 0) {
                console.log(`  ⚠️ Dropping page(s) ${dropped.join(', ')} — past the last real page (${detectedTotalPages})`);
                pagesToScrape = pagesToScrape.filter((p) => p <= detectedTotalPages);
            }
            if (pagesToScrape.length === 0) {
                console.log(`✅ Reached the end of the results — resetting to page 1 for the next run`);
                await kv.setValue('state', {
                    nextPage: 1,
                    lastScrapedDate: new Date().toISOString().split('T')[0],
                    lastScraped: new Date().toISOString(),
                    reason: 'past-last-page-reset',
                });
            }
        }

        // Track current page (we start at page 1 after applying filters)
        let currentPageNumber = 1;

        // Every VIN saved during this run. Last line of defence against writing
        // the same car twice if pagination silently fails to advance.
        const seenVins = new Set();

        // STEP 4-7: Loop through each page in the batch (3 pages)
        for (const pageToScrape of pagesToScrape) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📄 Processing page ${pageToScrape} of ${maxPages}`);
            console.log(`${'='.repeat(60)}\n`);

            // Navigate to specific page if needed by clicking Next button (human-like)
            if (pageToScrape !== currentPageNumber) {
                const clicksNeeded = pageToScrape - currentPageNumber;
                let navigationFailed = false;
                let atEndOfResults = false;
                console.log(`🔄 Navigating from page ${currentPageNumber} to page ${pageToScrape} (${clicksNeeded} clicks)...`);

                for (let i = 0; i < clicksNeeded; i++) {
                    try {
                        // Scroll to bottom to make pagination visible
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await page.waitForTimeout(800);

                        // Wait for and click the Next button (2-minute timeout)
                        // Matches the classic testid first, then the redesigned one.
                        // On the redesigned layout this now resolves immediately instead
                        // of stalling for the full 120s and falling through to the
                        // (useless) hash fallback.
                        const nextButton = page.locator(NEXT_BUTTON_SELECTOR).first();
                        await nextButton.waitFor({ state: 'visible', timeout: 120000 });
                        await nextButton.click({ timeout: 120000 });

                        console.log(`  ✅ Clicked Next button (${i + 1}/${clicksNeeded})`);

                        // Wait for new page to load
                        await page.waitForTimeout(4000);
                    } catch (error) {
                        console.log(`  ⚠️ Next button click failed: ${error.message}`);

                        // DIAGNOSTIC ONLY — capture what this page actually looks like.
                        // A missing Next button is our earliest signal that we were served
                        // the redesigned SRP, and it fires before the hash fallback wrecks
                        // the DOM state, so this is the cleanest sample we can take.
                        await captureVariantDiagnostics(page, `nextbtn-fail-page${pageToScrape}`);

                        // Out of pages, or genuinely broken? A pager with no usable
                        // Next button but a working prev/first button means we have
                        // simply reached the last page of the result set. Walking
                        // further would re-scrape this page under a wrong number.
                        atEndOfResults = await isAtLastPage(page);

                        // Fingerprint the listings before we try to move, so we can
                        // prove afterwards whether anything actually changed.
                        const beforeNav = await readPageFingerprint(page);

                        // Fallback to hash navigation if Next button fails
                        console.log(`  🔄 Falling back to hash navigation...`);
                        await page.evaluate((pageNum) => {
                            window.location.hash = `resultsPage=${pageNum}`;
                        }, pageToScrape);
                        await page.waitForTimeout(5000);

                        // Same cards as before the jump = the hash was ignored. This
                        // is the check that stops the same listings being saved three
                        // times under three different page numbers.
                        const afterNav = await readPageFingerprint(page);
                        if (beforeNav && afterNav && beforeNav === afterNav) {
                            console.log(`  ❌ Hash navigation did not move the page — identical listings before and after`);
                            navigationFailed = true;
                        }

                        // Did it actually move? On the redesigned SRP the hash is ignored
                        // outright — confirmed live: after "navigating" to page 22 the pager
                        // still had page-1 selected and prev-page disabled. The real guard is
                        // the pager check after this block; this is here so the log says why.
                        const landedOn = await readCurrentPageFromDom(page);
                        if (landedOn !== null && landedOn !== pageToScrape) {
                            console.log(`  ❌ Hash navigation ignored — still on page ${landedOn}, wanted ${pageToScrape}`);
                        } else if (landedOn !== null) {
                            console.log(`  ✅ Hash navigation confirmed on page ${landedOn}`);
                        }
                        break; // Exit the clicking loop since we used hash navigation
                    }
                }

                // Scroll to top after navigation
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.waitForTimeout(1000);

                // Update current page tracker — but only if we actually arrived.
                // This used to be assigned unconditionally, so after a failed fallback
                // the scraper believed it was on page 22 while sitting on page 1, and
                // scraped page 1 repeatedly while labelling the rows 19/20/21.
                const confirmedPage = await readCurrentPageFromDom(page);
                if (confirmedPage !== null && confirmedPage !== pageToScrape) {
                    console.log(`  ⏭️ Expected page ${pageToScrape} but pager reports ${confirmedPage} — skipping so we don't save mislabelled rows`);
                    currentPageNumber = confirmedPage;
                    continue;
                }
                currentPageNumber = confirmedPage !== null ? confirmedPage : pageToScrape;

                // Past the last real page. Stop the batch and rewind to page 1 so
                // tomorrow's runs start from the top instead of grinding against
                // the tail forever.
                if (atEndOfResults) {
                    console.log(`✅ Page ${pageToScrape} is past the last page of results — stopping here and resetting to page 1`);
                    await kv.setValue('state', {
                        nextPage: 1,
                        lastScrapedDate: new Date().toISOString().split('T')[0],
                        lastScraped: new Date().toISOString(),
                        reason: 'reached-end-of-results',
                    });
                    break;
                }

                // We could not get to the page we were asked for. Skipping is the
                // whole point: scraping now would save this page's rows labelled
                // with a page number they do not belong to.
                if (navigationFailed) {
                    console.log(`  ⏭️ Could not reach page ${pageToScrape} — skipping so no mislabelled rows are saved`);
                    continue;
                }
            }

            // Scroll to load car links
            console.log('📜 Scrolling to load content...');
            for (let i = 0; i < 3; i++) {
                await page.evaluate((offset) => {
                    window.scrollTo({
                        top: offset,
                        behavior: 'smooth'
                    });
                }, (i + 1) * 1000);
                await page.waitForTimeout(2000);
            }

            await page.waitForTimeout(3000);

            // Count available car listings
            // Resolve the card selector for whichever layout we were served, and
            // reuse that same selector when reading hrefs below so the indexes can
            // never drift between the count and the extraction.
            const { selector: listingSelector, count: totalListings } = await resolveListingSelector(page);

            console.log(`🚗 Found ${totalListings} car listings on page ${pageToScrape}`);

            // Debug if no links found
            if (totalListings === 0) {
                console.log('⚠️ No car listings found - debugging...');
                const currentUrl = page.url();
                const pageTitle = await page.title();
                console.log(`📍 Current URL: ${currentUrl}`);
                console.log(`📄 Page title: ${pageTitle}`);

                await Actor.setValue(`debug-screenshot-page${pageToScrape}.png`, await page.screenshot({ fullPage: false }), { contentType: 'image/png' });

                // DIAGNOSTIC ONLY — the screenshot proves cars are on the page but
                // can't tell us what to select. This records the real selectors.
                await captureVariantDiagnostics(page, `zero-listings-page${pageToScrape}`);

                // Anti-wedge. A failed page deliberately does NOT advance nextPage, so
                // the next run retries it. That is right for a transient failure but it
                // used to mean a permanently broken page pinned the actor to the same
                // spot all day. After 3 strikes we step over it.
                try {
                    const prevState = (await kv.getValue('state')) || {};
                    const failures = { ...(prevState.failures || {}) };
                    failures[pageToScrape] = (failures[pageToScrape] || 0) + 1;
                    const todayStr = new Date().toISOString().split('T')[0];

                    if (failures[pageToScrape] >= 3) {
                        console.log(`  ⏭️ Page ${pageToScrape} has failed ${failures[pageToScrape]}x — advancing past it so the actor can't wedge`);
                        delete failures[pageToScrape];
                        await kv.setValue('state', {
                            ...prevState,
                            nextPage: pageToScrape + 1,
                            lastScrapedDate: todayStr,
                            lastScraped: new Date().toISOString(),
                            failures,
                        });
                    } else {
                        console.log(`  ↺ Page ${pageToScrape} failed (${failures[pageToScrape]}/3) — will retry next run`);
                        await kv.setValue('state', { ...prevState, lastScrapedDate: todayStr, failures });
                    }
                } catch (stateErr) {
                    console.log(`  ⚠️ Could not update failure state (ignored): ${stateErr.message}`);
                }

                continue; // Skip to next page
            }

            // Process listings by clicking them (SPA-compatible)
            const listingsToProcess = Math.min(totalListings, maxResults);
            console.log(`📋 Will process ${listingsToProcess} car listings`);

        for (let listingIndex = 0; listingIndex < listingsToProcess; listingIndex++) {
            console.log(`\n🔍 Processing listing ${listingIndex + 1}/${listingsToProcess}...`);

            let listingPage = null;
            try {
                // Get listing URL from main search tab (which stays open the whole time)
                const listingHref = await page.evaluate(({ index, sel }) => {
                    const links = document.querySelectorAll(sel);
                    return links[index] ? links[index].href : null;
                }, { index: listingIndex, sel: listingSelector });

                if (!listingHref) {
                    console.log(`  ⚠️ Listing ${listingIndex + 1} not found in DOM - skipping`);
                    continue;
                }

                // Open listing in a new tab — search results tab stays untouched
                listingPage = await context.newPage();
                await listingPage.goto(listingHref, { waitUntil: 'domcontentloaded', timeout: 90000 });
                await listingPage.waitForSelector('h1[data-cg-ft="vdp-listing-title"]', { timeout: 15000 });
                console.log(`  ✅ Detail page loaded`);

                // Small delay to let detail view fully render
                await listingPage.waitForTimeout(2000);

                // Extract data from the listing tab
                const carData = await listingPage.evaluate(() => {
                    const preflight = window.__PREFLIGHT__ || {};
                    const listing = preflight.listing || {};

                    const getFieldText = (fieldName) => {
                        const container = document.querySelector(`[data-cg-ft="${fieldName}"]`);

                        if (container) {
                            const spans = Array.from(container.querySelectorAll('span'))
                                .map((span) => span.textContent.trim())
                                .filter(Boolean);

                            if (spans.length > 0) {
                                return spans[spans.length - 1];
                            }
                        }

                        const legacyValue = document.querySelector(`div[data-cg-ft="${fieldName}"] span[class*="_value_"]`);
                        return legacyValue ? legacyValue.textContent.trim() : null;
                    };

                    const getPriceText = () => {
                        const selectors = [
                            'div[data-cg-ft="price"] h2',
                            'div[data-cg-ft="price"] [data-testid]',
                            'div[class*="_price_"] h2',
                            'h2[class*="price"]',
                        ];

                        for (const selector of selectors) {
                            const element = document.querySelector(selector);
                            const text = element ? element.textContent.trim() : null;
                            if (text) return text;
                        }

                        return null;
                    };

                    let vin = getFieldText('vin') || listing.vin || null;
                    if (!vin && listing.specs) {
                        const vinSpec = listing.specs.find(s => s.label && s.label.toLowerCase() === 'vin');
                        if (vinSpec) vin = vinSpec.value;
                    }

                    let fuelType = getFieldText('fuelType');
                    if (!fuelType && listing.specs) {
                        const fuelSpec = listing.specs.find(s =>
                            s.label && (s.label.toLowerCase().includes('fuel') || s.label.toLowerCase().includes('engine'))
                        );
                        if (fuelSpec) fuelType = fuelSpec.value;
                    }

                    const titleEl = document.querySelector('h1[data-cg-ft="vdp-listing-title"]');
                    const title = titleEl ? titleEl.textContent.trim() : '';

                    const priceText = getPriceText();
                    const priceValue = priceText ? parseInt(priceText.replace(/[$,]/g, '')) : null;

                    const dealerNameEl = document.querySelector('[data-testid="dealerName"]');
                    const locationFromTitle = document.querySelector('hgroup p.fIarB.SlqY9');
                    const dealerAddressEl = document.querySelector('[data-testid="dealerAddress"] span[data-track-ui="dealer-address"]');

                    return {
                        vin,
                        title: title || preflight.listingTitle,
                        price: priceValue || preflight.listingPriceValue || listing.price,
                        priceString: priceText || preflight.listingPriceString || listing.priceString,
                        year: getFieldText('year') || listing.year || preflight.listingYear,
                        make: getFieldText('make') || listing.make || preflight.listingMake,
                        model: getFieldText('model') || listing.model || preflight.listingModel,
                        trim: getFieldText('trim') || listing.trim,
                        mileage: getFieldText('mileage') || listing.mileage || listing.odometer,
                        dealerName: dealerNameEl ? dealerNameEl.textContent.trim() : (listing.dealerName || preflight.listingSellerName),
                        dealerCity: locationFromTitle ? locationFromTitle.textContent.trim() : (listing.dealerCity || preflight.listingSellerCity),
                        dealerAddress: dealerAddressEl ? dealerAddressEl.textContent.trim() : null,
                        dealRating: listing.dealRating || listing.dealBadge,
                        bodyType: getFieldText('bodyType') || listing.bodyType,
                        fuelType: fuelType,
                        url: window.location.href,
                        source: 'dom'
                    };
                });

                // Close the listing tab — back to search results automatically
                await listingPage.close();
                listingPage = null;
                console.log(`  ✅ Listing tab closed`);

                // Add page metadata
                carData.pageNumber = pageToScrape;
                carData.searchRadius = searchRadius;

                console.log(`  VIN: ${carData.vin || 'NOT FOUND'}`);
                console.log(`  Title: ${carData.title || 'NOT FOUND'}`);
                console.log(`  Price: ${carData.priceString || carData.price || 'NOT FOUND'}`);
                console.log(`  Year: ${carData.year || 'NOT FOUND'}`);
                console.log(`  Mileage: ${carData.mileageString || carData.mileage || 'NOT FOUND'}`);
                console.log(`  Body Type: ${carData.bodyType || 'NOT FOUND'}`);
                console.log(`  Fuel Type: ${carData.fuelType || 'NOT FOUND'}`);
                console.log(`  Dealer: ${carData.dealerName || 'NOT FOUND'} - ${carData.dealerCity || 'NOT FOUND'}`);
                console.log(`  Source: ${carData.source}`);

                // Save car data
                if (carData.vin || carData.title) {
                    const sourceScraper = pageToScrape >= 1 && pageToScrape <= 6
                        ? 'Newest 3-pager'
                        : 'Newest';

                    const dataToSave = {
                        type: 'car_listing',
                        ...carData,
                        scrapedAt: new Date().toISOString(),
                        source_scraper: sourceScraper
                    };

                    if (dataToSave.vin && seenVins.has(dataToSave.vin)) {
                        console.log(`  ⏭️ Duplicate VIN ${dataToSave.vin} already saved this run — skipping`);
                        await page.waitForTimeout(1000 + Math.random() * 2000);
                        continue;
                    }
                    if (dataToSave.vin) seenVins.add(dataToSave.vin);

                    await Actor.pushData(dataToSave);
                    console.log(`  ✅ Saved to dataset`);

                    try {
                        const webhookUrl = 'https://n8nsaved-production.up.railway.app/webhook/cargurus';
                        const response = await fetch(webhookUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(dataToSave)
                        });
                        if (response.ok) {
                            console.log(`  📤 Sent to webhook (${response.status})`);
                        } else {
                            console.log(`  ⚠️ Webhook failed: ${response.status}`);
                        }
                    } catch (webhookError) {
                        console.log(`  ⚠️ Webhook error: ${webhookError.message}`);
                    }
                } else {
                    console.log(`  ⚠️ No data found - skipping`);
                }

                // Random delay between cars
                await page.waitForTimeout(2000 + Math.random() * 3000);

            } catch (error) {
                console.error(`❌ Error processing listing ${listingIndex + 1}:`, error.message);
                if (listingPage) {
                    await listingPage.close().catch(() => {});
                    listingPage = null;
                }
            }
        }

            // Save state after each page completes (more resilient to crashes)
            // Page succeeded — clear any recorded failures for it.
            const priorState = (await kv.getValue('state')) || {};
            const clearedFailures = { ...(priorState.failures || {}) };
            delete clearedFailures[pageToScrape];

            const nextPage = pageToScrape + 1;
            const today = new Date().toISOString().split('T')[0];

            await kv.setValue('state', {
                nextPage,
                failures: clearedFailures,
                lastScrapedDate: today,
                baseUrl: baseUrlWithFilters,
                searchRadius,
                lastScraped: new Date().toISOString(),
                lastPage: pageToScrape,
                pagesScraped: pagesToScrape.slice(0, pagesToScrape.indexOf(pageToScrape) + 1)
            });

            console.log(`💾 State saved: Page ${pageToScrape} complete. Next run will start at page ${nextPage} (date: ${today})`);

        } // End of page loop

    } catch (error) {
        console.error(`❌ Error processing pages ${pagesToScrape.join(', ')}:`, error.message);
    }

    await browser.close();
    console.log('\n✅ Scraping complete!');
});
