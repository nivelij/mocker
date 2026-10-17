# Mocker

Chrome extension that mocks `fetch` / `XMLHttpRequest` responses on any page: match a URL, pick the status code, write the JSON body.

## Install

1. Open `chrome://extensions` (or `brave://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin the extension and click its icon to open the side panel.

After editing the extension's code, click the reload icon on its card and reload the pages you're testing.

## Use

- **Requests** tab lists the fetch/XHR calls the current tab made. Click **Mock** on one to start a mock with its URL, method, status and real response body filled in.
- **Mocks** tab lists your mocks. Click one to edit it; the checkbox turns it on or off. The switch in the header turns all mocking off.
- Each mock belongs to the site it was created on (the address-bar host, so iframes on that page count too), or to all sites. The Mocks tab shows only mocks active on the current site; the rest are under **Other sites**.
- URL matching: `contains` (default), `equals` (full URL), or `regex`. The first enabled mock that matches wins.
- Status must be 200–599. For 204/205/304 the body is ignored.
- Changes apply immediately to open pages, no reload needed (except for requests the page already made).
- The icon badge counts how many responses were mocked on the current page.

## Limits

- Only requests made through `fetch` or `XMLHttpRequest` from the page (and its iframes) are mocked. Requests from service workers, web workers, `<img>`/`<script>` tags, and page navigations are not.
- Mock rules are passed to pages through DOM events, so any site you visit could read them. Don't keep sensitive data (e.g. a real response copied from a logged-in API) in mock bodies longer than needed.
- Pages that were already open when the extension was installed or reloaded need a refresh.
