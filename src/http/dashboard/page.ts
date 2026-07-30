import { DASHBOARD_SCRIPT } from "./client.js";
import { START_SCRIPT } from "./start.js";
import { DASHBOARD_STYLES } from "./styles.js";

/**
 * The whole dashboard as one document — markup, styles and script together, with
 * nothing fetched from anywhere else. The Supervisor is meant to be read from a
 * phone on whatever network it happens to be on, which may be no network at all,
 * so a page that needed a CDN to render would be a page that sometimes did not.
 *
 * The two scripts share nothing but the page itself: the live view writes the
 * queue's state onto `<body>`, and that is the whole of what tells the start panel
 * whether there is anything under way to keep it out of the way of.
 */
export const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Supervisor</title>
    <style>${DASHBOARD_STYLES}</style>
  </head>
  <body>
    <header>
      <h1>AI Supervisor</h1>
      <span id="queue-state" class="pill">connecting</span>
      <span id="instruction" class="pill instruction" hidden></span>
      <div class="controls">
        <button type="button" id="pause" class="control" hidden>Pause</button>
        <button type="button" id="resume" class="control" hidden>Resume</button>
        <button type="button" id="stop" class="control" hidden>Stop</button>
      </div>
      <span id="branch" class="branch"></span>
    </header>
    <p id="offline" class="notice" hidden>Not connected to the Supervisor — retrying.</p>
    <p id="notice" class="notice" hidden></p>
    <p id="refused" class="notice" hidden></p>
    <main>
      <section class="panel start" id="start-panel">
        <h2>Start a run</h2>
        <div class="field">
          <label for="source">Ticket directory</label>
          <input id="source" type="text" autocapitalize="off" autocorrect="off"
                 spellcheck="false" placeholder="the configured ticket source" />
        </div>
        <div class="controls">
          <button type="button" id="look" class="control">Preview queue</button>
          <button type="button" id="start" class="control primary" hidden>Start run</button>
        </div>
        <p id="start-notice" class="notice" hidden></p>
        <ol id="edited-queue" class="tickets"></ol>
      </section>
      <section class="panel">
        <h2>Queue</h2>
        <ol id="tickets" class="tickets"></ol>
      </section>
      <section class="panel">
        <h2 id="live-title">Live output</h2>
        <pre id="live" class="log">Nothing is being attempted right now.</pre>
      </section>
    </main>
    <script>${DASHBOARD_SCRIPT}</script>
    <script>${START_SCRIPT}</script>
  </body>
</html>
`;
