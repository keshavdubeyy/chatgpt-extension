// Mell — Chat Manager for ChatGPT · v1.0.0
//
// This is a "content script": Chrome injects it into every https://chatgpt.com/*
// page (see manifest.json). It can read and change the page's DOM, but it runs
// in its own isolated JavaScript world, so it cannot touch ChatGPT's own JS/React.
//
// What it does: bulk selection of chats, in two places that share ONE
// selection:
//
//   Sidebar:  Recents → Select → tick chats → Archive/Delete → confirm → Done
//   Search:   Search → Select → tick chats → Archive/Delete → confirm → Done
//
// Chats ticked in the sidebar stay ticked when you open Search, and the
// other way round. "Done" in either place ends selection everywhere.
//
// ChatGPT's own UI is left as it is. The extension only adds:
//   - Sidebar: "Select" / "N selected  Done" next to the "Recents" heading,
//     checkboxes on the chat rows, and a small Archive/Delete bar at the
//     bottom of the sidebar.
//   - Search: "Select" before the settings (gear) button, and while
//     selecting, its own toolbar row in place of the tabs row (the tabs row
//     is hidden, not removed), plus checkboxes on chat results.
//
// The Recents header's own "…" menu also gets the extension's options
// (Last activity, Group by, Sort by, Reset to defaults), added under
// ChatGPT's items. At the defaults the sidebar is left exactly as ChatGPT
// draws it; otherwise rows are hidden / re-ordered with CSS (never moved)
// and date headings are slotted in. Dates come from a read-only lookup of
// ChatGPT's own conversation list (see "Chat dates").
//
// Archive and Delete work by using ChatGPT's own UI, one chat at a time:
// open that chat's "•••" menu in the sidebar (or, if the chat isn't loaded in
// the sidebar, open the chat and use its page's "•••" menu), click ChatGPT's
// own "Archive" / "Delete" (Delete then also confirms in ChatGPT's own
// "Delete chat?" dialog, after checking it names that chat), and wait until
// that exact chat is gone before the next one. If anything can't be found
// exactly, the whole queue stops. No undocumented API is used for this.
// Developers: set DRY_RUN below to true to rehearse (changes nothing).

