# X account cleanup tools

Playwright-based command-line tools for cleaning posts, replies, and reposts from the signed-in X account. They do not delete the account itself.

The run is irreversible. Keep the Chrome window open and stop the process manually when finished. X may rate-limit or change its markup.

## Playwright diagnostic runner

The more observable runner uses an existing Chrome session through Chrome's DevTools connection. It defaults to a non-destructive 10-post scan and writes screenshots/text to `diagnostics/` when a deletion step fails.

Start a separate Chrome session with remote debugging enabled, sign in to X, and open any X tab:

```bash
./start.sh
```

Start the debug Chrome session with npm:

```bash
npm run playwright
```

The three cleanup commands are destructive by default. The number after the command is the limit:

```bash
npm run posts 1000
npm run replies 1000
npm run reposts 1000
```

Use `--dry-run` to inspect without deleting:

```bash
npm run posts -- 10 --dry-run
```

The runner discovers the signed-in X account dynamically, scrolls incrementally to trigger X's lazy loading, waits 750 ms after each click, waits and retries every UI step once per second when X has not returned the expected element/state, repeats the full removal sequence if the item remains visible, reloads when X shows a visible Retry button or when no confirmed deletion occurs for 20 seconds, reloads and continues instead of ending when incremental loading temporarily produces no new items, and increments its count only after the target item disappears. Stop the process manually when you are done.

The replies command selects the profile's **Replies** tab and uses the same retry, pacing, reload, diagnostics, and confirmed-disappearance behavior. In Replies mode, if no Delete action appears after the retry wait, it skips that reply as someone else's message and moves to the next one.

The reposts command selects the **Reposts** tab, clicks each inline `[data-testid="unretweet"]` repost button beside the reply/like controls, then selects X's `Undo repost`, `Remove repost`, or `Unrepost` action. It does not use the post-delete confirmation dialog; it confirms success when the repost disappears. Do not run another cleanup process in this Chrome profile at the same time.
