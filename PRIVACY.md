# Mell Privacy Policy

**Last updated: October 2026**

Mell ("Mell – Chat Manager for ChatGPT") is a browser extension that adds conversation-management features to ChatGPT (chatgpt.com). It runs only on chatgpt.com.

## Information Mell accesses

Mell may access:

- ChatGPT conversation titles and conversation identifiers shown or available within ChatGPT (for example in the sidebar and in ChatGPT's Search).
- Conversation date metadata (when a conversation was created and last updated), used only for the Last activity, Group by date and Sort by features.
- The user's existing signed-in ChatGPT session, used only to request that date metadata from ChatGPT. The session's access token is used for those requests and is never stored by Mell.
- The addresses and status codes of requests ChatGPT itself makes, read from the browser, so Mell can notice when ChatGPT is limiting requests and pause. Mell does not read the contents of those requests.

Mell does not read the contents of your conversations.

## How this information is used

Mell uses this information only to provide its user-facing features:

- selecting multiple conversations,
- filtering, grouping and sorting conversations,
- archiving conversations,
- deleting conversations,
- checking that an archive or delete really took effect, and
- reducing repeated requests to ChatGPT through local caching and by pausing when ChatGPT is limiting requests.

Archive and delete are performed by Mell clicking ChatGPT's own Archive and Delete options, only after you select conversations and confirm.

## Local storage

Mell stores data only on your device:

- **Cached conversation date metadata** (conversation identifiers with their created / last-updated times), stored with Chrome's extension storage (`chrome.storage.local`).
- **Short-lived session data**, stored in the ChatGPT tab's session storage and removed when the tab is closed: the identifiers and titles of conversations Mell just archived or deleted (used to check, after you reload the page, that they stayed archived or deleted), and the time until which Mell pauses because ChatGPT was limiting requests.

Your selections and filter, group and sort settings are kept in memory only and are not saved.

## Data sharing

Mell does not sell user data.

Mell does not send conversation data, authentication information or cached metadata to Mell-controlled servers, advertisers, data brokers or any other third party. Mell has no servers. The only network requests Mell makes go to chatgpt.com, on your behalf, to read conversation date metadata.

## Authentication

Mell relies on your existing ChatGPT session to provide certain features. Mell does not use authentication information for any purpose unrelated to the extension's functionality, and does not store it.

## Data retention

Cached date metadata stays stored on your device until it is replaced, the extension is removed, or the browser clears the extension's stored data. Session data is removed when the ChatGPT tab is closed.

## Security

Mell requests only the browser permissions needed for its stated features (`storage`, and access to chatgpt.com) and does not transmit user data outside ChatGPT and your browser.

## Chrome Web Store Limited Use

Mell's use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. Information is used only to provide and improve Mell's disclosed, user-facing functionality.

## Changes

If this policy changes, the updated version will be published at this address with a new "Last updated" date.

## Contact

For privacy questions or support, contact: **keshavdubey.design@gmail.com**