(() => {
  // Guard against the script being injected twice into the same page.
  if (window.__cgcLoaded) return;
  window.__cgcLoaded = true;

  const VERSION = "1.0.0";

  // ---------------------------------------------------------------------------
  // Configuration — every ChatGPT-specific lookup lives here.
  // If ChatGPT changes its page, this is the first place to edit.
  // ---------------------------------------------------------------------------

  const SELECTORS = {
    // ChatGPT's modal windows. The Search one is picked out in findSearchModal().
    dialog: '[role="dialog"]',
    searchInput: "input",
    // Things that can be a tab ("All", "Chats", …).
    tab: '[role="tab"], button',
    // A chat links to its conversation (URLs look like /c/<id>).
    chatLink: 'a[href*="/c/"]',
    // ChatGPT's "…" row menu (standard ARIA roles, not class names).
    menu: '[role="menu"]',
    menuItem: '[role="menuitem"]',
  };

  // Sidebar section heading that gets "Select". First match wins.
  const SECTION_LABELS = ["Recents", "Chats"];

  // Hidden from the "…" menu of a chat that's already selected, so the only
  // Archive/Delete are the bulk ones. Matched by exact visible text.
  const HIDDEN_MENU_ITEMS = ["Archive", "Delete"];

  // Tab labels in ChatGPT's Search window.
  const TABS = {
    all: "All",
    chats: "Chats",
    images: "Images",
    documents: "Documents",
    projects: "Projects",
  };

  // Tabs whose results are chats; bulk actions only show on these.
  const CHAT_TABS = new Set(["all", "chats"]);

  // Size/spacing read from a ChatGPT control so ours match it exactly.
  // (Colors are handled separately, in "Theme" below.)
  const BUTTON_STYLES = {
    "--cgc-ref-font-size": "fontSize",
    "--cgc-ref-line-height": "lineHeight",
    "--cgc-ref-font-weight": "fontWeight",
    "--cgc-ref-letter-spacing": "letterSpacing",
    "--cgc-ref-height": "height",
    "--cgc-ref-padding-y": "paddingTop",
    "--cgc-ref-padding-x": "paddingLeft",
    "--cgc-ref-radius": "borderTopLeftRadius",
  };

  // Text-only subset, copied from the "Recents" text itself so the sidebar
  // actions look exactly like it (its padding isn't a button's).
  const TEXT_STYLES = {
    "--cgc-ref-font-size": "fontSize",
    "--cgc-ref-font-weight": "fontWeight",
    "--cgc-ref-line-height": "lineHeight",
    "--cgc-ref-letter-spacing": "letterSpacing",
  };

  // Read from ChatGPT's tabs row so the selection toolbar takes its place
  // without the layout jumping.
  const ROW_STYLES = {
    "--cgc-row-padding-left": "paddingLeft",
    "--cgc-row-padding-right": "paddingRight",
    "--cgc-row-padding-top": "paddingTop",
    "--cgc-row-padding-bottom": "paddingBottom",
    "--cgc-row-margin-top": "marginTop",
    "--cgc-row-margin-bottom": "marginBottom",
  };

  // How many chat titles the dialog lists before collapsing into "+ N more".
  const DIALOG_PREVIEW_LIMIT = 5;

  // Minimum gap between searches for the sidebar heading while it's missing.
  const HEADING_SEARCH_INTERVAL_MS = 500;

  // Sidebar filter menu. The first option of each list is the default.
  const LAST_ACTIVITY = [
    { id: "all", label: "All", days: null },
    { id: "1d", label: "1d", days: 1 },
    { id: "3d", label: "3d", days: 3 },
    { id: "7d", label: "7d", days: 7 },
    { id: "30d", label: "30d", days: 30 },
  ];

  const GROUP_BY = [
    { id: "none", label: "None" },
    { id: "date", label: "Date" },
  ];

  // Both newest first. "field" is the chat date the sort (and the date
  // groups, and the row dates) use.
  const SORT_BY = [
    { id: "activity", label: "Last activity", field: "updatedAt", dateLabel: "Last active" },
    { id: "created", label: "Date created", field: "createdAt", dateLabel: "Created" },
  ];

  const DEFAULTS = { lastActivity: "all", groupBy: "none", sort: "activity" };

  // ---- Archive / Delete (through ChatGPT's own UI) ----
  // true  = rehearse: for each chat, find its row, open its "•••" menu and
  //         find "Archive" / "Delete". For Delete it also opens ChatGPT's
  //         confirmation, checks it, and presses ChatGPT's Cancel. Nothing is
  //         archived or deleted.
  // false = really archive / delete.
  const DRY_RUN = false;

  const ARCHIVE_UI = {
    // ChatGPT's own confirmation dialog for Delete ("Delete chat?").
    confirmButton: /^delete( chat| chats)?$/i,
    cancelButton: /^cancel$/i,
    waitForConfirmDialogMs: 3000,
    // After confirming, ChatGPT keeps its dialog open (loading) until its
    // server answers, which can be slow when it's busy or rate-limiting.
    waitForConfirmCloseMs: 30000,
    // Fallback for chats not loaded in the sidebar: open the chat itself.
    waitForChatPageMs: 15000, // for the opened chat to show (title)
    leaveChatPageMs: 15000, // for ChatGPT to leave the chat after the action
    chatPageGapMs: 6000, // longer pause: opening a chat makes ChatGPT load it
    // How a row's "•••" button is recognised (it opens a menu).
    optionsButton: (button) =>
      button.getAttribute("aria-haspopup") === "menu" ||
      /option|more/i.test(button.getAttribute("aria-label") || "") ||
      /options/i.test(button.getAttribute("data-testid") || ""),
    waitForMenuMs: 2000,
    waitForRemovalMs: 8000, // for ChatGPT to drop the archived row
    // After the row disappears, wait for the sidebar to settle (no DOM
    // changes for settleQuietMs, at most settleMaxMs), then check again
    // that the row is still gone.
    settleQuietMs: 500,
    settleMaxMs: 3000,
    // Pause between chats. ChatGPT hides a row the moment Archive is clicked,
    // before its server has saved it; going too fast can get those saves
    // refused (rate limit) without ChatGPT showing any error.
    gapMs: 3000,
    // Chats archived / deleted in this tab, re-checked after the next reload (a
    // reloaded sidebar comes from ChatGPT's server, so it's the truth).
    pendingKey: "cgc-archived-awaiting-check",
    reloadCheckMs: 20000, // how long to wait for the sidebar after a reload
  };

  // ---- Staying under ChatGPT's rate limit ----
  // When ChatGPT starts refusing requests (HTTP 429, or its own "Too many
  // requests" dialog), the extension pauses everything it does for a while:
  // no date lookups, no archiving. Kept across reloads (sessionStorage).
  const RATE_LIMIT = {
    storageKey: "cgc-rate-limited-until",
    cooldownMs: 5 * 60 * 1000,
    dialogText: /too many requests/i,
  };

  // ChatGPT's own (undocumented) endpoints, used READ-ONLY for dates.
  const DATES_API = {
    session: "/api/auth/session",
    conversations: (offset, limit) =>
      `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
    // Gentle on ChatGPT's rate limits: requests are not free, and a burst of
    // them gets *all* of ChatGPT's own requests refused for a while (429).
    pageSize: 100,
    maxPages: 2, // at most 2 requests per lookup (200 most recent chats)
    pageGapMs: 1000, // pause between those requests
    // Chats with no cached dates are looked up at most this often. Chats
    // that already have cached dates are never looked up again (stale is
    // fine: it's far cheaper than a request).
    minRefetchMs: 10 * 60 * 1000,
    cacheKey: "cgc-dates-cache", // chrome.storage.local
    cacheMaxEntries: 3000,
    rateLimitCooldownMs: 60000, // after a 429, wait at least this long
  };

  // IDs and classes this extension creates. All prefixed "cgc-" (historical)
  // so they never clash with ChatGPT's own names.
  const IDS = {
    sidebarActions: "cgc-sidebar-actions",
    sidebarBar: "cgc-sidebar-bar",
    selectEntry: "cgc-select-entry",
    toolbar: "cgc-selection-toolbar",
    dialog: "cgc-dialog",
    dialogTitle: "cgc-dialog-title",
    filterSubmenu: "cgc-filter-submenu",
  };

  const CLASSES = {
    checkbox: "cgc-checkbox",
    sectionHost: "cgc-section-host",
    menuHidden: "cgc-menu-hidden",
    // On every other element the extension adds inside ChatGPT's sidebar
    // (date headings, row dates), so lookups can skip them.
    owned: "cgc-owned",
  };

  // ---------------------------------------------------------------------------
  // State — ONE selection, shared by the sidebar and Search
  // ---------------------------------------------------------------------------

  const state = {
    modal: null, // ChatGPT's Search window while it's open
    selectionMode: false,
    // key: "/c/<conversation id>" → { id, title, href }
    selected: new Map(),
    // Chat whose row button ("…") was pressed last, so we know which chat an
    // opening menu belongs to.
    menuChatKey: null,
    // Chats whose action was confirmed in the SIDEBAR but whose outcome is
    // unknown (ChatGPT didn't finish in time). If its row is gone on the next
    // try, it's counted as done instead of stopping. key → "archive" | "delete"
    uncertain: new Map(),
    // Chats archived / deleted this session (keys). Hidden at once, since
    // ChatGPT's own list only drops them after its next refresh.
    removed: new Set(),
    // Organize settings (kept while the page stays open).
    organize: { ...DEFAULTS },
    // ChatGPT's "…" menu (Recents header) while it's open, and when one of
    // that header's buttons was last pressed.
    nativeMenu: null,
    headerPressedAt: 0,
    filterSubmenu: null, // "lastActivity" | "groupBy" | "sort" | null
  };

  // Used only to avoid printing the same log line over and over.
  const logMemory = {
    missingTabsRowLogged: false,
    missingHeadingLogged: false,
    unsafeListLogged: false,
  };

  // Developer logging: off in released builds. Set DEBUG to true while
  // developing to see what the extension is doing in DevTools → Console.
  const DEBUG = false;

  function log(...args) {
    if (DEBUG) console.log("[Mell]", ...args);
  }

  // Problems worth seeing even in released builds (a stopped queue, rate
  // limits, unreadable cache).
  function warn(...args) {
    console.warn("[Mell]", ...args);
  }

  // ---------------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------------

  // h("button", { class: "x", text: "Hi", onclick: fn }, child1, child2)
  // creates an element. "text" sets textContent, "on…" adds an event
  // listener, anything else becomes an attribute (skipped if null/false).
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    });
    node.append(...children.filter((child) => child != null && child !== false));
    return node;
  }

  // Only touch the DOM when something actually changes. Writing the same text
  // again still counts as a DOM change, which would wake the MutationObserver
  // and loop forever.
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setHidden(el, hidden) {
    if (el.hidden !== hidden) el.hidden = hidden;
  }

  function setAttr(el, name, value) {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name);
    } else if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  function setStyleVar(el, name, value) {
    if (value && el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  }

  // ---------------------------------------------------------------------------
  // Icons — small inline SVGs that use currentColor, so they follow the theme.
  // ---------------------------------------------------------------------------

  const SVG_NS = "http://www.w3.org/2000/svg";

  // `shapes` is a list of [tagName, attributes] pairs.
  function createIcon(name, shapes, { viewBox = "0 0 24 24", strokeWidth = 1.75, size = 16 } = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const attrs = {
      class: `cgc-icon cgc-icon-${name}`,
      width: size,
      height: size,
      viewBox,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": strokeWidth,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    };
    Object.entries(attrs).forEach(([key, value]) => svg.setAttribute(key, value));

    shapes.forEach(([tag, shapeAttrs]) => {
      const shape = document.createElementNS(SVG_NS, tag);
      Object.entries(shapeAttrs).forEach(([key, value]) => shape.setAttribute(key, value));
      svg.append(shape);
    });
    return svg;
  }

  const icons = {
    // Empty checkbox.
    square: () =>
      createIcon("square", [["rect", { x: 1.75, y: 1.75, width: 12.5, height: 12.5, rx: 3.5 }]], {
        viewBox: "0 0 16 16",
        strokeWidth: 1.5,
      }),
    // Ticked checkbox: filled square with a check mark cut out of it.
    check: () =>
      createIcon(
        "check",
        [
          ["rect", { x: 1, y: 1, width: 14, height: 14, rx: 4, fill: "currentColor", stroke: "none" }],
          ["path", { d: "M4.75 8.25 7 10.5l4.25-4.5", class: "cgc-checkmark" }],
        ],
        { viewBox: "0 0 16 16" }
      ),
    close: () => createIcon("close", [["path", { d: "M6 6l12 12M18 6 6 18" }]]),
    // Filter menu.
    sliders: () =>
      createIcon("sliders", [
        ["path", { d: "M8 4v5M8 13v7M16 4v9M16 17v3" }],
        ["circle", { cx: 8, cy: 11, r: 2 }],
        ["circle", { cx: 16, cy: 15, r: 2 }],
      ]),
    clock: () =>
      createIcon("clock", [
        ["circle", { cx: 12, cy: 12, r: 8 }],
        ["path", { d: "M12 8v4l2.5 2" }],
      ], { size: 18 }),
    group: () =>
      createIcon("group", [
        ["path", { d: "M4 6h7M4 12h16M4 18h16" }],
        ["path", { d: "M15 6h5" }],
      ], { size: 18 }),
    sort: () =>
      createIcon("sort", [
        ["path", { d: "M7 4v16M3.5 7.5 7 4l3.5 3.5" }],
        ["path", { d: "M17 20V4M13.5 16.5 17 20l3.5-3.5" }],
      ], { size: 18 }),
    chevron: () => createIcon("chevron", [["path", { d: "m9 6 6 6-6 6" }]]),
    tick: () => createIcon("tick", [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]], { strokeWidth: 2 }),
    // Same shapes as ChatGPT's own row menu.
    archive: () =>
      createIcon("archive", [
        ["rect", { x: 3, y: 4, width: 18, height: 5, rx: 1.5 }],
        ["path", { d: "M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" }],
        ["path", { d: "M10 13h4" }],
      ]),
    trash: () =>
      createIcon("trash", [
        ["path", { d: "M4 7h16" }],
        ["path", { d: "M18 7v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7" }],
        ["path", { d: "M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }],
        ["path", { d: "M10 11v6M14 11v6" }],
      ]),
  };

  // ---------------------------------------------------------------------------
  // DOM lookup — shared
  // ---------------------------------------------------------------------------

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  // An element is "visible" if it takes up space on screen.
  function isVisible(el) {
    return el.getClientRects().length > 0;
  }

  function isOurs(el) {
    return Boolean(
      el.closest(
        `#${IDS.sidebarActions}, #${IDS.sidebarBar}, #${IDS.selectEntry}, #${IDS.toolbar}, #${IDS.dialog}, ` +
          `#${IDS.filterSubmenu}, .${CLASSES.owned}`
      )
    );
  }

  // The shared key for a conversation: "/c/<id>". The sidebar and Search may
  // link to the same chat with different paths (e.g. inside a project:
  // "/g/g-p-…/c/<id>"), so only the conversation id is used.
  function getChatKey(link) {
    let path;
    try {
      path = new URL(link.href).pathname;
    } catch {
      path = link.getAttribute("href") || "";
    }
    const match = path.match(/\/c\/([^/?#]+)/);
    return match ? `/c/${match[1]}` : path;
  }

  function getCheckbox(row) {
    return row.querySelector(`:scope > .${CLASSES.checkbox}`);
  }

  // ---------------------------------------------------------------------------
  // DOM lookup — sidebar
  // ---------------------------------------------------------------------------

  // Chat links in the sidebar: not in the chat area (<main>), not in a dialog
  // (e.g. Search results), not ours.
  function getSidebarLinks() {
    return Array.from(document.querySelectorAll(SELECTORS.chatLink)).filter(
      (link) => !link.closest(`main, ${SELECTORS.dialog}`) && !isOurs(link) && !state.removed.has(getChatKey(link))
    );
  }

  // Hide chats archived / deleted this session wherever ChatGPT still shows
  // them (sidebar rows, Search results) until its own list catches up.
  function hideRemovedChats() {
    if (state.removed.size === 0) return;
    document.querySelectorAll(SELECTORS.chatLink).forEach((link) => {
      if (isOurs(link) || !state.removed.has(getChatKey(link))) return;
      const target = isSidebarLink(link) ? getChatRow(link) : link;
      setAttr(target, "data-cgc-removed", "true");
    });
  }

  function isSidebarLink(link) {
    return !link.closest(`main, ${SELECTORS.dialog}`) && !isOurs(link);
  }

  // Finds the visible "Recents" heading by its text. Uses XPath so the
  // browser does the text search natively, which is fast.
  function findSectionHeading() {
    for (const label of SECTION_LABELS) {
      const result = document.evaluate(
        `//*[normalize-space(text())="${label}"]`,
        document.body,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      for (let i = 0; i < result.snapshotLength; i++) {
        const el = result.snapshotItem(i);
        // Skip the chat area, dialogs (Search has a "Chats" tab!) and ours.
        if (el.closest(`main, ${SELECTORS.dialog}`) || isOurs(el) || !isVisible(el)) continue;
        return outermostLabelElement(el, label);
      }
    }
    return null;
  }

  // The text may sit in a <span> inside an <h2> or <button>. Walk up to the
  // largest element that still contains only the label, so our actions line
  // up with the whole heading row.
  function outermostLabelElement(el, label) {
    let current = el;
    while (
      current.parentElement &&
      current.parentElement !== document.body &&
      normalizeText(current.parentElement.textContent.replace(getSidebarActionsText(current.parentElement), "")) === label
    ) {
      current = current.parentElement;
    }
    return current;
  }

  // Our own "Select"/"Done" text inside a heading shouldn't stop the walk up.
  function getSidebarActionsText(el) {
    const actions = el.querySelector(`#${IDS.sidebarActions}`);
    return actions ? actions.textContent : "";
  }

  // The element that directly holds the "Recents" text. The heading row
  // around it can have a bigger font; ChatGPT styles the small grey label on
  // this inner element, so that's the one to copy.
  function findLabelTextElement(heading) {
    const label = normalizeText(heading.textContent.replace(getSidebarActionsText(heading), ""));
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (isOurs(node.parentElement)) continue;
      if (normalizeText(node.textContent) === label) return node.parentElement;
    }
    return heading;
  }

  // The full sidebar row for a chat. ChatGPT's <a> can stop short of the
  // row's trailing "…"/pin buttons, so the row is the link's outermost
  // ancestor that still contains only this one chat link.
  function getChatRow(link) {
    let row = link;
    for (let depth = 0; depth < 4; depth++) {
      const parent = row.parentElement;
      if (!parent || parent === document.body) break;
      if (parent.querySelectorAll(SELECTORS.chatLink).length !== 1) break;
      row = parent;
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // DOM lookup — Search window
  // ---------------------------------------------------------------------------

  // The Search window is the visible dialog that has a text box and a
  // "Chats" tab. Other ChatGPT dialogs (settings, share, …) don't.
  function findSearchModal() {
    for (const dialog of document.querySelectorAll(SELECTORS.dialog)) {
      if (isOurs(dialog) || !isVisible(dialog)) continue;
      if (!dialog.querySelector(SELECTORS.searchInput)) continue;
      if (!findTab(dialog, "chats")) continue;
      return dialog;
    }
    return null;
  }

  function findTab(modal, key) {
    const label = TABS[key];
    return Array.from(modal.querySelectorAll(SELECTORS.tab)).find(
      (el) => !isOurs(el) && normalizeText(el.textContent) === label
    );
  }

  function isTabActive(tab) {
    return (
      tab.getAttribute("aria-selected") === "true" ||
      tab.getAttribute("data-state") === "active" ||
      tab.getAttribute("aria-pressed") === "true" ||
      tab.getAttribute("aria-current") === "true"
    );
  }

  // Which tab is showing. If ChatGPT doesn't mark the active tab in a way we
  // can read, assume "all".
  function getActiveTab(modal) {
    for (const key of Object.keys(TABS)) {
      const tab = findTab(modal, key);
      if (tab && isTabActive(tab)) return key;
    }
    return "all";
  }

  // ChatGPT's settings (gear) button in the tabs row: the icon-only button
  // that sits near the tabs (found by walking up from the "Chats" tab).
  function findSettingsButton(modal) {
    const chatsTab = findTab(modal, "chats");
    let row = chatsTab ? chatsTab.parentElement : null;
    for (let depth = 0; row && row !== modal && depth < 3; depth++, row = row.parentElement) {
      const button = Array.from(row.querySelectorAll("button")).find(
        (b) =>
          !isOurs(b) &&
          b.getAttribute("role") !== "tab" &&
          !/close/i.test(b.getAttribute("aria-label") || "") &&
          !normalizeText(b.textContent) &&
          b.querySelector("svg")
      );
      if (button) return button;
    }
    return null;
  }

  // ChatGPT's tabs row: the smallest element holding the tabs (and the gear,
  // if there is one). It must not also hold the search box or the results,
  // or hiding it would hide those too; in that case we give up safely.
  function findTabsRow(modal) {
    const tabs = Object.keys(TABS).map((key) => findTab(modal, key)).filter(Boolean);
    if (tabs.length === 0) return null;

    const settings = findSettingsButton(modal);
    const mustContain = settings ? [...tabs, settings] : tabs;

    let row = tabs[0].parentElement;
    while (row && row !== modal && !mustContain.every((el) => row.contains(el))) {
      row = row.parentElement;
    }
    if (!row || row === modal) return null;
    if (row.querySelector(SELECTORS.searchInput) || row.querySelector(SELECTORS.chatLink)) return null;
    return row;
  }

  // A tab that isn't the active one: "Select" copies its size so it looks
  // like one of ChatGPT's own tab-row controls.
  function findInactiveTab(modal) {
    for (const key of Object.keys(TABS)) {
      const tab = findTab(modal, key);
      if (tab && !isTabActive(tab)) return tab;
    }
    return null;
  }

  // Chat results currently shown in the Search window. Each result row is
  // its link (keep this in one place in case ChatGPT wraps rows differently).
  function getResultRows(modal) {
    return Array.from(modal.querySelectorAll(SELECTORS.chatLink)).filter(
      (link) => !isOurs(link) && !state.removed.has(getChatKey(link))
    );
  }

  // The result ChatGPT has highlighted for keyboard navigation (arrow keys).
  function getHighlightedRow(modal) {
    return getResultRows(modal).find(
      (row) =>
        row.getAttribute("aria-selected") === "true" ||
        row.getAttribute("data-selected") === "true" ||
        row.closest('[aria-selected="true"], [data-selected="true"]') !== null ||
        row === document.activeElement
    );
  }

  // An element's text without anything the extension added (e.g. row dates).
  function getOwnText(el) {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement.closest(`.${CLASSES.owned}, .${CLASSES.checkbox}`)) text += node.textContent;
    }
    return normalizeText(text);
  }

  // A chat's title. Prefer the sidebar's link text (it's exactly the title).
  // A Search result also has a snippet and a date, so there take the first
  // line of text (the title), ignoring the bold search highlights inside it.
  function getChatTitle(link) {
    const key = getChatKey(link);
    const sidebarLink = isSidebarLink(link) ? link : getSidebarLinks().find((l) => getChatKey(l) === key);
    if (sidebarLink) {
      const title = getOwnText(sidebarLink);
      if (title) return title;
    }

    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest(`.${CLASSES.checkbox}`)) continue;
      if (!normalizeText(node.textContent)) continue;

      let el = node.parentElement;
      while (el !== link && getComputedStyle(el).display === "inline") el = el.parentElement;
      return normalizeText(el.textContent) || "Untitled chat";
    }
    return "Untitled chat";
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  function isSelected(link) {
    return state.selected.has(getChatKey(link));
  }

  function select(link) {
    const key = getChatKey(link);
    if (!state.selected.has(key)) state.selected.set(key, { id: key, title: getChatTitle(link), href: link.href });
  }

  function toggleSelection(link) {
    if (isSelected(link)) state.selected.delete(getChatKey(link));
    else select(link);
  }

  // Turns selection mode on (from either place). If Search is open, it
  // switches to the Chats tab, since bulk actions are for chats.
  function startSelection(from) {
    state.selectionMode = true;
    if (state.modal) showChatsTab(state.modal);
    log(`Selection mode ON (from ${from})`);
    render();

    if (from === "search") document.getElementById(IDS.toolbar)?.querySelector(".cgc-select-all")?.focus();
    else document.querySelector(`#${IDS.sidebarActions} .cgc-sidebar-action`)?.focus();
  }

  // "Done" (from either place): leave selection mode everywhere, clear the
  // selection, remove every checkbox.
  function stopSelection(from) {
    state.selectionMode = false;
    state.selected.clear();
    closeDialog();
    document.querySelectorAll(`.${CLASSES.checkbox}`).forEach((box) => box.remove());
    document.querySelectorAll("[data-cgc-ready]").forEach((el) => {
      delete el.dataset.cgcReady;
    });
    log("Selection mode OFF");
    render();

    if (from === "search") document.getElementById(IDS.selectEntry)?.focus();
    else if (from === "sidebar") document.querySelector(`#${IDS.sidebarActions} .cgc-sidebar-action`)?.focus();
  }

  // Select all / Deselect all act on the Search results currently shown,
  // never on chats hidden by the current search.
  function toggleSelectAll() {
    const rows = getResultRows(state.modal);
    const allSelected = rows.length > 0 && rows.every(isSelected);
    rows.forEach((row) => {
      if (allSelected) state.selected.delete(getChatKey(row));
      else select(row);
    });
    render();
  }

  // ChatGPT's tabs may switch on mousedown rather than click, so send the
  // whole sequence a real click produces.
  function pressTab(tab) {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      const EventType = type.startsWith("pointer") && window.PointerEvent ? PointerEvent : MouseEvent;
      tab.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, button: 0 }));
    });
  }

  function showChatsTab(modal) {
    const chatsTab = findTab(modal, "chats");
    if (chatsTab && !isTabActive(chatsTab)) pressTab(chatsTab);
  }

  // ---------------------------------------------------------------------------
  // Shared UI pieces
  // ---------------------------------------------------------------------------

  function actionButton(label, className, onclick, icon = null) {
    return h("button", { type: "button", class: `cgc-action ${className}`, onclick }, icon, label);
  }

  // Copies computed styles from one of ChatGPT's elements onto ours, as CSS
  // variables that styles.css uses, so the two look the same.
  function copyStyles(target, reference, styleMap) {
    if (!reference) return;
    const computed = getComputedStyle(reference);
    Object.entries(styleMap).forEach(([variable, property]) => setStyleVar(target, variable, computed[property]));
  }

  function createCheckbox(row) {
    return h(
      "span",
      { class: CLASSES.checkbox, role: "checkbox", "aria-checked": "false", "aria-label": `Select ${getChatTitle(row)}` },
      icons.square(),
      icons.check()
    );
  }

  // Adds a checkbox to each row (once) and keeps it in sync with the state.
  function attachCheckboxes(rows) {
    rows.forEach((row) => {
      let box = getCheckbox(row);
      if (row.dataset.cgcReady !== "1" || !box) {
        box = createCheckbox(row);
        row.prepend(box);
        row.dataset.cgcReady = "1";
      }
      setAttr(box, "aria-checked", String(isSelected(row)));
    });
  }

  // ---------------------------------------------------------------------------
  // Theme — read ChatGPT's real colors instead of guessing
  // ---------------------------------------------------------------------------
  //
  // ChatGPT's CSS variables aren't reliably available to us, so we measure
  // the colors the page actually shows and hand them to styles.css as
  // --cgc-live-* variables:
  //   - on <html>, measured from the sidebar (used by the sidebar, the
  //     bottom bar and the dialog),
  //   - on the Search window, measured from it (used by its toolbar and
  //     result checkboxes, and copied onto the dialog while Search is open).

  const LIVE_VARS = ["--cgc-live-text", "--cgc-live-text-secondary", "--cgc-live-surface"];

  // The first mostly-opaque background at or above `el`.
  function getSurfaceColor(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      const match = bg.match(/rgba?\(([^)]+)\)/);
      if (!match) continue;
      const alpha = match[1].split(/[ ,/]+/)[3];
      if (alpha === undefined || parseFloat(alpha) > 0.5) return bg;
    }
    return null;
  }

  function isDarkColor(color) {
    const match = color && color.match(/rgba?\(([^)]+)\)/);
    if (!match) return false;
    const [r, g, b] = match[1].split(/[ ,/]+/).map(parseFloat);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }

  // `textEl`: something showing primary text. `secondaryEl`: something
  // showing ChatGPT's grey. The surface is searched from textEl's parent up
  // (a text box can report the browser's default white even when it looks
  // transparent, so never start at the element itself).
  function applyTheme(target, textEl, secondaryEl) {
    if (!textEl) return null;
    const surface = getSurfaceColor(textEl.parentElement);
    setStyleVar(target, "--cgc-live-text", getComputedStyle(textEl).color);
    setStyleVar(target, "--cgc-live-text-secondary", getComputedStyle(secondaryEl || textEl).color);
    setStyleVar(target, "--cgc-live-surface", surface);
    return surface;
  }

  // ---------------------------------------------------------------------------
  // Sidebar — "Recents ……… Select" / "Recents …… 3 selected  Done"
  // ---------------------------------------------------------------------------

  let lastHeadingSearch = 0;
  let headingRetryTimer = null;

  function ensureSidebarActions() {
    const existing = document.getElementById(IDS.sidebarActions);
    if (existing && existing.isConnected) return existing;

    // The heading search scans the page, so don't repeat it on every DOM
    // change. If it's too soon, retry once the interval has passed.
    const wait = HEADING_SEARCH_INTERVAL_MS - (Date.now() - lastHeadingSearch);
    if (wait > 0) {
      if (!headingRetryTimer) {
        headingRetryTimer = setTimeout(() => {
          headingRetryTimer = null;
          ensureUi();
        }, wait);
      }
      return null;
    }
    lastHeadingSearch = Date.now();

    const heading = findSectionHeading();
    if (!heading) {
      if (!logMemory.missingHeadingLogged) {
        log(`Could not find the visible "${SECTION_LABELS[0]}" heading yet.`);
        logMemory.missingHeadingLogged = true;
      }
      return null;
    }
    logMemory.missingHeadingLogged = false;

    const actions = h(
      "span",
      { id: IDS.sidebarActions },
      h("span", { class: "cgc-count", "aria-live": "polite" }),
      h("span", {
        class: "cgc-action cgc-sidebar-action",
        role: "button",
        tabindex: "0",
        onclick: () => (state.selectionMode ? stopSelection("sidebar") : startSelection("sidebar")),
        onkeydown: (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.currentTarget.click();
        },
      })
    );

    // The heading can itself be a button (e.g. one that collapses the list).
    // Keep our clicks from reaching it so they don't also collapse it.
    ["click", "pointerdown", "mousedown"].forEach((type) => {
      actions.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === "click") event.preventDefault();
      });
    });

    heading.classList.add(CLASSES.sectionHost);
    heading.append(actions);
    log("Select added to the sidebar");
    return actions;
  }

  function renderSidebar() {
    const links = getSidebarLinks();
    const actions = ensureSidebarActions();

    if (actions) {
      const heading = actions.parentElement;
      const label = findLabelTextElement(heading);
      copyStyles(actions, label, TEXT_STYLES);
      // Sidebar colors: chat titles for text, the "Recents" label for grey.
      const surface = applyTheme(document.documentElement, links.find(isVisible) || label, label);
      if (surface) setAttr(document.documentElement, "data-cgc-theme", isDarkColor(surface) ? "dark" : "light");

      const count = actions.querySelector(".cgc-count");
      setHidden(count, !state.selectionMode);
      setText(count, `${state.selected.size} selected`);
      const button = actions.querySelector(".cgc-sidebar-action");
      setText(button, state.selectionMode ? "Done" : "Select");
      button.classList.toggle("cgc-done", state.selectionMode);
      setHidden(actions, !state.selectionMode && links.length === 0);
    }

    if (state.selectionMode) attachCheckboxes(links);
    renderSidebarBar(links);

    organizeSidebar(links, actions);
    renderNativeSection();
  }

  // The small "3 selected  Archive  Delete" bar at the bottom of the
  // sidebar. Hidden while Search is open (Search has its own toolbar).
  function renderSidebarBar(links) {
    let bar = document.getElementById(IDS.sidebarBar);
    const show = state.selectionMode && state.selected.size > 0 && !state.modal;

    if (!show) {
      if (bar) setHidden(bar, true);
      return;
    }

    if (!bar) {
      bar = h(
        "div",
        { id: IDS.sidebarBar, class: "cgc-sidebar-bar", role: "toolbar", "aria-label": "Selected chats" },
        h("span", { class: "cgc-count", "aria-live": "polite" }),
        actionButton("Archive", "cgc-archive", () => openConfirmDialog("archive"), icons.archive()),
        actionButton("Delete", "cgc-delete", () => openConfirmDialog("delete"), icons.trash())
      );
      document.body.append(bar);
    }
    setHidden(bar, false);
    setText(bar.querySelector(".cgc-count"), `${state.selected.size} selected`);

    // Centre it under the sidebar by measuring a full chat row (the sidebar
    // has no stable selector). Falls back to bottom-left (CSS) if no row is
    // visible, e.g. while the sidebar is collapsed.
    const link = links.find(isVisible);
    const rect = link ? getChatRow(link).getBoundingClientRect() : null;
    if (rect && rect.width > 0) {
      const left = `${Math.round(rect.left + rect.width / 2)}px`;
      if (bar.style.left !== left) bar.style.left = left;
      bar.classList.add("cgc-centered");
    } else {
      if (bar.style.left) bar.style.left = "";
      bar.classList.remove("cgc-centered");
    }
  }

  // ---------------------------------------------------------------------------
  // Rate limit — notice when ChatGPT is limiting requests, and back off
  // ---------------------------------------------------------------------------

  function rateLimitedUntil() {
    try {
      return Number(sessionStorage.getItem(RATE_LIMIT.storageKey)) || 0;
    } catch {
      return 0;
    }
  }

  function isRateLimited() {
    return Date.now() < rateLimitedUntil();
  }

  function minutesLeft() {
    return Math.max(1, Math.ceil((rateLimitedUntil() - Date.now()) / 60000));
  }

  function markRateLimited(source) {
    const until = Date.now() + RATE_LIMIT.cooldownMs;
    if (until - rateLimitedUntil() < 30000) return; // already paused
    try {
      sessionStorage.setItem(RATE_LIMIT.storageKey, String(until));
    } catch {
      // storage blocked: the pause only lasts until a reload
    }
    warn(`ChatGPT is limiting requests (${source}). Mell pauses for ${RATE_LIMIT.cooldownMs / 60000} minutes.`);
  }

  // ChatGPT's own requests, watched through the browser's request timing
  // records (PerformanceObserver). This sends nothing; it only reads the
  // URL and status code of requests ChatGPT already made.
  const network = { entries: [], supported: false };

  function startNetworkWatch() {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.name.includes("/backend-api/")) continue;
          const status = typeof entry.responseStatus === "number" && entry.responseStatus > 0 ? entry.responseStatus : null;
          network.entries.push({ url: entry.name, status, start: entry.startTime });
          if (network.entries.length > 200) network.entries.shift();
          if (status === 429) markRateLimited("HTTP 429");
        }
      });
      observer.observe({ type: "resource", buffered: false });
      network.supported = true;
    } catch {
      network.supported = false;
    }
  }

  // ChatGPT's own "Too many requests" dialog.
  function detectRateLimitDialog() {
    for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      if (isOurs(dialog)) continue;
      const heading = dialog.querySelector("h1, h2, h3, [id*='title']");
      if (heading && RATE_LIMIT.dialogText.test(heading.textContent)) {
        markRateLimited("ChatGPT's “Too many requests” dialog");
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // RequestCoordinator — every network request the extension makes
  // ---------------------------------------------------------------------------
  //
  // One request at a time, in order. Refuses everything while ChatGPT is
  // rate-limiting (circuit breaker), and refuses / aborts metadata requests
  // while an action (Archive / Delete) holds the action lock.

  class RequestCancelled extends Error {}

  const RequestCoordinator = {
    tail: Promise.resolve(), // the queue: each request waits for the previous one
    active: null, // { kind, controller } of the request in flight
    actionLock: false,

    request(kind, url, init = {}) {
      const run = async () => {
        if (this.actionLock && kind === "metadata") throw new RequestCancelled("action in progress");
        if (isRateLimited()) {
          const error = new RequestCancelled("ChatGPT is limiting requests");
          error.status = 429;
          throw error;
        }
        const controller = new AbortController();
        this.active = { kind, controller };
        try {
          const response = await fetch(url, { credentials: "include", ...init, signal: controller.signal });
          if (response.status === 429) markRateLimited(`${kind} request got HTTP 429`);
          return response;
        } catch (error) {
          if (error.name === "AbortError") throw new RequestCancelled("aborted");
          throw error;
        } finally {
          this.active = null;
        }
      };
      const result = this.tail.then(run, run);
      this.tail = result.catch(() => {});
      return result;
    },

    // Exclusive action lock: only the action queue may run.
    lockForAction() {
      this.actionLock = true;
      if (this.active && this.active.kind === "metadata") this.active.controller.abort();
    },

    unlock() {
      this.actionLock = false;
    },
  };

  // ---------------------------------------------------------------------------
  // MetadataManager — chat dates (created / last updated)
  // ---------------------------------------------------------------------------
  //
  // ChatGPT's page doesn't show dates, so they come from the conversation
  // list ChatGPT's sidebar itself loads (undocumented endpoint, GET only,
  // through RequestCoordinator). Rules:
  //   - never fetched on page load; only when a date feature is in use
  //     (Last activity, Group by Date, Sort by Date created),
  //   - cached in chrome.storage.local across reloads; cached dates are
  //     reused however old (stale beats another request),
  //   - only chats with no cached dates are looked up, at most every 10 min,
  //   - nothing at all while Archive / Delete is running.

  function getConversationId(link) {
    const match = getChatKey(link).match(/^\/c\/(.+)$/);
    return match ? match[1] : null;
  }

  // Times can be an ISO string or seconds since 1970, depending on version.
  function parseTime(value) {
    if (value == null) return null;
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  const storageArea = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local ? chrome.storage.local : null;

  const MetadataManager = {
    byId: new Map(), // conversation id → { updatedAt, createdAt } (ms)
    status: "idle", // "idle" | "loading" | "ready" | "error"
    error: null, // "rate-limited" | "other" | null
    lastFetch: 0,
    pending: null,

    async loadCache() {
      if (!storageArea) return;
      try {
        const stored = await storageArea.get(DATES_API.cacheKey);
        const cache = stored && stored[DATES_API.cacheKey];
        if (!cache || !Array.isArray(cache.entries)) return;
        cache.entries.forEach(([id, value]) => {
          if (!this.byId.has(id)) this.byId.set(id, value);
        });
        if (this.byId.size) this.status = "ready";
        this.lastFetch = cache.savedAt || 0;
        render();
      } catch (error) {
        warn("Couldn't read cached dates:", error.message);
      }
    },

    async saveCache() {
      if (!storageArea) return;
      const entries = Array.from(this.byId.entries()).slice(-DATES_API.cacheMaxEntries);
      try {
        await storageArea.set({ [DATES_API.cacheKey]: { savedAt: this.lastFetch, entries } });
      } catch (error) {
        warn("Couldn't cache dates:", error.message);
      }
    },

    get(id, field) {
      const known = this.byId.get(id);
      return known ? known[field] : null;
    },

    isUnavailable() {
      return this.status === "error" && this.byId.size === 0;
    },

    isLoadingFirst() {
      return this.status === "loading" && this.byId.size === 0;
    },

    signature() {
      return [this.status, this.error, this.byId.size > 0];
    },

    // Make sure these conversations have dates. `userAction` = the user just
    // picked a date option (allowed to look up straight away); otherwise
    // lookups for newly loaded chats are throttled.
    ensure(ids, { userAction = false } = {}) {
      if (RequestCoordinator.actionLock || isRateLimited()) return null;
      const missing = ids.filter((id) => id && !this.byId.has(id));
      if (missing.length === 0) return null;
      if (this.pending) return this.pending;
      if (!userAction && this.lastFetch && Date.now() - this.lastFetch < DATES_API.minRefetchMs) return null;
      if (!userAction && this.status === "error") return null; // wait for "Try again"
      return this.fetch(missing);
    },

    retry(ids) {
      if (isRateLimited()) {
        log(`Still paused for about ${minutesLeft()} min: ChatGPT is limiting requests.`);
        this.error = "rate-limited";
        render();
        return;
      }
      this.status = this.byId.size ? "ready" : "idle";
      this.error = null;
      this.ensure(ids, { userAction: true });
      render();
    },

    fetch(missingIds) {
      if (this.status !== "ready") this.status = "loading";
      this.pending = (async () => {
        try {
          const sessionResponse = await RequestCoordinator.request("metadata", DATES_API.session);
          if (!sessionResponse.ok) throw Object.assign(new Error(`session request failed (${sessionResponse.status})`), { status: sessionResponse.status });
          const session = await sessionResponse.json();
          if (!session || !session.accessToken) throw new Error("not signed in");

          const missing = new Set(missingIds);
          for (let page = 0; page < DATES_API.maxPages; page++) {
            const response = await RequestCoordinator.request(
              "metadata",
              DATES_API.conversations(page * DATES_API.pageSize, DATES_API.pageSize),
              { method: "GET", headers: { Authorization: `Bearer ${session.accessToken}` } }
            );
            if (!response.ok) throw Object.assign(new Error(`conversation list failed (${response.status})`), { status: response.status });

            const data = await response.json();
            const items = Array.isArray(data && data.items) ? data.items : [];
            items.forEach((item) => {
              if (!item.id) return;
              const createdAt = parseTime(item.create_time);
              const updatedAt = parseTime(item.update_time) ?? createdAt;
              if (updatedAt == null && createdAt == null) return;
              this.byId.set(item.id, { updatedAt, createdAt });
              missing.delete(item.id);
            });

            // Stop when everything is found, the list ended, or this page
            // didn't help (e.g. project chats that never appear in it).
            const foundOnThisPage = items.some((item) => missingIds.includes(item.id));
            if (missing.size === 0 || items.length < DATES_API.pageSize || !foundOnThisPage) break;
            await sleep(DATES_API.pageGapMs);
          }
          this.status = "ready";
          this.error = null;
          this.lastFetch = Date.now();
          this.saveCache();
        } catch (error) {
          if (error instanceof RequestCancelled && error.status !== 429) {
            // Paused for an action: not a failure, try again later.
            if (this.status === "loading") this.status = this.byId.size ? "ready" : "idle";
            log("Date lookup paused:", error.message);
            return;
          }
          this.lastFetch = Date.now();
          this.status = this.byId.size ? "ready" : "error";
          this.error = error.status === 429 ? "rate-limited" : "other";
          warn("Chat dates unavailable:", error.message);
          // Without any dates the options can't apply; don't leave a half-
          // applied state behind.
          if (this.status === "error") state.organize = { ...DEFAULTS };
        } finally {
          this.pending = null;
          render();
        }
      })();
      return this.pending;
    },
  };

  function getChatDate(conversationId, field) {
    return MetadataManager.get(conversationId, field);
  }

  // Is a date-dependent option in use?
  function usesDates() {
    const o = state.organize;
    return o.lastActivity !== DEFAULTS.lastActivity || o.groupBy === "date" || o.sort === "created";
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" });

  // "Just now", "5 minutes ago", "1 day ago", "30 days ago", "2 months ago"…
  function formatRelative(ms) {
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const diff = Math.max(0, Date.now() - ms);

    if (diff < minute) return "Just now";
    if (diff < hour) return relativeTime.format(-Math.floor(diff / minute), "minute");
    if (diff < day) return relativeTime.format(-Math.floor(diff / hour), "hour");

    const days = Math.floor(diff / day);
    if (days <= 30) return relativeTime.format(-days, "day");
    if (days < 365) return relativeTime.format(-Math.floor(days / 30), "month");
    return relativeTime.format(-Math.floor(days / 365), "year");
  }

  function formatFullDate(ms) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  }

  // Date groups: Today, Yesterday, Previous 7 days, Previous 30 days, then
  // month names (with the year for earlier years).
  function getDateGroupLabel(ms) {
    if (ms == null) return "No date";
    const day = 24 * 60 * 60 * 1000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const today = startOfToday.getTime();

    if (ms >= today) return "Today";
    if (ms >= today - day) return "Yesterday";
    if (ms >= today - 7 * day) return "Previous 7 days";
    if (ms >= today - 30 * day) return "Previous 30 days";

    const date = new Date(ms);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return new Intl.DateTimeFormat("en", sameYear ? { month: "long" } : { month: "long", year: "numeric" }).format(date);
  }

  // ---------------------------------------------------------------------------
  // Sidebar — organizing the Recents list (filter, sort, group)
  // ---------------------------------------------------------------------------
  //
  // ChatGPT's rows are never moved or removed (its React code owns them):
  //   - filtered-out rows get data-cgc-filtered (hidden by CSS),
  //   - the list container becomes a flex column (data-cgc-organized) and
  //     each row gets a CSS `order`, which changes the visual order only,
  //   - date headings are our own elements, slotted in with `order` too.
  // At the defaults all of this is removed and the sidebar is untouched.

  function findOption(options, id) {
    return options.find((option) => option.id === id) || options[0];
  }

  function isAtDefaults() {
    const o = state.organize;
    return o.lastActivity === DEFAULTS.lastActivity && o.groupBy === DEFAULTS.groupBy && o.sort === DEFAULTS.sort;
  }

  // The Recents rows. Take the chat links that come after the "Recents"
  // heading (Pinned / Projects come before it), find the nearest element
  // containing all of them (the list), and treat each of its children as a
  // row. If any child holds more than one chat, it's not a simple list and
  // we don't touch it (returns null: nothing is hidden or re-ordered).
  function getRecentsRows(links) {
    const heading = document.getElementById(IDS.sidebarActions)?.parentElement;
    const recentsLinks = heading
      ? links.filter((link) => heading.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)
      : links;
    if (recentsLinks.length < 2) return null;

    let container = recentsLinks[0].parentElement;
    while (container && !recentsLinks.every((link) => container.contains(link))) container = container.parentElement;
    // (If the container also holds the heading, the heading's row simply
    // isn't a chat row: it keeps its place at the top.)
    if (!container || container === document.body) return null;

    const rows = [];
    const seen = new Set();
    for (const link of recentsLinks) {
      let row = link;
      while (row.parentElement !== container) row = row.parentElement;
      if (seen.has(row)) return null;
      seen.add(row);
      rows.push({ link, row, id: getConversationId(link) });
    }
    return { container, rows };
  }

  // Elements we gave an inline `order`, so it can be taken off again.
  const orderedElements = new Set();
  let organizedContainer = null;

  function setOrder(el, value) {
    const text = String(value);
    if (el.style.order !== text) el.style.order = text;
    orderedElements.add(el);
  }

  function resetOrganize() {
    orderedElements.forEach((el) => {
      if (el.style.order) el.style.order = "";
    });
    orderedElements.clear();
    document.querySelectorAll("[data-cgc-filtered]").forEach((el) => el.removeAttribute("data-cgc-filtered"));
    document.querySelectorAll("[data-cgc-organized]").forEach((el) => el.removeAttribute("data-cgc-organized"));
    document.querySelectorAll(".cgc-group-heading, .cgc-row-date").forEach((el) => el.remove());
    organizedContainer = null;
  }

  function organizeSidebar(links, actions) {
    if (isAtDefaults()) {
      if (
        organizedContainer ||
        document.querySelector(".cgc-row-date, .cgc-group-heading, [data-cgc-filtered], [data-cgc-organized]")
      ) {
        resetOrganize();
      }
      return;
    }

    const recents = getRecentsRows(links);
    if (!recents) {
      // Couldn't safely identify the list: undo anything applied earlier.
      if (organizedContainer) resetOrganize();
      if (!logMemory.unsafeListLogged) {
        log("Recents list isn't a simple list; filter/sort/group won't change it.");
        logMemory.unsafeListLogged = true;
      }
      return;
    }
    logMemory.unsafeListLogged = false;
    const { container, rows } = recents;
    if (organizedContainer && organizedContainer !== container) resetOrganize();
    organizedContainer = container;

    // Dates only for date features (row dates alone use what's cached).
    if (usesDates()) MetadataManager.ensure(rows.map((r) => r.id));
    const waiting = MetadataManager.isLoadingFirst();

    const o = state.organize;
    const sort = findOption(SORT_BY, o.sort);
    const { days } = findOption(LAST_ACTIVITY, o.lastActivity);
    const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

    // 1. Filter (only once dates are in, so nothing flickers away).
    const visible = rows.filter((r) => {
      if (!since || waiting) return true;
      const t = getChatDate(r.id, "updatedAt");
      return t != null && t >= since;
    });
    const visibleSet = new Set(visible);
    rows.forEach((r) => setAttr(r.row, "data-cgc-filtered", visibleSet.has(r) ? null : "true"));

    // 2. Sort newest first by the chosen date; unknown dates last, keeping
    //    ChatGPT's order among themselves.
    const sorted = visible
      .map((r, index) => ({ ...r, index, time: getChatDate(r.id, sort.field) }))
      .sort((a, b) => {
        if (a.time != null && b.time != null) return b.time - a.time || a.index - b.index;
        if (a.time != null) return -1;
        if (b.time != null) return 1;
        return a.index - b.index;
      });

    // 3. Order: everything before the first row keeps order 0 (e.g. the
    //    heading); rows and headings get 1…n; anything after the last row
    //    (e.g. ChatGPT's "load more" trigger) goes to the very end.
    setAttr(container, "data-cgc-organized", "true");
    const rowSet = new Set(rows.map((r) => r.row));
    let seenRow = false;
    for (const child of container.children) {
      if (child.classList.contains("cgc-group-heading")) continue;
      if (rowSet.has(child)) seenRow = true;
      else if (seenRow) setOrder(child, 1000000);
    }

    const usedHeadings = new Set();
    let order = 1;
    let currentGroup = null;
    sorted.forEach((r) => {
      if (o.groupBy === "date") {
        const label = getDateGroupLabel(r.time);
        if (label !== currentGroup) {
          currentGroup = label;
          const heading = ensureGroupHeading(container, label, actions);
          setOrder(heading, order++);
          usedHeadings.add(heading);
        }
      }
      setOrder(r.row, order++);
      renderRowDate(r.link, r.time, sort);
    });
    container.querySelectorAll(":scope > .cgc-group-heading").forEach((el) => {
      if (!usedHeadings.has(el)) el.remove();
    });

  }

  function ensureGroupHeading(container, label, actions) {
    let heading = Array.from(container.querySelectorAll(":scope > .cgc-group-heading")).find(
      (el) => el.dataset.label === label
    );
    if (!heading) {
      heading = h("div", { class: `cgc-group-heading ${CLASSES.owned}`, "data-label": label, role: "presentation", text: label });
      container.append(heading);
    }
    // Same text style as "Recents".
    if (actions) copyStyles(heading, findLabelTextElement(actions.parentElement), TEXT_STYLES);
    return heading;
  }

  // "2 days ago" at the end of a sidebar row; full date on hover.
  function renderRowDate(link, time, sort) {
    let el = link.querySelector(":scope > .cgc-row-date");
    if (time == null) {
      el?.remove();
      return;
    }
    if (!el) {
      el = h("span", { class: `cgc-row-date ${CLASSES.owned}` });
      link.append(el);
    }
    setText(el, formatRelative(time));
    setAttr(el, "title", `${sort.dateLabel} ${formatFullDate(time)}`);
  }

  // ---------------------------------------------------------------------------
  // Sidebar — options inside ChatGPT's own "…" menu (Recents header)
  // ---------------------------------------------------------------------------
  //
  //   Organize sidebar      ›   ┐
  //   Sort chats by         ›   │ ChatGPT's own items (untouched)
  //   Show / Projects           ┘
  //   ──────────────────────────
  //   Last activity     All  ›   ┐
  //   Group by         None  ›   │ added by the extension, styled from
  //   Sort by  Last activity ›   │ ChatGPT's own items
  //   ──────────────────────────  │
  //   Reset to defaults          ┘
  //
  // The menu itself is ChatGPT's. Our submenu has to live outside it (the
  // menu clips its contents), so it stops presses and focus on it from
  // reaching ChatGPT, which would otherwise treat them as "outside" and
  // close the menu (the same approach as the confirmation dialog).

  const MENU_SETTINGS = {
    lastActivity: { label: "Last activity", icon: "clock", options: LAST_ACTIVITY },
    groupBy: { label: "Group by", icon: "group", options: GROUP_BY },
    sort: { label: "Sort by", icon: "sort", options: SORT_BY },
  };

  // Copied from one of ChatGPT's own menu items onto our section.
  const ITEM_STYLES = {
    "--cgc-item-font-size": "fontSize",
    "--cgc-item-line-height": "lineHeight",
    "--cgc-item-height": "height",
    "--cgc-item-padding-y": "paddingTop",
    "--cgc-item-padding-x": "paddingLeft",
    "--cgc-item-radius": "borderTopLeftRadius",
  };

  // ---- Hover intent (like ChatGPT's own menus) ----
  //
  // Moving from "Last activity" to its submenu usually crosses other items
  // ("Group by", ChatGPT's own items). While the pointer is heading for the
  // open submenu — inside the triangle between where it last was on the
  // open item and the submenu's near edge — those items don't take over.
  // Resting on another item still switches, after a short pause.

  const HOVER_SWITCH_DELAY_MS = 250; // switch to another item after resting this long
  const GRACE_MS = 600; // how long the "heading for the submenu" triangle counts

  const pointer = { x: 0, y: 0, anchor: null, anchorAt: 0, inSubmenu: false };
  let hoverTimer = null;

  // Track the pointer while our submenu is open: where it is, and the last
  // point it was on the item that opened the submenu.
  function onPointerMoveForMenu(event) {
    if (!state.filterSubmenu) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const sub = document.getElementById(IDS.filterSubmenu);
    pointer.inSubmenu = Boolean(sub && sub.contains(event.target));
    if (pointer.inSubmenu) {
      clearTimeout(hoverTimer); // reached it: nothing switches or closes
      return;
    }
    const trigger = event.target.closest?.(".cgc-native-section [data-setting]");
    if (trigger && trigger.dataset.setting === state.filterSubmenu) {
      pointer.anchor = { x: event.clientX, y: event.clientY };
      pointer.anchorAt = Date.now();
    }
  }

  function isInTriangle(p, a, b, c) {
    const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  // Is the pointer on its way to the open submenu?
  function isHeadingForSubmenu() {
    const sub = document.getElementById(IDS.filterSubmenu);
    if (!sub || !pointer.anchor || Date.now() - pointer.anchorAt > GRACE_MS) return false;
    const rect = sub.getBoundingClientRect();
    // The submenu's edge nearest the anchor (it opens right, or flips left).
    const edgeX = rect.left >= pointer.anchor.x ? rect.left : rect.right;
    const pad = 8;
    return isInTriangle(
      pointer,
      pointer.anchor,
      { x: edgeX, y: rect.top - pad },
      { x: edgeX, y: rect.bottom + pad }
    );
  }

  // The pointer moved onto something other than the open submenu's item:
  // do `action` now, or — if it's heading for the submenu — only if it rests
  // there for a moment without reaching the submenu.
  function onHoverAway(action) {
    clearTimeout(hoverTimer);
    if (!state.filterSubmenu) return action();
    if (!isHeadingForSubmenu()) {
      hoverTimer = setTimeout(() => {
        if (!pointer.inSubmenu) action();
      }, 60);
      return;
    }
    hoverTimer = setTimeout(() => {
      if (!pointer.inSubmenu) action();
    }, HOVER_SWITCH_DELAY_MS);
  }

  // Is this one of the Recents header's own buttons (e.g. "…")? Its lowest
  // ancestor that also holds the "Recents" heading must hold no chat links
  // (that's the header row, not the whole section).
  function isRecentsHeaderControl(control) {
    const heading = document.getElementById(IDS.sidebarActions)?.parentElement;
    if (!heading) return false;
    if (heading.contains(control)) return true;
    let el = control.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      if (el.contains(heading)) return !el.querySelector(SELECTORS.chatLink);
    }
    return false;
  }

  function datesUnavailable() {
    return MetadataManager.isUnavailable();
  }

  function findNativeMenu() {
    if (state.nativeMenu && state.nativeMenu.isConnected) return state.nativeMenu;
    state.nativeMenu = null;
    // Only right after a Recents header button was pressed.
    if (!state.headerPressedAt || Date.now() - state.headerPressedAt > 2000) return null;
    const menu = Array.from(document.querySelectorAll(SELECTORS.menu)).find((m) => !isOurs(m) && isVisible(m));
    if (menu) {
      state.nativeMenu = menu;
      state.headerPressedAt = 0;
      log("Options added to the Recents menu");
      // No date lookup here: opening the menu isn't using a date feature.
    }
    return menu || null;
  }

  // Runs on every DOM change, before the browser paints, so our section
  // appears together with ChatGPT's menu.
  function renderNativeSection() {
    const menu = findNativeMenu();
    if (!menu) {
      state.filterSubmenu = null;
      document.getElementById(IDS.filterSubmenu)?.remove();
      return;
    }

    let section = menu.querySelector(":scope .cgc-native-section");
    if (!section) {
      section = h("div", { class: `cgc-native-section ${CLASSES.owned}`, role: "group", "aria-label": "Organize chats" });
      // Close our submenu when the pointer moves onto ChatGPT's own items
      // (unless it's just passing over them on the way to the submenu).
      menu.addEventListener("mouseover", (event) => {
        if (state.filterSubmenu && !section.contains(event.target)) {
          onHoverAway(() => closeFilterSubmenu({ focus: false }));
        }
      });
      menu.append(section);
    }

    // Look like ChatGPT's own items: copy size/spacing and the real colors.
    const nativeItem = Array.from(menu.querySelectorAll(SELECTORS.menuItem)).find((el) => !section.contains(el));
    if (nativeItem) {
      copyStyles(section, nativeItem, ITEM_STYLES);
      applyTheme(section, nativeItem, nativeItem);
    }

    // Rebuild only when what it shows changes (a rebuild is a DOM change,
    // which would otherwise keep waking the MutationObserver).
    const signature = JSON.stringify([state.organize, state.filterSubmenu, ...MetadataManager.signature()]);
    if (section.dataset.signature !== signature) {
      const focusKey = document.activeElement?.closest?.(`.cgc-native-section, #${IDS.filterSubmenu}`)
        ? document.activeElement.dataset.focusKey
        : null;
      section.dataset.signature = signature;
      section.replaceChildren(...buildSectionItems());
      renderFilterSubmenu(menu, section);
      if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  function fmenuItem(attrs, ...children) {
    return h("button", { type: "button", class: "cgc-fmenu-item", ...attrs }, ...children);
  }

  function buildSectionItems() {
    const failed = MetadataManager.isUnavailable();
    const loading = MetadataManager.isLoadingFirst();

    const settingRow = (key) => {
      const setting = MENU_SETTINGS[key];
      const value = failed ? "Unavailable" : loading ? "Loading…" : findOption(setting.options, state.organize[key]).label;
      return fmenuItem(
        {
          role: "menuitem",
          "aria-haspopup": "menu",
          "aria-expanded": String(state.filterSubmenu === key),
          "data-setting": key,
          "data-focus-key": `menu-${key}`,
          disabled: failed || loading,
          // Always opens: hovering already opened it, so a toggle here would
          // close it again on the click that follows.
          onclick: () => openFilterSubmenu(key, { focus: true }),
          onmouseenter: () => {
            if (state.filterSubmenu === key) return clearTimeout(hoverTimer);
            onHoverAway(() => openFilterSubmenu(key));
          },
          onkeydown: (event) => {
            if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              openFilterSubmenu(key, { focus: true });
            }
          },
        },
        h("span", { class: "cgc-fmenu-icon" }, icons[setting.icon]()),
        h("span", { class: "cgc-fmenu-label", text: setting.label }),
        h("span", { class: "cgc-fmenu-value", text: value }),
        h("span", { class: "cgc-fmenu-chevron" }, icons.chevron())
      );
    };

    const items = [
      h("div", { class: "cgc-fmenu-divider", role: "separator" }),
      settingRow("lastActivity"),
      settingRow("groupBy"),
      settingRow("sort"),
      h("div", { class: "cgc-fmenu-divider", role: "separator" }),
    ];

    if (failed) {
      items.push(
        h("p", {
          class: "cgc-fmenu-note",
          text:
            MetadataManager.error === "rate-limited"
              ? "ChatGPT is limiting requests right now. Try again in a minute."
              : "Chat dates couldn't be loaded.",
        }),
        fmenuItem({ role: "menuitem", "data-focus-key": "menu-retry", text: "Try again", onclick: retryDates })
      );
    } else {
      items.push(
        fmenuItem({
          role: "menuitem",
          "data-focus-key": "menu-reset",
          disabled: isAtDefaults(),
          text: "Reset to defaults",
          onclick: resetOrganizeToDefaults,
          onmouseenter: () => onHoverAway(() => closeFilterSubmenu({ focus: false })),
        })
      );
    }
    return items;
  }

  function buildSubmenuItems(key) {
    const setting = MENU_SETTINGS[key];
    return setting.options.map((option) =>
      fmenuItem(
        {
          role: "menuitemradio",
          "aria-checked": String(state.organize[key] === option.id),
          "data-focus-key": `${key}-${option.id}`,
          onclick: () => setOrganize(key, option.id),
          onkeydown: (event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              closeFilterSubmenu();
            }
          },
        },
        h("span", { class: "cgc-fmenu-label", text: option.label }),
        h("span", { class: "cgc-fmenu-tick" }, icons.tick())
      )
    );
  }

  // Our submenu: a separate element on the page (ChatGPT's menu clips what's
  // inside it), placed beside its trigger.
  function renderFilterSubmenu(menu, section) {
    let sub = document.getElementById(IDS.filterSubmenu);
    if (!state.filterSubmenu) {
      sub?.remove();
      return;
    }

    if (!sub) {
      sub = h("div", { id: IDS.filterSubmenu, class: "cgc-fmenu cgc-fmenu-sub", role: "menu" });
      // Reaching the submenu cancels any pending switch/close.
      sub.addEventListener("pointerenter", () => {
        pointer.inSubmenu = true;
        clearTimeout(hoverTimer);
      });
      sub.addEventListener("pointerleave", () => {
        pointer.inSubmenu = false;
      });
      // Keep presses on it away from ChatGPT's "clicked outside the menu".
      ["pointerdown", "mousedown", "touchstart"].forEach((type) => {
        sub.addEventListener(type, (event) => event.stopPropagation());
      });
      document.body.append(sub);
    }
    // Same colors as ChatGPT's menu.
    ["--cgc-live-text", "--cgc-live-text-secondary", "--cgc-live-surface"].forEach((name) =>
      setStyleVar(sub, name, section.style.getPropertyValue(name))
    );
    // The submenu's own look (background, corners, shadow) comes from fixed
    // theme colors in styles.css that match ChatGPT's menus. Measuring the
    // menu proved unreliable: its visible panel isn't the menu element.
    Object.keys(ITEM_STYLES).forEach((name) => setStyleVar(sub, name, section.style.getPropertyValue(name)));

    sub.replaceChildren(...buildSubmenuItems(state.filterSubmenu));

    // To the right of the menu (the sidebar is on the left), level with the
    // item that opened it; flips left if there's no room.
    const menuRect = menu.getBoundingClientRect();
    const trigger = section.querySelector(`[data-setting="${state.filterSubmenu}"]`);
    const top = trigger ? trigger.getBoundingClientRect().top - 6 : menuRect.top;
    const width = sub.offsetWidth || 180;
    const right = menuRect.right + 6;
    sub.style.left = `${Math.round(right + width > window.innerWidth - 8 ? menuRect.left - width - 6 : right)}px`;
    sub.style.top = `${Math.round(Math.max(8, Math.min(top, window.innerHeight - (sub.offsetHeight || 200) - 8)))}px`;
  }

  function openFilterSubmenu(key, { focus = false } = {}) {
    if (state.filterSubmenu !== key) {
      state.filterSubmenu = key;
      renderNativeSection();
    }
    if (focus) {
      const sub = document.getElementById(IDS.filterSubmenu);
      (sub?.querySelector('.cgc-fmenu-item[aria-checked="true"]') || sub?.querySelector(".cgc-fmenu-item"))?.focus();
    }
  }

  function closeFilterSubmenu({ focus = true } = {}) {
    const key = state.filterSubmenu;
    if (!key) return;
    state.filterSubmenu = null;
    renderNativeSection();
    if (focus) document.querySelector(`.cgc-native-section [data-setting="${key}"]`)?.focus();
  }

  // Picking an option keeps ChatGPT's menu open (showing the new value), so
  // several settings can be changed in a row.
  function setOrganize(key, value) {
    state.organize[key] = value;
    state.filterSubmenu = null;
    // The user just picked a date option: look up dates now (if not cached).
    if (usesDates()) {
      const recents = getRecentsRows(getSidebarLinks());
      if (recents) MetadataManager.ensure(recents.rows.map((r) => r.id), { userAction: true });
    }
    render();
    document.querySelector(`.cgc-native-section [data-setting="${key}"]`)?.focus();
  }

  function resetOrganizeToDefaults() {
    state.organize = { ...DEFAULTS };
    state.filterSubmenu = null;
    render();
  }

  function retryDates() {
    const recents = getRecentsRows(getSidebarLinks());
    MetadataManager.retry(recents ? recents.rows.map((r) => r.id) : []);
  }

  // ChatGPT's menu keeps focus inside itself; hide focus moves into our
  // submenu from it so focus can stay there.
  function shieldSubmenuFocus(event) {
    const sub = document.getElementById(IDS.filterSubmenu);
    if (sub && (sub.contains(event.target) || sub.contains(event.relatedTarget))) event.stopPropagation();
  }

    // ---------------------------------------------------------------------------
  // Search — "Select" and the selection toolbar
  // ---------------------------------------------------------------------------
  //
  //   [ hello                                              Clear  × ]   ← never touched
  //   Normal:     All  Chats  Images  Documents  Projects     Select  ⚙
  //   Selecting:  9 selected               Select all  Archive  Delete  Done
  //
  // While selecting, ChatGPT's tabs row is hidden (data-cgc-hidden) and our
  // toolbar row, inserted right after it, takes its place.

  // "Select", just before the settings (gear) button, or at the end of the
  // tabs row if there's no gear.
  function ensureSelectEntry(modal, tabsRow) {
    let entry = document.getElementById(IDS.selectEntry);
    if (!entry || !modal.contains(entry)) {
      entry?.remove();
      entry = actionButton("Select", "cgc-select-entry", () => startSelection("search"));
      entry.id = IDS.selectEntry;

      const settings = findSettingsButton(modal);
      if (settings && tabsRow.contains(settings)) settings.insertAdjacentElement("beforebegin", entry);
      else tabsRow.append(entry);
      log("Select added to the Search tabs row");
    }
    copyStyles(entry, findInactiveTab(modal), BUTTON_STYLES);
    return entry;
  }

  // Our toolbar row, right after ChatGPT's tabs row.
  function ensureToolbar(modal, tabsRow) {
    let toolbar = document.getElementById(IDS.toolbar);
    if (!toolbar || toolbar.previousElementSibling !== tabsRow) {
      toolbar?.remove();
      toolbar = h(
        "div",
        { id: IDS.toolbar, class: "cgc-selection-toolbar", role: "toolbar", "aria-label": "Selected chats", hidden: true },
        h("span", { class: "cgc-count", "aria-live": "polite" }),
        h(
          "div",
          { class: "cgc-toolbar-actions" },
          actionButton("Select all", "cgc-select-all", toggleSelectAll),
          actionButton("Archive", "cgc-archive", () => openConfirmDialog("archive")),
          actionButton("Delete", "cgc-delete", () => openConfirmDialog("delete")),
          actionButton("Done", "cgc-done", () => stopSelection("search"))
        )
      );
      tabsRow.insertAdjacentElement("afterend", toolbar);
    }

    // Measure the tabs row only while it's showing (hidden, it has no size).
    if (!tabsRow.hasAttribute("data-cgc-hidden")) {
      copyStyles(toolbar, tabsRow, ROW_STYLES);
      const height = `${Math.round(tabsRow.getBoundingClientRect().height)}px`;
      if (height !== "0px") setStyleVar(toolbar, "--cgc-row-height", height);
    }
    copyStyles(toolbar, findInactiveTab(modal), BUTTON_STYLES);
    return toolbar;
  }

  // Line "9 selected" up with the search text above it: measure where the
  // text inside ChatGPT's search box starts and pad the toolbar to match.
  function alignToolbarWithSearch(modal, toolbar) {
    const input = modal.querySelector(SELECTORS.searchInput);
    if (!input || toolbar.hidden) return;

    const inputStyle = getComputedStyle(input);
    const textStart =
      input.getBoundingClientRect().left +
      parseFloat(inputStyle.borderLeftWidth || "0") +
      parseFloat(inputStyle.paddingLeft || "0");
    const offset = Math.round(textStart - toolbar.getBoundingClientRect().left);
    if (Number.isFinite(offset) && offset >= 0) setStyleVar(toolbar, "--cgc-align-left", `${offset}px`);
  }

  // Keeps the Search window on Chats while selecting (asks once per window,
  // so a tab we can't read as active doesn't cause a loop).
  let chatsTabRequestedFor = null;

  function renderSearch() {
    const modal = state.modal;
    if (!modal) return;

    let onChatTab = CHAT_TABS.has(getActiveTab(modal));
    if (state.selectionMode && !onChatTab && chatsTabRequestedFor !== modal) {
      chatsTabRequestedFor = modal;
      showChatsTab(modal);
      onChatTab = CHAT_TABS.has(getActiveTab(modal));
    }

    applyTheme(modal, modal.querySelector(SELECTORS.searchInput), findInactiveTab(modal));
    const rows = getResultRows(modal);
    if (state.selectionMode && onChatTab) attachCheckboxes(rows);

    const tabsRow = findTabsRow(modal);
    if (!tabsRow) {
      if (!logMemory.missingTabsRowLogged) {
        log("Could not find the Search window's tabs row safely.");
        logMemory.missingTabsRowLogged = true;
      }
      return;
    }
    logMemory.missingTabsRowLogged = false;

    const selecting = state.selectionMode && onChatTab;
    const toolbar = ensureToolbar(modal, tabsRow);
    const entry = ensureSelectEntry(modal, tabsRow);

    // Swap rows: tabs row when browsing, our toolbar while selecting.
    setAttr(tabsRow, "data-cgc-hidden", selecting ? "true" : null);
    setHidden(toolbar, !selecting);

    // "Select": only on All/Chats, only once there are chat results.
    setHidden(entry, !onChatTab || rows.length === 0);
    if (!selecting) return;

    const count = state.selected.size;
    const allVisibleSelected = rows.length > 0 && rows.every(isSelected);

    setHidden(toolbar.querySelector(".cgc-archive"), count === 0);
    setHidden(toolbar.querySelector(".cgc-delete"), count === 0);
    setText(toolbar.querySelector(".cgc-count"), `${count} selected`);
    alignToolbarWithSearch(modal, toolbar);
    setText(toolbar.querySelector(".cgc-select-all"), allVisibleSelected ? "Deselect all" : "Select all");
    toolbar.querySelector(".cgc-select-all").disabled = rows.length === 0;
  }

  // One pass: bring both places in line with the shared state.
  function render() {
    hideRemovedChats();
    renderSidebar();
    renderSearch();
  }

  // ---------------------------------------------------------------------------
  // "…" menu of a selected chat — hide Archive / Delete
  // ---------------------------------------------------------------------------

  // Finds the chat a row button belongs to: the button is usually inside the
  // chat's <a>; if not, look a few levels up for a container holding exactly
  // one chat link (that's the row).
  function findChatLinkForControl(control) {
    const inside = control.closest(SELECTORS.chatLink);
    if (inside) return inside;

    let el = control.parentElement;
    for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
      const links = el.querySelectorAll(SELECTORS.chatLink);
      if (links.length === 1) return links[0];
      if (links.length > 1) return null;
    }
    return null;
  }

  // Remember which chat's button was pressed, just before its menu opens.
  // Menus open on pointerdown (mouse/touch) or on Enter/Space/ArrowDown.
  function onControlPress(event) {
    if (event.type === "keydown" && !["Enter", " ", "ArrowDown"].includes(event.key)) return;
    const control = event.target.closest?.('button, [role="button"]');
    if (!control || isOurs(control)) return;
    const link = findChatLinkForControl(control);
    state.menuChatKey = link ? getChatKey(link) : null;
    state.headerPressedAt = !link && isRecentsHeaderControl(control) ? Date.now() : 0;
  }

  function isHiddenMenuItem(item) {
    return HIDDEN_MENU_ITEMS.includes(normalizeText(item.textContent));
  }

  // Runs on every DOM change, before the browser paints (so the items never
  // flash). Cheap: exits at once unless the last menu opened belongs to a
  // selected chat.
  function hideMenuItemsForSelectedChat() {
    if (automationRunning) return; // the queue needs ChatGPT's own Archive item
    if (!state.menuChatKey || !state.selected.has(state.menuChatKey)) return;

    document.querySelectorAll(SELECTORS.menu).forEach((menu) => {
      menu.querySelectorAll(SELECTORS.menuItem).forEach((item) => {
        if (!isHiddenMenuItem(item)) return;
        const block = outermostHiddenBlock(item, menu);
        if (block.classList.contains(CLASSES.menuHidden)) return;
        block.classList.add(CLASSES.menuHidden);
        tidyDividers(block.parentElement);
      });
    });
  }

  // ChatGPT wraps Archive + Delete in their own padded group. Hiding just the
  // items would leave that empty group behind (a gap between two dividers),
  // so walk up to the largest wrapper that contains only items we hide.
  function outermostHiddenBlock(item, menu) {
    let block = item;
    while (block.parentElement && block !== menu && block.parentElement !== menu) {
      const items = block.parentElement.querySelectorAll(SELECTORS.menuItem);
      if (!Array.from(items).every(isHiddenMenuItem)) break;
      block = block.parentElement;
    }
    return block;
  }

  // A divider is an element with no menu item and no text inside.
  function isDivider(el) {
    if (el.matches(SELECTORS.menuItem) || el.querySelector(SELECTORS.menuItem)) return false;
    if (normalizeText(el.textContent) !== "") return false;
    return el.classList.contains(CLASSES.menuHidden) || isVisible(el);
  }

  // After hiding a group, keep exactly one divider between visible groups
  // (none at the start or end).
  function tidyDividers(container) {
    if (!container) return;
    let previousWasDivider = true; // treat the menu's start like a divider
    let trailingDivider = null;

    for (const child of container.children) {
      if (isDivider(child)) {
        if (previousWasDivider) {
          child.classList.add(CLASSES.menuHidden);
        } else {
          child.classList.remove(CLASSES.menuHidden);
          previousWasDivider = true;
          trailingDivider = child;
        }
      } else if (!child.classList.contains(CLASSES.menuHidden)) {
        previousWasDivider = false;
        trailingDivider = null;
      }
    }
    trailingDivider?.classList.add(CLASSES.menuHidden);
  }

  // ---------------------------------------------------------------------------
  // Clicks and keys while selecting
  // ---------------------------------------------------------------------------
  //
  // These listen on `window` in the capture phase, which runs before
  // ChatGPT's own handlers (they listen on `document`), so a click on a chat
  // ticks it instead of opening it, and Escape ends selection instead of
  // closing the Search window.

  function onWindowClick(event) {
    if (!state.selectionMode) return;
    const link = event.target.closest?.(SELECTORS.chatLink);
    if (!link || isOurs(link)) return;

    const inSearch = Boolean(state.modal && state.modal.contains(link));
    if (!inSearch && !isSidebarLink(link)) return;

    // In the sidebar, ChatGPT's own row buttons ("…", pin) keep working.
    const control = event.target.closest('button, [role="button"]');
    if (!inSearch && control && link.contains(control)) return;

    event.preventDefault();
    event.stopPropagation();
    toggleSelection(link);
    render();
  }

  function onWindowKeydown(event) {
    // The archive queue sends its own Escape to close ChatGPT's menus; let
    // those through to ChatGPT. (Real key presses are always isTrusted.)
    if (automationRunning && !event.isTrusted) return;
    if (closeDialogFn) return onDialogKeydown(event);

    // Our submenu in ChatGPT's menu: Escape closes just the submenu (a second
    // Escape then reaches ChatGPT, which closes its menu).
    if (state.filterSubmenu && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFilterSubmenu();
      return;
    }
    if (!state.selectionMode) return;

    const inSearch = Boolean(state.modal && state.modal.contains(event.target));
    const inSidebar =
      !inSearch &&
      (event.target.closest?.(`#${IDS.sidebarActions}, #${IDS.sidebarBar}`) ||
        (event.target.closest?.(SELECTORS.chatLink) && isSidebarLink(event.target.closest(SELECTORS.chatLink))));
    if (!inSearch && !inSidebar) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stopSelection(inSearch ? "search" : "sidebar");
      return;
    }

    // Enter normally opens the highlighted Search result. While selecting,
    // it ticks it instead. (Enter on our own buttons still presses them.)
    if (inSearch && event.key === "Enter" && !isOurs(event.target) && !event.target.closest("button")) {
      event.preventDefault();
      event.stopPropagation();
      const row = getHighlightedRow(state.modal);
      if (row) {
        toggleSelection(row);
        render();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Confirmation dialog + bulk Archive / Delete
  // ---------------------------------------------------------------------------
  //
  //   Delete 7 chats?                         ×
  //   Deleted chats can't be recovered.
  //   [ titles … + 2 more ]
  //                          Cancel   Delete 7 chats
  //   → Deleting 3 of 7…                       Stop
  //   → Deleted 7 chats.                       Done
  //     (or "Deleted 5 · 2 failed"   Retry failed  Done)
  //
  // Added to the page itself (not inside the Search window), so its dim
  // backdrop covers the whole page. ChatGPT's Search window normally reacts
  // to anything outside it, so while the dialog is open we stop:
  //   - clicks on the dialog from reaching it (they would close it),
  //   - focus moving into the dialog from being seen by it (it would pull
  //     focus back inside itself).
  // It also makes the rest of the page unclickable; the backdrop opts back
  // in with pointer-events: auto (styles.css).

  const DIALOGS = {
    archive: {
      title: (n) => `Archive ${n} ${n === 1 ? "chat" : "chats"}?`,
      message: "Archived chats are hidden from your chat list. You can restore them from Settings → Data controls → Archived chats.",
      confirmLabel: (n) => `Archive ${n} ${n === 1 ? "chat" : "chats"}`,
      confirmClass: "cgc-btn-primary",
      menuLabel: "Archive", // ChatGPT's own menu item, exact text
      needsChatGptConfirm: false,
      verb: "archive",
      verbing: "Archiving",
      past: "archived",
    },
    delete: {
      title: (n) => `Delete ${n} ${n === 1 ? "chat" : "chats"}?`,
      message: "Deleted chats can't be recovered.",
      confirmLabel: (n) => `Delete ${n} ${n === 1 ? "chat" : "chats"}`,
      confirmClass: "cgc-btn-danger",
      menuLabel: "Delete",
      needsChatGptConfirm: true, // ChatGPT asks "Delete chat?" first
      verb: "delete",
      verbing: "Deleting",
      past: "deleted",
    },
  };

  const plural = (n) => `${n} ${n === 1 ? "chat" : "chats"}`;
  // Set while a dialog is open; calling it closes the dialog.
  let closeDialogFn = null;
  let dialogKeydown = null;
  // True while a bulk action is running (the dialog can't be dismissed then,
  // only stopped).
  let bulkRunning = false;

  // True while the queue is clicking through ChatGPT's UI.
  let automationRunning = false;

  // Thrown when something isn't exactly as expected: stops the whole queue.
  class StopQueue extends Error {}

  async function waitFor(check, timeoutMs, intervalMs = 50) {
    const start = Date.now();
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() - start >= timeoutMs) return null;
      await sleep(intervalMs);
    }
  }

  // A real mouse press: pointer + mouse down/up and click, in order.
  // (ChatGPT's menus open on pointerdown; menu items act on click.)
  function press(el, { click = true } = {}) {
    const options = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "mouse", view: window };
    const PointerEventType = window.PointerEvent || MouseEvent;
    el.dispatchEvent(new PointerEventType("pointerdown", options));
    el.dispatchEvent(new MouseEvent("mousedown", options));
    el.dispatchEvent(new PointerEventType("pointerup", { ...options, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...options, buttons: 0 }));
    if (click) el.dispatchEvent(new MouseEvent("click", { ...options, buttons: 0 }));
  }

  function visibleMenus() {
    return Array.from(document.querySelectorAll(SELECTORS.menu)).filter((m) => !isOurs(m) && isVisible(m));
  }

  function closeNativeMenu(menu) {
    const target = menu && menu.isConnected ? menu : document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }

  function visibleNativeDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(
      (d) => !isOurs(d) && isVisible(d) && d !== findSearchModal()
    );
  }

  function buttonsMatching(container, pattern) {
    return Array.from(container.querySelectorAll('button, [role="button"]')).filter(
      (b) => !isOurs(b) && pattern.test(normalizeText(b.textContent))
    );
  }

  // Close ChatGPT's confirmation without deleting: its own Cancel, else Escape.
  async function cancelNativeDialog(dialog) {
    const cancel = buttonsMatching(dialog, ARCHIVE_UI.cancelButton);
    if (cancel.length === 1) press(cancel[0]);
    else closeNativeMenu(dialog);
    await waitFor(() => !dialog.isConnected || !isVisible(dialog), 1500);
  }

  // The sidebar rows for this exact conversation (by its "/c/<id>" key).
  function findSidebarLinksFor(key) {
    return Array.from(document.querySelectorAll(SELECTORS.chatLink)).filter(
      (link) => !isOurs(link) && isSidebarLink(link) && getChatKey(link) === key
    );
  }

  // That row's "•••" button: exactly one menu button in the row, else stop.
  function findOptionsButton(link) {
    const row = getChatRow(link);
    const candidates = Array.from(row.querySelectorAll('button, [role="button"]')).filter(
      (b) => !isOurs(b) && !b.closest(`.${CLASSES.checkbox}`) && ARCHIVE_UI.optionsButton(b)
    );
    return candidates.length === 1 ? candidates[0] : null;
  }

  // The Search window would close itself as soon as a sidebar menu opens, so
  // close it first (the selection is kept: it's shared with the sidebar).
  async function closeSearchWindow() {
    const modal = findSearchModal();
    if (!modal) return;
    const closeButton = Array.from(modal.querySelectorAll("button")).find(
      (b) => !isOurs(b) && /close/i.test(b.getAttribute("aria-label") || "")
    );
    if (closeButton) press(closeButton);
    else closeNativeMenu(modal.querySelector(SELECTORS.searchInput) || modal);
    if (!(await waitFor(() => !findSearchModal(), 2000))) {
      throw new StopQueue("Couldn't close the Search window. Close it and try again.");
    }
    await sleep(200);
  }

  // ---- Shared steps (both routes) ----

  // Opens ChatGPT's menu from one of its "•••" buttons.
  async function openNativeMenu(button, chat, where) {
    const before = new Set(visibleMenus());
    press(button, { click: false });
    let menu = await waitFor(() => visibleMenus().find((m) => !before.has(m)), 400);
    if (!menu) {
      // Some menus open on click rather than on press.
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, view: window }));
      menu = await waitFor(() => visibleMenus().find((m) => !before.has(m)), ARCHIVE_UI.waitForMenuMs);
    }
    if (!menu) throw new StopQueue(`The ••• menu ${where} for "${chat.title}" didn't open.`);
    return menu;
  }

  // ChatGPT's own "Archive" / "Delete" item: exactly one, else stop.
  function findSingleMenuItem(menu, action, chat) {
    const items = Array.from(menu.querySelectorAll(SELECTORS.menuItem)).filter(
      (item) => normalizeText(item.textContent) === action.menuLabel
    );
    if (items.length !== 1) {
      closeNativeMenu(menu);
      throw new StopQueue(`Couldn't find a single "${action.menuLabel}" option for "${chat.title}".`);
    }
    return items[0];
  }

  // Clicks the item; for Delete, also handles ChatGPT's "Delete chat?"
  // (must name this exact chat, exactly one Delete button). Returns
  // { clickedAt } once ChatGPT has the action, or { rehearsed: true }.
  async function clickActionItem(kind, chat, menu, item, { onUnsure }) {
    const action = DIALOGS[kind];

    if (DRY_RUN && !action.needsChatGptConfirm) {
      closeNativeMenu(menu);
      await waitFor(() => !menu.isConnected || !isVisible(menu), 1000);
      log(`DRY RUN: found ${action.menuLabel} for`, chat.title);
      return { rehearsed: true };
    }

    const dialogsBefore = new Set(visibleNativeDialogs());
    const clickedAt = performance.now();
    press(item);

    if (action.needsChatGptConfirm) {
      const confirmDialog = await waitFor(
        () => visibleNativeDialogs().find((d) => !dialogsBefore.has(d)),
        ARCHIVE_UI.waitForConfirmDialogMs
      );
      if (!confirmDialog) throw new StopQueue(`ChatGPT's delete confirmation for "${chat.title}" didn't appear.`);

      if (!normalizeText(confirmDialog.textContent).includes(chat.title)) {
        await cancelNativeDialog(confirmDialog);
        throw new StopQueue(`ChatGPT's delete confirmation didn't name "${chat.title}". Cancelled to be safe.`);
      }
      const confirmButtons = buttonsMatching(confirmDialog, ARCHIVE_UI.confirmButton);
      if (confirmButtons.length !== 1) {
        await cancelNativeDialog(confirmDialog);
        throw new StopQueue(`Couldn't find a single Delete button in ChatGPT's confirmation for "${chat.title}". Cancelled.`);
      }

      if (DRY_RUN) {
        await cancelNativeDialog(confirmDialog);
        log("DRY RUN: ChatGPT's delete confirmation checked (cancelled) for", chat.title);
        return { rehearsed: true };
      }

      press(confirmButtons[0]);
      // From here on the delete is on its way: never press Cancel again.
      // Wait for ChatGPT to finish (its dialog closes), or to refuse (429).
      const confirmedAt = performance.now();
      const closed = await waitFor(
        () => !confirmDialog.isConnected || !isVisible(confirmDialog) || saw429Since(confirmedAt),
        ARCHIVE_UI.waitForConfirmCloseMs,
        100
      );
      checkNetworkSince(clickedAt, chat, action);
      if (!closed) {
        onUnsure();
        throw new StopQueue(
          `ChatGPT is still deleting "${chat.title}" (no answer after ${ARCHIVE_UI.waitForConfirmCloseMs / 1000}s). Wait a moment, then press Retry.`
        );
      }
    }
    return { clickedAt };
  }

  // ---- Route 1 (default): the chat's row in the sidebar ----

  async function actViaSidebar(kind, chat, links) {
    const action = DIALOGS[kind];
    const link = links.find(isVisible) || links[0];
    link.scrollIntoView?.({ block: "nearest" });

    const button = findOptionsButton(link);
    if (!button) throw new StopQueue(`Couldn't find the ••• button for "${chat.title}".`);
    const menu = await openNativeMenu(button, chat, "in the sidebar");
    const item = findSingleMenuItem(menu, action, chat);
    const result = await clickActionItem(kind, chat, menu, item, {
      onUnsure: () => state.uncertain.set(chat.id, kind),
    });
    if (result.rehearsed) return;
    const { clickedAt } = result;

    // Primary check: that exact row disappears…
    const gone = await waitFor(() => findSidebarLinksFor(chat.id).length === 0, ARCHIVE_UI.waitForRemovalMs);
    checkNetworkSince(clickedAt, chat, action); // fallback safety (429)
    if (!gone) {
      if (menu.isConnected && isVisible(menu)) closeNativeMenu(menu);
      state.uncertain.set(chat.id, kind);
      throw new StopQueue(
        `"${chat.title}" was still in the sidebar after clicking ${action.menuLabel}. If it disappears, Retry counts it as ${action.past}.`
      );
    }

    // …and stays gone once the sidebar has settled (ChatGPT can put a row
    // back if it couldn't save).
    await waitForDomToSettle();
    checkNetworkSince(clickedAt, chat, action);
    if (findSidebarLinksFor(chat.id).length > 0) {
      throw new StopQueue(`"${chat.title}" came back in the sidebar after ${action.verbing.toLowerCase()}. ChatGPT may not have saved it.`);
    }
  }

  // ---- Route 2 (fallback): open the chat and use its page's "•••" menu ----
  //
  // Only for chats whose row isn't loaded in the sidebar (e.g. old chats
  // found in Search). The sidebar is never scrolled to load them.

  function conversationIdOf(chat) {
    return chat.id.replace(/^\/c\//, "");
  }

  function currentConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  // The chat's own address (a project chat keeps its project path).
  function chatPath(chat) {
    try {
      const path = new URL(chat.href, location.href).pathname;
      if (path.endsWith(`/c/${conversationIdOf(chat)}`)) return path;
    } catch {
      // fall through
    }
    return chat.id;
  }

  // Changes the page the way ChatGPT's own Back/Forward does (history +
  // popstate), so ChatGPT shows that page itself. Never a full reload.
  function navigateInApp(path) {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  }

  // The chat page's header "•••" (conversation options): icon-only, in the
  // page header, outside the sidebar. Exactly one, else stop.
  function findChatHeaderOptionsButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter((b) => {
      if (isOurs(b) || !isVisible(b) || b.closest(`nav, ${SELECTORS.dialog}, ${SELECTORS.menu}`)) return false;
      // Icon-only (an icon or just dots): skips "Share", the model picker…
      if (normalizeText(b.textContent).replace(/[.…⋯•·\s]/g, "")) return false;
      const testId = b.getAttribute("data-testid") || "";
      if (/conversation-options/i.test(testId)) return true;
      const inHeader = Boolean(b.closest("header"));
      return (
        inHeader &&
        (b.getAttribute("aria-haspopup") === "menu" || /option|more/i.test(b.getAttribute("aria-label") || ""))
      );
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function actViaChatPage(kind, chat, onStatus) {
    const action = DIALOGS[kind];
    const id = conversationIdOf(chat);
    onStatus(`Opening "${chat.title}" — it isn't loaded in the sidebar`);

    // 1. Open exactly that chat, and check the page really shows it.
    const navigatedAt = performance.now();
    if (currentConversationId() !== id) navigateInApp(chatPath(chat));
    const shown = await waitFor(
      () =>
        currentConversationId() === id &&
        normalizeText(document.title).includes(chat.title) &&
        findChatHeaderOptionsButton(),
      ARCHIVE_UI.waitForChatPageMs,
      150
    );
    checkNetworkSince(navigatedAt, chat, action);
    if (currentConversationId() !== id) {
      throw new StopQueue(`Couldn't open "${chat.title}": the page address didn't change to that chat.`);
    }
    if (!normalizeText(document.title).includes(chat.title)) {
      throw new StopQueue(`Opened the address of "${chat.title}", but the page doesn't show that chat. Stopped to be safe.`);
    }
    await waitForDomToSettle();

    // 2. The page header's "•••", exactly one.
    const button = shown && findChatHeaderOptionsButton();
    if (!button || currentConversationId() !== id) {
      throw new StopQueue(`Couldn't find a single ••• button at the top of "${chat.title}".`);
    }
    onStatus(`${action.verbing} "${chat.title}" from its page`);

    // 3. ChatGPT's own Archive / Delete (+ its confirmation).
    const menu = await openNativeMenu(button, chat, "at the top of the chat");
    const item = findSingleMenuItem(menu, action, chat);
    const result = await clickActionItem(kind, chat, menu, item, { onUnsure: () => {} });
    if (result.rehearsed) return;
    const { clickedAt } = result;

    // 4. Verify: ChatGPT leaves that chat (it no longer exists in the list)…
    const left = await waitFor(() => currentConversationId() !== id, ARCHIVE_UI.leaveChatPageMs, 150);
    checkNetworkSince(clickedAt, chat, action);
    if (!left) {
      if (menu.isConnected && isVisible(menu)) closeNativeMenu(menu);
      throw new StopQueue(`ChatGPT stayed on "${chat.title}" after ${action.menuLabel}. It may not have been ${action.past}.`);
    }
    // …and after settling, it isn't back (not reopened, not in the sidebar).
    await waitForDomToSettle();
    checkNetworkSince(clickedAt, chat, action);
    if (currentConversationId() === id || findSidebarLinksFor(chat.id).length > 0) {
      throw new StopQueue(`"${chat.title}" came back after ${action.verbing.toLowerCase()}. ChatGPT may not have saved it.`);
    }
  }

  // Archives / deletes ONE chat: through its sidebar row if loaded, otherwise
  // by opening the chat. Returns the route used ("sidebar" | "page").
  async function actOnChatThroughUi(kind, chat, { onStatus = () => {} } = {}) {
    const action = DIALOGS[kind];
    const links = findSidebarLinksFor(chat.id);

    if (links.length === 0 && state.uncertain.get(chat.id) === kind) {
      // Confirmed earlier in the sidebar but ChatGPT was slow; it's gone now.
      state.uncertain.delete(chat.id);
      log(`"${chat.title}" was ${action.past} after all.`);
      return "sidebar";
    }
    if (links.length > 0) {
      await actViaSidebar(kind, chat, links);
      return "sidebar";
    }
    await actViaChatPage(kind, chat, onStatus);
    return "page";
  }

  // Fallback protection, not the normal check: if ChatGPT answered any of
  // its own requests with 429 since the click, or answered one for this
  // exact chat with an error, stop. (Read from the browser's request
  // records; the extension sends nothing.)
  function checkNetworkSince(since, chat, action) {
    if (!network.supported) return;
    const conversationId = chat.id.replace(/^\/c\//, "");
    const recent = network.entries.filter((e) => e.start >= since - 50 && e.status !== null);
    if (recent.some((e) => e.status === 429)) {
      markRateLimited(`HTTP 429 while ${action.verbing.toLowerCase()}`);
      throw new StopQueue(`ChatGPT refused a request while ${action.verbing.toLowerCase()} "${chat.title}" (too many requests). Wait a few minutes, then retry.`);
    }
    const failedSave = recent.find((e) => e.status >= 400 && e.url.includes(conversationId));
    if (failedSave) {
      throw new StopQueue(`ChatGPT couldn't ${action.verb} "${chat.title}" (error ${failedSave.status}).`);
    }
  }

  function saw429Since(since) {
    return network.supported && network.entries.some((e) => e.start >= since - 50 && e.status === 429);
  }

  // Wait until the page has had no DOM changes for a moment.
  async function waitForDomToSettle() {
    const start = Date.now();
    while (Date.now() - start < ARCHIVE_UI.settleMaxMs) {
      if (Date.now() - lastMutationAt >= ARCHIVE_UI.settleQuietMs) return;
      await sleep(100);
    }
  }

  // Runs the queue. Returns { done, failed: [{ chat, reason }], stopped }.
  // Any problem stops everything: never continue against an uncertain target.
  async function runActionQueue(kind, chats, { onProgress, shouldStop }) {
    const done = [];
    // Where the user was, to come back to afterwards (if still possible).
    const startPath = location.pathname + location.search;
    let openedChatPages = false;
    automationRunning = true;
    // Exclusive: abort any date lookup, allow nothing else until we're done.
    RequestCoordinator.lockForAction();
    try {
      await closeSearchWindow();
      for (let i = 0; i < chats.length; i++) {
        if (shouldStop()) return { done, failed: [], stopped: true };
        // ChatGPT is limiting requests: stop before adding to it.
        if (isRateLimited()) {
          const reason = `ChatGPT is limiting requests. Wait about ${minutesLeft()} min, then press Continue.`;
          warn(`${DIALOGS[kind].menuLabel} queue stopped:`, reason);
          return { done, failed: [], stopped: true, reason };
        }
        onProgress(i, chats.length);
        let route;
        try {
          route = await actOnChatThroughUi(kind, chats[i], {
            onStatus: (text) => {
              openedChatPages = true;
              onProgress(i, chats.length, text);
            },
          });
        } catch (error) {
          const reason = error instanceof StopQueue ? error.message : `Unexpected error: ${error.message}`;
          warn(`${DIALOGS[kind].menuLabel} queue stopped:`, reason);
          return { done, failed: [{ chat: chats[i], reason }], stopped: true };
        }
        state.uncertain.delete(chats[i].id);
        done.push(chats[i]);
        // Opening a chat made ChatGPT load it: give it a longer break.
        if (i < chats.length - 1) await sleep(route === "page" ? ARCHIVE_UI.chatPageGapMs : ARCHIVE_UI.gapMs);
      }
      return { done, failed: [], stopped: false };
    } catch (error) {
      const reason = error instanceof StopQueue ? error.message : `Unexpected error: ${error.message}`;
      warn(`${DIALOGS[kind].menuLabel} queue stopped:`, reason);
      return { done, failed: [], stopped: true, reason };
    } finally {
      if (openedChatPages) await returnToStart(startPath, done);
      automationRunning = false;
      RequestCoordinator.unlock();
    }
  }

  // After opening chats, go back to where the user was, but only if that
  // page still exists (not just archived / deleted) and ChatGPT isn't
  // limiting requests (going back makes it load that page).
  async function returnToStart(startPath, done) {
    if (location.pathname + location.search === startPath) return;
    const startId = (startPath.match(/\/c\/([^/?#]+)/) || [])[1];
    const gone = startId && (done.some((chat) => conversationIdOf(chat) === startId) || state.removed.has(`/c/${startId}`));
    if (gone) {
      log("Not returning to the previous chat: it was just archived / deleted.");
      return;
    }
    if (isRateLimited()) {
      log("Not returning to the previous page: ChatGPT is limiting requests.");
      return;
    }
    navigateInApp(startPath);
    await waitFor(() => location.pathname + location.search === startPath, 3000);
    log("Returned to", startPath);
  }

  // ---- Checking after a reload that the archives really saved ----

  function readPending() {
    try {
      return JSON.parse(sessionStorage.getItem(ARCHIVE_UI.pendingKey) || "[]");
    } catch {
      return [];
    }
  }

  function rememberForReloadCheck(kind, chats) {
    if (!chats.length) return;
    const pending = readPending();
    chats.forEach((chat) => {
      if (!pending.some((p) => p.id === chat.id)) pending.push({ id: chat.id, title: chat.title, kind });
    });
    try {
      sessionStorage.setItem(ARCHIVE_UI.pendingKey, JSON.stringify(pending));
    } catch {
      // Storage unavailable (e.g. blocked): the reload check is skipped.
    }
  }

  // After a reload: once the sidebar has loaded, any chat we archived that
  // is still there was NOT saved by ChatGPT. Say so, and offer to select
  // them again.
  async function checkArchivesAfterReload() {
    const pending = readPending();
    if (!pending.length) return;

    // Wait for the sidebar, then a moment longer for it to settle.
    const loaded = await waitFor(() => getSidebarLinks().length > 0, ARCHIVE_UI.reloadCheckMs, 300);
    if (!loaded) return; // sidebar never loaded (e.g. collapsed): try next reload
    await sleep(1500);

    try {
      sessionStorage.removeItem(ARCHIVE_UI.pendingKey);
    } catch {
      // ignore
    }
    const present = new Set(getSidebarLinks().map(getChatKey));
    const cameBack = pending.filter((chat) => present.has(chat.id));
    // "archived" / "deleted" / "archived or deleted"
    const kinds = new Set(pending.map((p) => p.kind || "archive"));
    const past = kinds.size === 1 ? DIALOGS[[...kinds][0]].past : "archived or deleted";
    if (cameBack.length === 0) {
      log(`Reload check: all ${plural(pending.length)} stayed ${past}.`);
      return;
    }
    log(`Reload check: ${cameBack.length} of ${pending.length} ${past} chats came back:`, cameBack.map((c) => c.title));
    openNoticeDialog({
      title: `${cameBack.length} of ${pending.length} ${past} ${pending.length === 1 ? "chat" : "chats"} came back`,
      message:
        "ChatGPT didn't save the change for these (it may have been limiting requests). They're still in your chat list.",
      chats: cameBack,
      actionLabel: "Select them again",
      onAction: () => {
        state.selectionMode = true;
        getSidebarLinks().forEach((link) => {
          if (cameBack.some((c) => c.id === getChatKey(link))) select(link);
        });
        render();
      },
    });
  }

  // A simple information dialog (same look as the confirmation dialog).
  function openNoticeDialog({ title, message, chats, actionLabel, onAction }) {
    closeDialog();
    const okButton = h("button", { type: "button", class: "cgc-btn cgc-btn-secondary", text: "OK", onclick: () => closeDialog() });
    const actionButton = actionLabel
      ? h("button", {
          type: "button",
          class: "cgc-btn cgc-btn-primary",
          text: actionLabel,
          onclick: () => {
            closeDialog();
            onAction();
          },
        })
      : null;
    const dialog = h(
      "div",
      { class: "cgc-dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": IDS.dialogTitle },
      h(
        "div",
        { class: "cgc-dialog-header" },
        h("h2", { id: IDS.dialogTitle, class: "cgc-dialog-title", text: title }),
        h("button", { type: "button", class: "cgc-dialog-close", "aria-label": "Close", onclick: () => closeDialog() }, icons.close())
      ),
      h("p", { class: "cgc-dialog-message", text: message }),
      buildChatList(chats),
      h("div", { class: "cgc-dialog-footer" }, okButton, actionButton)
    );
    const backdrop = h("div", { id: IDS.dialog, class: "cgc-backdrop" }, dialog);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog();
    });
    dialogKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      } else if (event.key === "Tab") {
        trapFocus(dialog, event);
      }
    };
    closeDialogFn = () => {
      dialogKeydown = null;
      backdrop.remove();
    };
    document.body.append(backdrop);
    (actionButton || okButton).focus();
  }

  // After a run: drop archived chats from the selection; leave selection mode
  // when nothing is left.
  function applyActionResult(kind, result) {
    if (DRY_RUN) return;
    rememberForReloadCheck(kind, result.done);
    result.done.forEach((chat) => {
      state.removed.add(chat.id);
      state.selected.delete(chat.id);
    });
    if (result.done.length) log(`${DIALOGS[kind].past[0].toUpperCase()}${DIALOGS[kind].past.slice(1)} ${plural(result.done.length)}.`);
    if (state.selected.size === 0) {
      state.selectionMode = false;
      document.querySelectorAll(`.${CLASSES.checkbox}`).forEach((box) => box.remove());
      document.querySelectorAll("[data-cgc-ready]").forEach((el) => delete el.dataset.cgcReady);
    }
    render();
  }

  function openConfirmDialog(kind) {
    closeDialog();

    const config = DIALOGS[kind];
    let chats = Array.from(state.selected.values());
    const n = chats.length;
    if (n === 0) return;

    const previouslyFocused = document.activeElement;
    let stopRequested = false;

    const title = h("h2", { id: IDS.dialogTitle, class: "cgc-dialog-title", text: config.title(n) });
    const closeButton = h("button", { type: "button", class: "cgc-dialog-close", "aria-label": "Close", onclick: () => closeDialog() }, icons.close());
    const message = h("p", { class: "cgc-dialog-message", text: config.message });
    const listSlot = h("div", { class: "cgc-dialog-list-slot" }, buildChatList(chats));
    const note = DRY_RUN
      ? h("p", {
          class: "cgc-dialog-note",
          text: config.needsChatGptConfirm
            ? "Rehearsal — ChatGPT's confirmation opens and is cancelled; nothing is deleted."
            : "Rehearsal — menus open and close; nothing is archived.",
        })
      : null;
    const status = h("p", { class: "cgc-dialog-progress", "aria-live": "polite", hidden: true });
    const footer = h("div", { class: "cgc-dialog-footer" });

    const button = (text, className, onclick) => h("button", { type: "button", class: `cgc-btn ${className}`, text, onclick });

    // Step 1: confirm.
    const cancel = button("Cancel", "cgc-btn-secondary", () => closeDialog());
    const confirm = button(config.confirmLabel(n), config.confirmClass, () => run(chats));
    footer.append(cancel, confirm);

    // Step 2: progress, then the result.
    async function run(toDo) {
      bulkRunning = true;
      stopRequested = false;
      closeButton.hidden = true;
      status.hidden = false;
      const stop = button("Stop", "cgc-btn-secondary", () => {
        stopRequested = true;
        stop.disabled = true;
        stop.textContent = "Stopping…";
      });
      footer.replaceChildren(stop);
      stop.focus();

      const result = await runActionQueue(kind, toDo, {
        onProgress: (i, total, detail) => {
          status.textContent = detail
            ? `${detail}… (${i + 1} of ${total})`
            : `${config.verbing} ${i + 1} of ${total}…`;
        },
        shouldStop: () => stopRequested,
      });
      bulkRunning = false;
      applyActionResult(kind, result);
      showResult(result, toDo);
    }

    function showResult(result, toDo) {
      const done = result.done.length;
      const failed = result.failed.length;
      const remaining = toDo.filter((chat) => !result.done.includes(chat));
      const notStarted = remaining.length - failed;

      // "9 archived · 1 failed · 3 not started"
      const parts = [`${done} ${config.past}`];
      if (failed) parts.push(`${failed} failed`);
      if (notStarted > 0) parts.push(`${notStarted} not started`);
      status.textContent = DRY_RUN
        ? `Rehearsal finished: ${plural(done)} checked, nothing ${config.past}.`
        : parts.join(" · ");

      title.textContent = remaining.length
        ? `${config.verbing} stopped`
        : DRY_RUN
          ? "Rehearsal finished"
          : `${config.past[0].toUpperCase()}${config.past.slice(1)} ${plural(done)}`;
      const reason = (result.failed[0] && result.failed[0].reason) || result.reason;
      message.hidden = !reason;
      message.textContent = reason || "";
      closeButton.hidden = false;

      chats = remaining;
      listSlot.replaceChildren(...(remaining.length ? [buildChatList(remaining)] : []));

      const doneButton = button("Done", "cgc-btn-secondary", () => closeDialog());
      footer.replaceChildren();
      if (remaining.length && !DRY_RUN) {
        footer.append(button(failed ? "Retry" : "Continue", config.confirmClass, () => run(remaining)));
      }
      footer.append(doneButton);
      doneButton.focus();
    }

    const dialog = h(
      "div",
      { class: "cgc-dialog", role: "alertdialog", "aria-modal": "true", "aria-labelledby": IDS.dialogTitle },
      h("div", { class: "cgc-dialog-header" }, title, closeButton),
      message,
      listSlot,
      note,
      status,
      footer
    );

    const backdrop = h("div", { id: IDS.dialog, class: "cgc-backdrop" }, dialog);

    // Opened from Search: use the Search window's colors (it can differ from
    // the sidebar's surface).
    if (state.modal) {
      LIVE_VARS.forEach((name) => setStyleVar(backdrop, name, state.modal.style.getPropertyValue(name)));
    }

    // Keep presses on the dialog away from ChatGPT's "clicked outside the
    // Search window" handling. Clicking the dim area closes only the dialog
    // (not while a run is in progress).
    ["pointerdown", "mousedown", "touchstart"].forEach((type) => {
      backdrop.addEventListener(type, (event) => event.stopPropagation());
    });
    backdrop.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === backdrop) closeDialog();
    });

    // Escape closes the dialog only (not mid-run); Tab stays inside it.
    dialogKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDialog();
      } else if (event.key === "Tab") {
        trapFocus(dialog, event);
      }
    };

    // Hide focus moves into/out of the dialog from ChatGPT's focus trap.
    const shieldFocus = (event) => {
      if (backdrop.contains(event.target) || backdrop.contains(event.relatedTarget)) {
        event.stopPropagation();
      }
    };
    window.addEventListener("focusin", shieldFocus, true);
    window.addEventListener("focusout", shieldFocus, true);

    closeDialogFn = () => {
      dialogKeydown = null;
      backdrop.remove();
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
      window.removeEventListener("focusin", shieldFocus, true);
      window.removeEventListener("focusout", shieldFocus, true);
    };

    document.body.append(backdrop);
    cancel.focus(); // the safe action gets focus first
  }

  function onDialogKeydown(event) {
    if (dialogKeydown) dialogKeydown(event);
  }

  function buildChatList(chats) {
    const list = h("ul", { class: "cgc-dialog-list" });

    chats.slice(0, DIALOG_PREVIEW_LIMIT).forEach((chat) => {
      list.append(h("li", { text: chat.title, title: chat.title }));
    });

    const remaining = chats.length - DIALOG_PREVIEW_LIMIT;
    if (remaining > 0) {
      list.append(h("li", { class: "cgc-dialog-more", text: `+ ${remaining} more` }));
    }
    return list;
  }

  function closeDialog() {
    if (!closeDialogFn || bulkRunning) return; // mid-run: only Stop ends it
    const close = closeDialogFn;
    closeDialogFn = null;
    close();
  }

  function trapFocus(container, event) {
    const focusable = Array.from(container.querySelectorAll("button:not([disabled])")).filter(isVisible);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (!container.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Keeping up with ChatGPT's re-renders
  // ---------------------------------------------------------------------------

  // One pass of "are our extras in place in the sidebar and Search?"
  function ensureUi() {
    detectRateLimitDialog();
    const modal = findSearchModal();
    if (modal !== state.modal) {
      // Search opened or closed. The selection is kept either way: it's
      // shared with the sidebar. If Search opens mid-selection, it shows
      // the Chats tab with the same chats ticked.
      state.modal = modal;
      if (modal) {
        log("Search window detected");
        if (state.selectionMode) {
          chatsTabRequestedFor = modal;
          showChatsTab(modal);
        }
      }
    }
    render();
  }

  // ChatGPT is a single-page app: the sidebar and Search are redrawn all the
  // time (switching chats, scrolling, every keystroke in Search). We watch
  // the DOM so new rows get checkboxes and our buttons stay in place.
  //
  // The DOM can change hundreds of times per second while ChatGPT is
  // streaming a reply, so the main pass runs at most once per animation
  // frame. Hiding menu items runs right away, before the browser paints.
  let mutationQueued = false;

  let lastMutationAt = Date.now();

  const observer = new MutationObserver(() => {
    lastMutationAt = Date.now();
    hideMenuItemsForSelectedChat();
    if (state.headerPressedAt || state.nativeMenu) renderNativeSection();

    if (mutationQueued) return;
    mutationQueued = true;

    requestAnimationFrame(() => {
      mutationQueued = false;
      ensureUi();
    });
  });

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  log(`v${VERSION} loaded`);
  startNetworkWatch();
  MetadataManager.loadCache(); // cached dates only; never a request on load
  if (isRateLimited()) log(`Paused for about ${minutesLeft()} more min: ChatGPT was limiting requests.`);

  window.addEventListener("click", onWindowClick, true);
  window.addEventListener("pointermove", onPointerMoveForMenu, true);
  window.addEventListener("focusin", shieldSubmenuFocus, true);
  window.addEventListener("focusout", shieldSubmenuFocus, true);
  window.addEventListener("keydown", onWindowKeydown, true);
  document.addEventListener("pointerdown", onControlPress, true);
  document.addEventListener("keydown", onControlPress, true);
  window.addEventListener("resize", () => {
    renderSidebarBar(getSidebarLinks());
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // ChatGPT can take a few seconds to draw the sidebar. Try a few times early
  // on; after that the MutationObserver takes care of things.
  [0, 500, 1500, 3000, 5000].forEach((delay) => setTimeout(ensureUi, delay));

  // Did the last archive run really save? (Only runs if one happened.)
  checkArchivesAfterReload();
})();
