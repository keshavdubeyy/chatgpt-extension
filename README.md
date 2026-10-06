# Mell – Chat Manager for ChatGPT

A Chrome extension that adds bulk selection to ChatGPT, so you can archive or delete many chats at once.

Mell is an independent project and is not affiliated with or endorsed by OpenAI.

## What it does

- **Select in the sidebar.** Click **Select** next to *Recents*, tick chats, then use **Archive** or **Delete** in the bar at the bottom of the sidebar.
- **Select in Search.** In ChatGPT's Search window, click **Select** (next to the settings gear). Its toolbar offers **Select all** (the results shown), **Archive**, **Delete** and **Done**.
- **One shared selection.** Chats ticked in the sidebar stay ticked in Search and the other way round. **Done** or Escape clears it everywhere.
- **Filter, group and sort** from the Recents **…** menu: *Last activity* (1, 3, 7 or 30 days), *Group by* date, *Sort by* last activity or date created, and *Reset to defaults*. At the defaults the sidebar is exactly as ChatGPT draws it.

## How Archive and Delete work

Mell uses ChatGPT's own options. It never calls ChatGPT's private write API. For each selected chat, one at a time:

1. **Sidebar route (default).** If the chat's row is loaded in the sidebar, Mell opens that row's **•••** menu and clicks ChatGPT's own **Archive** or **Delete**.
2. **Chat-page route (fallback).** If the row isn't loaded, for example an old chat found in Search, Mell opens that chat inside ChatGPT (no page reload). It checks the address and page title are exactly that chat, then uses the **•••** at the top of the chat. The sidebar is never scrolled to load chats.
3. **Delete confirmation.** For Delete, Mell checks that ChatGPT's own *Delete chat?* dialog names that exact chat and has exactly one Delete button, then confirms it.
4. **Verification.** The chat must disappear, and stay gone once the page has settled, before Mell moves on.

**Safety:**
- If any target is missing or ambiguous, the whole queue stops and says why.
- Progress is shown throughout, with **Stop**, **Retry** and a result such as `9 deleted · 1 failed · 2 not started`.
- After a reload, Mell reports any chat that "came back", meaning ChatGPT didn't save the change.
- Mell returns you to the chat you were on, unless that chat was just archived or deleted.

**Deleted chats can't be recovered.** Archived chats can be restored from ChatGPT's *Settings → Data controls → Archived chats*.

## Network use

- **Normal browsing makes no extra requests.**
- **Chat dates** are requested from chatgpt.com only when you use a date option (Last activity, Group by date, Sort by date created). Mell makes one request at a time and caches the dates in `chrome.storage.local`, reusing them across reloads.
- **While Archive or Delete runs,** Mell holds an exclusive lock: date requests are cancelled and none can start.
- **Rate limits:** if ChatGPT starts refusing requests (HTTP 429, or its *Too many requests* dialog), Mell stops the queue and pauses its own requests for 5 minutes.

See [PRIVACY.md](PRIVACY.md) for what data is accessed and stored.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3). Permission: `storage`. Runs only on `https://chatgpt.com/*`. |
| `content.js` | All extension logic. ChatGPT-specific lookups are near the top (`SELECTORS`, `SECTION_LABELS`, `TABS`, `ARCHIVE_UI`). |
| `styles.css` | Styles for elements Mell adds (prefixed `cgc-`). |
| `icons/` | Extension icons (16, 32, 48, 128 px), made from `Icon.png`. |
| `build.sh` | Builds the Chrome Web Store upload `dist/mell-<version>.zip`. |
| `PRIVACY.md` | Privacy policy (publish it, see below). |
| `STORE_LISTING.md` | Text for every field of the Chrome Web Store submission. |

## Install for development

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open or refresh `https://chatgpt.com`.

After editing code, click ↻ on Mell in `chrome://extensions`, then refresh the ChatGPT tab.

**Developer switches** at the top of `content.js`:
- `DEBUG = true` prints what Mell is doing to DevTools → Console, prefixed `[Mell]`. Real problems (a stopped queue, rate limits) are always printed as warnings.
- `DRY_RUN = true` rehearses Archive and Delete. Mell finds each chat and opens its menu (and, for Delete, ChatGPT's confirmation, then presses Cancel), but changes nothing.

Both must be `false` for a release; `build.sh` refuses to build otherwise. Test against disposable chats.

## Publishing the privacy policy

The Chrome Web Store needs a public URL for the privacy policy. Two easy options:

- **GitHub Pages:** push this repository to GitHub, enable *Settings → Pages* for the `main` branch, and use `https://<your-user>.github.io/<repo>/PRIVACY` (GitHub renders the Markdown).
- **Google Docs:** paste `PRIVACY.md` into a doc, then use *File → Share → Publish to web* and copy the link.

## Release

1. Bump `version` in `manifest.json` (and `VERSION` in `content.js`).
2. Run `./build.sh`. It checks that `DRY_RUN` and `DEBUG` are off, then writes `dist/mell-<version>.zip`.
3. Upload the zip in the Chrome Web Store Developer Dashboard, using the texts in `STORE_LISTING.md`.
