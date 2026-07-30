/**
 * The dashboard in the browser: it opens one event stream and never asks for the
 * queue again. Everything on the page but a ticket's own attempt history arrives
 * pushed, so the page is right whether it was opened before the run started or at
 * 3am halfway through it. The controls send and say nothing back — what a control
 * did to the run comes back down the same stream as everything else, so every
 * dashboard that is open agrees about what happened.
 *
 * Plain browser JavaScript on purpose. The Supervisor ships as one compiled file
 * and a bundler for a single page would be a build step nobody asked for — the
 * price is that this is the one thing under `src/` that `tsc` does not check, so
 * it is kept small enough to read in one sitting and everything it touches on the
 * page is declared right next to it in `page.ts`.
 */
export const DASHBOARD_SCRIPT = String.raw`
(function () {
  const byId = function (id) { return document.getElementById(id); };
  const statePill = byId("queue-state");
  const instruction = byId("instruction");
  const branch = byId("branch");
  const notice = byId("notice");
  const offline = byId("offline");
  const refused = byId("refused");
  const list = byId("tickets");
  const liveTitle = byId("live-title");
  const live = byId("live");
  const pause = byId("pause");
  const resume = byId("resume");
  const stop = byId("stop");

  /** What the run says it is on its way to doing, in words rather than a verb. */
  const ON_ITS_WAY = {
    pause: "pausing after this ticket",
    stop: "stopping after this ticket"
  };

  pause.addEventListener("click", function () { send("/api/queue/pause"); });
  resume.addEventListener("click", function () { send("/api/queue/resume"); });
  stop.addEventListener("click", function () { send("/api/queue/stop"); });

  /**
   * Gives the run a control. Nothing is done with what comes back when it works:
   * the change reaches this page the same way it reaches every other one open.
   * A refusal is the reader's to see, since they are the one who asked.
   */
  function send(path) {
    refused.hidden = true;
    fetch(path, { method: "POST" })
      .then(function (response) {
        if (response.ok) return null;
        return response.json().then(function (body) {
          throw new Error(body.error || "The Supervisor refused that");
        });
      })
      .catch(function (error) {
        refused.textContent = error.message;
        refused.hidden = false;
      });
  }

  /**
   * What the page knows about each ticket beyond what the queue says: whether the
   * reader has opened it, the attempts last read for it (null if that failed), and
   * the ticket as it stood when they were read, so a ticket that has moved on is
   * one whose history is asked for again.
   */
  const readers = new Map();
  let tickets = [];
  /**
   * The run's own state, kept because a ticket's controls belong to the run as
   * much as to the ticket: a stopped run runs nothing again, whatever its tickets
   * are still reported as.
   */
  let queueState = "idle";

  const stream = new EventSource("/api/events");
  stream.addEventListener("open", function () { offline.hidden = true; });
  stream.addEventListener("error", function () { offline.hidden = false; });
  stream.addEventListener("queue", function (event) { showQueue(JSON.parse(event.data)); });
  stream.addEventListener("output", function (event) { showOutput(JSON.parse(event.data)); });

  function readerOf(ticketId) {
    let reader = readers.get(ticketId);
    if (!reader) {
      reader = { open: false, attempts: undefined, read: null };
      readers.set(ticketId, reader);
    }
    return reader;
  }

  /** What a ticket's history was read under; anything else means read it again. */
  function stamp(ticket) { return ticket.state + ":" + ticket.attempts; }

  function showQueue(queue) {
    queueState = queue.state;
    statePill.textContent = queue.state;
    statePill.dataset.state = queue.state;
    // The one thing the start panel goes on: whether there is a run to stay out
    // of the way of.
    document.body.dataset.queueState = queue.state;
    branch.textContent = queue.branch === null ? "no run yet" : queue.branch;

    instruction.textContent = ON_ITS_WAY[queue.instruction] || "";
    instruction.hidden = !queue.instruction;

    // The run breaking down and the remote refusing the branch are different
    // troubles, and both are things the reader has to be told about.
    const trouble = queue.error || queue.pushFailure;
    notice.textContent = trouble || "";
    notice.hidden = !trouble;

    showControls(queue);

    tickets = queue.tickets;
    showTickets();
  }

  /**
   * Only the controls the run would actually obey. A button that answers "this
   * run is completed, so there is nothing to pause" is a button that should not
   * have been there to press.
   */
  function showControls(queue) {
    const running = queue.state === "running";
    // A run the user paused and one the usage limit paused are picked up the
    // same way; only the reason they stopped differs.
    const held = queue.state === "paused" || queue.state === "paused-on-limit";
    // Asking again for what has already been asked for does nothing, so it is
    // not offered — but taking a pause back before it lands is a real thing to want.
    const pausing = running && queue.instruction === "pause";

    pause.hidden = !running || queue.instruction !== null;
    resume.hidden = !(held || pausing);
    resume.textContent = pausing ? "Cancel pause" : "Resume";
    stop.hidden = !(held || (running && queue.instruction !== "stop"));
  }

  function showTickets() {
    // The list is rebuilt whenever the queue moves, which would otherwise drop the
    // keyboard wherever it was standing — mid-run, that happens under the reader.
    const wasOn = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.focus
      : undefined;

    if (tickets.length === 0) {
      list.replaceChildren(hint("No run has started yet."));
    } else {
      list.replaceChildren.apply(list, tickets.map(ticketItem));
    }

    if (wasOn) {
      const again = list.querySelector('[data-focus="' + CSS.escape(wasOn) + '"]');
      if (again) again.focus({ preventScroll: true });
    }

    // A ticket stays open across its every retry, so an open one has attempts to
    // read long before it has finished having them.
    tickets.forEach(function (ticket) {
      const reader = readerOf(ticket.id);
      if (reader.open && reader.read !== stamp(ticket)) loadAttempts(ticket);
    });
  }

  function ticketItem(ticket) {
    const reader = readerOf(ticket.id);

    const item = document.createElement("li");
    item.className = "ticket";
    item.dataset.state = ticket.state;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "ticket-head";
    head.dataset.focus = ticket.id;
    head.setAttribute("aria-expanded", String(reader.open));
    head.addEventListener("click", function () { toggle(ticket.id); });
    head.append(
      element("span", "dot", ""),
      element("span", "ticket-title", ticket.title),
      element("span", "ticket-state", stateLabel(ticket))
    );
    item.append(head);

    if (ticket.failure) item.append(element("p", "failure", ticket.failure));
    // A ticket that failed is the one worth another go; one still waiting is the
    // only one that can still be called off. Neither is offered on a run that has
    // been stopped, which is over and runs nothing again.
    if (queueState !== "stopped") {
      if (ticket.state === "failed") item.append(ticketControl(ticket, "retry", "Run it again"));
      if (ticket.state === "pending") item.append(ticketControl(ticket, "skip", "Take it out"));
    }
    if (reader.open) item.append(attemptsBox(ticket));
    return item;
  }

  function ticketControl(ticket, control, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control ticket-control";
    button.dataset.focus = ticket.id + ":" + control;
    button.textContent = label;
    button.addEventListener("click", function () {
      send("/api/queue/tickets/" + encodeURIComponent(ticket.id) + "/" + control);
    });
    return button;
  }

  /** A ticket on its second go says so, since that is the interesting one. */
  function stateLabel(ticket) {
    return ticket.attempts > 1 ? ticket.state + " · attempt " + ticket.attempts : ticket.state;
  }

  function toggle(ticketId) {
    const reader = readerOf(ticketId);
    reader.open = !reader.open;
    showTickets();
  }

  function attemptsBox(ticket) {
    const box = document.createElement("div");
    box.className = "attempts";
    const attempts = readerOf(ticket.id).attempts;

    if (attempts === undefined) box.append(hint("Reading this ticket's attempts…"));
    else if (attempts === null) box.append(retry(ticket));
    else if (attempts.length === 0) box.append(hint("Nothing has been attempted yet."));
    else box.append.apply(box, attempts.map(attemptCard));

    return box;
  }

  /**
   * What a phone that lost the network for a moment is left with. Asking again is
   * the reader's to do: nothing else on the page would ever ask a second time.
   */
  function retry(ticket) {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "hint retry";
    again.textContent = "This ticket's attempts could not be read. Try again.";
    again.addEventListener("click", function () {
      readerOf(ticket.id).attempts = undefined;
      loadAttempts(ticket);
      showTickets();
    });
    return again;
  }

  function attemptCard(attempt) {
    const card = document.createElement("article");
    card.className = "attempt";
    card.append(element("p", "attempt-head", attempt.outcome + " · " + when(attempt.recordedAt)));
    if (attempt.failure) card.append(element("p", "failure", attempt.failure));
    card.append(element("pre", "log", attempt.output || "(nothing was printed)"));
    return card;
  }

  function loadAttempts(ticket) {
    const reader = readerOf(ticket.id);
    // Stamped before the fetch, so a run moving on while it is in flight is what
    // asks for the next one — not every repaint in between.
    reader.read = stamp(ticket);

    fetch("/api/queue/tickets/" + encodeURIComponent(ticket.id) + "/attempts")
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (attempts) { reader.attempts = attempts; })
      .catch(function () { reader.attempts = null; })
      .then(showTickets);
  }

  function showOutput(event) {
    liveTitle.textContent = event.ticketId
      ? "Live output — " + event.ticketId
      : "Live output";

    // A reader who has scrolled back is reading something; only a log already at
    // the bottom follows the Run down.
    const following = live.scrollTop + live.clientHeight >= live.scrollHeight - 8;
    // A ticket being attempted that has printed nothing yet is not the same as
    // nothing being attempted — between a refused attempt and its retry, it is
    // exactly what the reader is looking at.
    live.textContent = event.output || (event.ticketId
      ? "The attempt has not printed anything yet."
      : "Nothing is being attempted right now.");
    if (following) live.scrollTop = live.scrollHeight;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function hint(text) { return element("p", "hint", text); }

  function when(recordedAt) {
    const at = new Date(recordedAt);
    return isNaN(at.getTime()) ? recordedAt : at.toLocaleString();
  }
})();
`;
