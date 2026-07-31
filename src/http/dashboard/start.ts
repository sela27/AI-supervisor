/**
 * The start panel: pick a Ticket Source, see the Queue it would build, edit that
 * Queue, and start the run. Every edit goes back through the preview, so the
 * dependency rules are answered by the Supervisor that will run the queue rather
 * than by a second copy of them living in the browser.
 *
 * Plain browser JavaScript, for the reasons set out in `client.ts`. It knows
 * nothing of the live view: `<body data-queue-state>` is what tells the page
 * whether there is a run under way, and the stylesheet keeps this panel out of
 * the way while there is.
 */
export const START_SCRIPT = String.raw`
(function () {
  const byId = function (id) { return document.getElementById(id); };
  const source = byId("source");
  const startAt = byId("start-at");
  const look = byId("look");
  const start = byId("start");
  const notice = byId("start-notice");
  const list = byId("edited-queue");

  /**
   * The user's own edit. Its order holds every ticket the source has, not only
   * the ones still in — a ticket put back has to go back where it belongs rather
   * than on the end behind the tickets that were waiting on it.
   */
  const edit = { exclude: [], order: [] };
  /** The queue as the Supervisor last reported it under that edit. */
  let edited = null;
  /** Every ticket the source has, from the unedited preview: the master list. */
  let all = [];

  look.addEventListener("click", function () {
    edit.exclude = [];
    edit.order = [];
    ask(edit)
      .then(function (preview) {
        all = preview.tickets;
        edit.order = all.map(idOf);
        show(preview);
      })
      .catch(complain);
  });

  start.addEventListener("click", function () {
    post("/api/queue/start", Object.assign({ queue: edit }, chosenHour()))
      .then(function () {
        // The run is under way, or armed for later; the live view takes the page
        // from here either way.
        notice.hidden = true;
        list.replaceChildren();
        edited = null;
        start.hidden = true;
      })
      .catch(complain);
  });

  /**
   * The hour to begin at, if the reader picked one. The field is in their own
   * time, which is the only time they think in at eleven at night; the Supervisor
   * is told the moment itself, which has no timezone to be wrong about.
   *
   * An hour that will not read is handed over exactly as it was written, so the
   * Supervisor refuses it. This page decides nothing: quietly dropping it would
   * start a run tonight that somebody had armed for tomorrow.
   */
  function chosenHour() {
    if (startAt.value === "") return {};
    const when = new Date(startAt.value);
    return { startAt: isNaN(when.getTime()) ? startAt.value : when.toISOString() };
  }

  function idOf(ticket) { return ticket.id; }

  function ask(queue) { return post("/api/queue/preview", { queue: queue }); }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({}, chosenSource(), body)),
    }).then(function (response) {
      return response.json().then(function (answered) {
        if (!response.ok) throw new Error(answered.error || "The Supervisor refused that");
        return answered;
      });
    });
  }

  /** Saying nothing about the source is asking for the one the instance was configured with. */
  function chosenSource() {
    const directory = source.value.trim();
    return directory === "" ? {} : { source: { type: "local", directory: directory } };
  }

  /**
   * Tries an edit against the Supervisor and keeps it only if it would run. An
   * order the blocking edges forbid leaves the queue exactly as it was, so the
   * list on the page is always one the user could press Start on.
   */
  function apply(next) {
    const before = { exclude: edit.exclude, order: edit.order };
    edit.exclude = next.exclude;
    edit.order = next.order;

    ask(edit)
      .then(show)
      .catch(function (error) {
        edit.exclude = before.exclude;
        edit.order = before.order;
        complain(error);
        render();
      });
  }

  function show(preview) {
    edited = preview;
    notice.hidden = true;
    render();
  }

  function complain(error) {
    notice.textContent = error.message;
    notice.hidden = false;
  }

  function render() {
    if (edited === null) {
      list.replaceChildren();
      start.hidden = true;
      return;
    }

    const rows = edited.tickets.map(function (ticket, index) {
      return row(ticket, index, false);
    });
    edited.excluded.forEach(function (id) {
      const ticket = all.find(function (candidate) { return candidate.id === id; });
      if (ticket) rows.push(row(ticket, -1, true));
    });

    list.replaceChildren.apply(list, rows);
    // A queue with nothing in it is not a run; the whole source having been
    // excluded is the one way to arrive there.
    start.hidden = edited.tickets.length === 0;
  }

  function row(ticket, index, isOut) {
    const item = document.createElement("li");
    item.className = "ticket queue-row";
    if (isOut) item.dataset.state = "skipped";

    item.append(include(ticket, isOut), title(ticket, isOut));
    if (!isOut) item.append(moves(index));
    return item;
  }

  function include(ticket, isOut) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "include";
    box.checked = !isOut;
    box.id = "include-" + ticket.id;
    // A ticket that came out because its blocker did is not the user's to put
    // back: putting the blocker back is. Saying so beats a box that springs back.
    box.disabled = isOut && edit.exclude.indexOf(ticket.id) === -1;
    box.addEventListener("change", function () {
      apply({
        exclude: box.checked
          ? edit.exclude.filter(function (id) { return id !== ticket.id; })
          : edit.exclude.concat([ticket.id]),
        order: edit.order,
      });
    });
    return box;
  }

  function title(ticket, isOut) {
    const label = document.createElement("label");
    label.className = "ticket-title";
    label.htmlFor = "include-" + ticket.id;
    label.textContent = ticket.title;
    if (isOut) label.append(element("span", "ticket-state", waitingOn(ticket) || "left out"));
    else if (ticket.state !== "ready") label.append(element("span", "ticket-state", ticket.state));
    return label;
  }

  /** Which excluded blocker took this ticket with it, when one did. */
  function waitingOn(ticket) {
    const blocker = ticket.blockedBy.find(function (id) {
      return edited.excluded.indexOf(id) !== -1;
    });
    return blocker === undefined ? "" : "waiting on " + blocker;
  }

  function moves(index) {
    const box = document.createElement("span");
    box.className = "moves";
    box.append(move(index, -1, "↑", "Run earlier"), move(index, 1, "↓", "Run later"));
    return box;
  }

  function move(index, by, glyph, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control move";
    button.textContent = glyph;
    button.setAttribute("aria-label", label);
    button.disabled = index + by < 0 || index + by >= edited.tickets.length;
    button.addEventListener("click", function () { swap(index, index + by); });
    return button;
  }

  /**
   * Swaps two tickets that are next to each other in the queue as shown. They may
   * have an excluded ticket between them in the full arrangement, which is why the
   * swap is done by where each one actually sits rather than by what is on screen.
   */
  function swap(from, to) {
    const shown = edited.tickets.map(idOf);
    const order = edit.order.slice();
    const a = order.indexOf(shown[from]);
    const b = order.indexOf(shown[to]);
    const moved = order[a];
    order[a] = order[b];
    order[b] = moved;
    apply({ exclude: edit.exclude, order: order });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
})();
`;
