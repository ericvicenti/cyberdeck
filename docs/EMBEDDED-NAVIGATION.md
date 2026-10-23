# Embedded application navigation

Generic applications may opt in to Cyberdeck's version 1 navigation bridge. Afterglow
continues to use its existing, separate bridge. Apps without this adapter still open
normally and retain their iframe while browsing Cyberdeck. A nested link to an app
that does not acknowledge the bridge displays a restoration error; Cyberdeck cannot
inspect or rewrite an uncooperative cross-origin application's router.

Bundle `ui/public/embedded-navigation.js` with the child application, then initialize
it once for that document:

```js
import { createEmbeddedNavigation } from './embedded-navigation.js';
const navigation = createEmbeddedNavigation({
  parentOrigins: ['https://your-private-cyberdeck-origin.example'],
  async onNavigate(route, { signal }) {
    // Render the route without writing history or remounting session owners.
    // Cancel/ignore stale fetch results when signal.aborted becomes true.
    await router.render(route, { signal });
    // Optional: return the canonical root-relative route for aliases/defaults.
  },
  getTitle: () => document.title,
});
// Route all navigable child links/tabs/modals through this entry point.
await navigation.navigate('/library?filter=saved#item');
await navigation.navigate('/library?filter=all', { replace: true });
// After asynchronous metadata changes, name the route that owns that result.
navigation.title('/library?filter=all');
// When disposing the child application:
navigation.dispose();
```

Use an explicit allowlist of trusted parent origins. Do not derive it from an
untrusted URL parameter or accept `*`. Cross-origin hosting still needs the app's
existing authentication and frame-ancestors policy; this bridge grants no API access.
Do not put credentials in routes or titles. Render navigable content only: restoring
a link must never play media, start a process, download a file or send a message.

Routes are root-relative same-origin paths with query/hash, limited to 4096 characters;
absolute URLs, network-path references, backslashes and raw whitespace/control
characters are refused. Encode query values with URLSearchParams. The adapter never
navigates the document to a different server or reloads it during route restoration.
Applications must use the adapter for **every** route change; ordinary location writes
or a router's independent history writer can still create extra iframe entries.

Cyberdeck stores the route in `#/applications?app=<id>&route=<encoded-route>`. The
initial child document always loads from the configured app URL, then restores the
route through the adapter. Default/canonical routes replace the outer entry; explicit
child navigation pushes once. Child history is replaced while embedded. Requests
carry an activation channel and request number, so late acknowledgements cannot win
over Back/Forward, a different application or a hidden view. Async renderers must
honor the supplied AbortSignal themselves; the adapter guards history and replies.

The child sends titles after render completion. Hidden frames keep running but cannot
own Cyberdeck's route/title. Returning sends the URL's route again, leaving the iframe
document and session owners alive. Explicit Reload replaces only the child document.
Authentication lock still removes the authenticated application's owner.

Protocol messages all include `version: 1`. A child announces `embedded:ready` to its
allowlisted parents. Parent `cyberdeck:connect` includes `channel`, positive `request`
and `route` (null means the child's default). Child `embedded:ack` reports the canonical
`route`/`title`, echoing channel/request. Later `embedded:navigation` adds `mode`;
`embedded:title` updates only the currently selected route. Both sides check exact
origin and source window; the parent also checks the current route and request.

Checks: build first, then `bun test tests/embedded-navigation.test.ts --timeout 30000`.
Set `CYBERDECK_TEST_UI` to test an exact installed-tree production build. The suite
uses local child services and this actual adapter, without production app actions.
