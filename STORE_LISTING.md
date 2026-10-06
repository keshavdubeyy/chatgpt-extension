# Chrome Web Store submission — Mell 1.0.0

Copy each section into the matching field of the Chrome Web Store Developer Dashboard.

---

## Store listing

**Name** (from manifest): `Mell - Chat Manager for ChatGPT`

**Summary** (from manifest, max 132 characters):
> Select ChatGPT chats in bulk from the sidebar or Search, then archive or delete them using ChatGPT's own menus.

**Category:** Productivity

**Language:** English

**Description:**

> Mell makes cleaning up your ChatGPT history fast.
>
> ChatGPT lets you archive or delete one chat at a time. Mell adds multi-select, so you can tick many chats and archive or delete them in one go.
>
> **Select chats where you already are**
> • In the sidebar: click Select next to Recents and tick the chats you want.
> • In ChatGPT's Search: click Select to tick chats from search results, including older ones.
> • Your selection is shared between both, so you can mix chats from the sidebar and Search.
>
> **Archive or delete in bulk**
> • Mell uses ChatGPT's own Archive and Delete options for each chat, one at a time, exactly as you would.
> • Delete always goes through ChatGPT's own "Delete chat?" confirmation, after Mell checks it names the right chat.
> • You see live progress, can stop at any time, and get a clear result (for example "9 archived · 1 failed").
> • If anything looks uncertain, Mell stops instead of guessing.
>
> **Find what to clean up**
> • From the Recents menu: filter by last activity (1, 3, 7 or 30 days), group by date, and sort by last activity or date created.
>
> **Respectful of your account**
> • Normal browsing makes no extra requests to ChatGPT.
> • Mell pauses automatically if ChatGPT is limiting requests.
> • No servers, no tracking, no data sharing. Everything stays in your browser.
>
> Mell is an independent extension and is not affiliated with or endorsed by OpenAI. ChatGPT is a trademark of OpenAI.
>
> Deleted chats can't be recovered. Archived chats can be restored from ChatGPT's Settings → Data controls → Archived chats.

**Icon:** `icons/icon-128.png` (included in the package)

**Screenshots** (required, at least 1, 1280×800 or 640×400, PNG/JPEG). Suggested set:
1. Sidebar in selection mode with a few chats ticked and the Archive / Delete bar.
2. ChatGPT's Search with Select active and results ticked.
3. The Delete confirmation with progress ("Deleting 3 of 10…").
4. The Recents "…" menu showing Last activity / Group by / Sort by.

Use disposable chats with neutral titles for screenshots (no personal content).

**Small promo tile** (440×280, required): Mell icon + "Bulk archive & delete for ChatGPT".

---

## Privacy practices tab

**Single purpose:**
> Mell helps users manage their ChatGPT conversations in bulk: select multiple chats in the ChatGPT sidebar or Search, filter/group/sort them, and archive or delete them using ChatGPT's own options.

**Permission justification — `storage`:**
> Used to cache conversation date metadata (conversation IDs with created/updated times) on the user's device, so Mell doesn't repeatedly request it from ChatGPT. Nothing is synced or sent elsewhere.

**Host permission justification — `https://chatgpt.com/*`:**
> Mell's content script runs only on chatgpt.com to add selection controls to ChatGPT's sidebar and Search, to perform archive/delete through ChatGPT's own menus, and to read conversation date metadata from chatgpt.com for the filter, group and sort features.

**Remote code:** No, I am not using remote code. (All code is in the package; no external scripts, `eval` or remote loading.)

**Data usage — what to tick:**

| Category | Tick? | Why |
|---|---|---|
| Personally identifiable information | No | |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | **Yes** | The user's existing ChatGPT session token is used (not stored) to request date metadata from chatgpt.com. |
| Personal communications | No | Conversation contents are never read. |
| Location | No | |
| Web history | No | |
| User activity | No | |
| Website content | **Yes** | Conversation titles, IDs and dates on chatgpt.com. |

**Certify all three:**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** the public address where `PRIVACY.md` is published (see README → "Publishing the privacy policy").

---

## Distribution

- **Visibility:** Public (or Unlisted for a first soft launch).
- **Regions:** All regions.
- **Price:** Free.

## Package

Upload `dist/mell-1.0.0.zip`, built with `./build.sh`. It contains only `manifest.json`, `content.js`, `styles.css` and `icons/`.
