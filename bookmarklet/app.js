// The dashboard: a search form, the trains of the window with their free seats,
// and a split-ticket check for the train clicked. Mustache templates fed by
// core.js. Runs inside the iframe that loader.js opens on ebilet.intercity.pl.
(function () {
  "use strict";

  var svc = GetATicket.createService();

  var PAGE = `
  <header>
    <h1>Get a ticket <button type="button" id="close" title="Wróć do strony e-IC">zamknij ✕</button></h1>
    <p>Wolne miejsca w PKP Intercity</p>
  </header>

  <main>
    <!-- Step 1: nothing is fetched until the form is submitted. -->
    <form id="search">
      <!-- The hidden inputs carry the EVA codes; they stay empty until a station is picked from the list. -->
      <input type="hidden" name="from" id="from">
      <input type="hidden" name="to" id="to">
      <div class="station">
        <label>Z: <input type="search" id="from-query" data-field="from" placeholder="np. Warszawa" autocomplete="off" required></label>
        <div class="station-results" id="from-results"></div>
      </div>
      <div class="station">
        <label>Do: <input type="search" id="to-query" data-field="to" placeholder="np. Kraków" autocomplete="off" required></label>
        <div class="station-results" id="to-results"></div>
      </div>
      <label>Data <input type="date" name="date" id="date" required></label>
      <label>Od <input type="time" name="from_time" id="from-time" required></label>
      <label>Do <input type="time" name="to_time" id="to-time" required></label>
      <label>Miejsca <input type="number" name="seats" id="seats" value="1" min="1" max="6" required></label>
      <button type="submit">Sprawdź</button>
    </form>

    <!-- Step 2: both stay empty until the first search. -->
    <section id="summary" aria-live="polite"></section>
    <section id="trains"></section>

    <!-- Step 3: filled by clicking a train row. -->
    <section id="splits" aria-live="polite"></section>
  </main>

  <footer>Nieoficjalne &middot; tylko odczyt, nic nie jest rezerwowane
    <!-- Everything worth knowing but not worth reading on every search. -->
    <details id="about">
      <summary>Jak to działa?</summary>
      <ul>
        <li>Wolne miejsca są liczone na schemacie miejsc e-IC, bez miejsc dla osób na wózkach, opiekunów i rowerów; ceny pochodzą ze sprawdzenia ceny.</li>
        <li>Schemat miejsc to jedno zapytanie na wagon, więc sam sprawdza się tylko dla pierwszych pociągów z listy; zapytania są rozłożone w czasie, a gdy e-IC zacznie je odrzucać, aplikacja robi przerwę.</li>
        <li>Najedź na liczbę miejsc, aby zobaczyć ich numery.</li>
        <li>Bilet łączony to dwa bilety na ten sam pociąg: licz się z przesiadką na inne miejsce na stacji pośredniej i z ceną wyższą niż za bilet na całą trasę.</li>
        <li>Bilety łączone są sprawdzane tylko w klasach, w których brakuje miejsc na całej trasie. Liczenie kończy się, gdy na odcinku jest dość miejsc, więc „3+” znaczy co najmniej 3.</li>
        <li>Zapytania wysyła Twoja przeglądarka, z tej strony e-IC. Godziny sprawdzenia są w czasie warszawskim.</li>
      </ul>
    </details>
  </footer>`;

  var TEMPLATES = {
    summary: `
    <div class="verdict {{#any_with_seats}}ok{{/any_with_seats}}{{^any_with_seats}}bad{{/any_with_seats}}" id="verdict">{{verdict}}</div>
    <!-- One row per class: a clean class 1 says nothing about class 2. -->
    {{#classes}}
    <div class="class-row" data-class="{{class}}">
      <h3>Klasa {{class}} <span class="muted">wolnych miejsc: {{free_seats}}</span></h3>
      <!-- Short captions; the full meaning of each tile lives in its tooltip. -->
      <div class="tiles">
        <div class="tile ok" title="Pociągi z min. {{seats_requested}} wolnymi miejscami (z {{checked}} sprawdzonych)"><b>{{with_seats}}</b><span>są miejsca</span></div>
        <div class="tile warn" title="Za mało wolnych miejsc albo niezweryfikowane"><b>{{limited}}</b><span>za mało</span></div>
        <div class="tile warn" title="Komplet, sprzedawany jest bilet bez gwarancji miejsca"><b>{{no_seat_guarantee}}</b><span>bez miejscówki</span></div>
        <div class="tile bad" title="Komplet albo brak w sprzedaży"><b>{{unavailable}}</b><span>brak</span></div>
      </div>
    </div>
    {{/classes}}
    {{^all_checked}}<p class="muted" id="partial">Sprawdzono pociągów: {{checked}} z {{total}} &middot; przy pozostałych kliknij „sprawdź miejsca”.</p>{{/all_checked}}
    <p class="muted">Sprawdzono o {{checked_at_time}} &middot; „Sprawdź” odświeża</p>`,

    trains: `
    <h2>{{date}} &middot; odjazdy {{from_time}}–{{to_time}}</h2>
    {{^has_trains}}<p class="muted" id="no-trains">Brak bezpośrednich pociągów PKP Intercity w tym przedziale.</p>{{/has_trains}}
    {{#has_trains}}
    <p class="muted hint">Kliknij pociąg &rarr; bilety łączone</p>
    <table>
      <thead><tr><th>Pociąg</th><th>Odjazd</th><th>Przyjazd</th><th>Czas</th><th title="Cena za osobę">Wolne miejsca &middot; cena</th><th></th></tr></thead>
      <tbody>
        {{#trains}}
        <tr data-train="{{id}}" tabindex="0">
          <td><span class="cat">{{category}}</span> {{number}} <span class="muted">{{name}}</span></td>
          <td>{{departure_time}}</td><td>{{arrival_time}}</td><td>{{duration}}</td>
          <!-- Prices arrive for all rows at once; seat maps only for the first few and on request. -->
          <td class="avail"><span class="muted">sprawdzam…</span></td>
          <td><a href="{{buy_url}}" target="_blank" rel="noopener" title="Otwórz to połączenie w e-IC">e-IC &nearr;</a></td>
        </tr>
        {{/trains}}
      </tbody>
    </table>
    {{/has_trains}}`,

    avail: `
    {{#offers}}
    <!-- Seat numbers stay in the tooltip; the row only answers "how many, how much". -->
    <div class="offer-row" data-class="{{class}}"><span class="cls">kl.{{class}}</span>
      <span class="badge {{status}}" title="{{free_seat_list}}">{{label}}</span>{{^is_unavailable}} <span class="muted">{{price_per_person_pln}} zł</span>{{/is_unavailable}}</div>
    {{/offers}}
    {{#detail}}<span class="badge {{status}}">{{status_label}}</span> <span class="muted">{{detail}}</span>{{/detail}}
    {{#seats_pending}}<button type="button" class="check-seats">sprawdź miejsca</button>{{/seats_pending}}`,

    splits: `
    <h2>Bilety łączone &middot; {{train}} &middot; miejsc: {{seats_requested}}</h2>
    {{#detail}}<p class="muted">{{detail}}.</p>{{/detail}}
    {{^detail}}
    <div class="verdict {{#has_viable}}ok{{/has_viable}}{{^has_viable}}bad{{/has_viable}}" id="split-verdict">
      {{#has_viable}}Są miejsca na dwóch biletach.{{/has_viable}}
      {{^has_viable}}Brak miejsc na obu odcinkach.{{/has_viable}}
    </div>
    <!-- The one caveat that changes the decision stays visible; the rest is in "Jak to działa?". -->
    {{#has_viable}}<p class="muted">Dwa bilety = możliwa zmiana miejsca, wyższa cena.</p>{{/has_viable}}
    {{/detail}}
    {{#splits}}
    <div class="split" data-via="{{via_eva}}">
      <h3>przez {{via}} <span class="muted">przyj. {{arrival_time}} / odj. {{departure_time}}</span>
        {{#viable}}<span class="badge available">miejsca na obu odcinkach</span>{{#total_per_person_pln}} <span class="muted">od {{total_per_person_pln}} zł za osobę</span>{{/total_per_person_pln}}{{/viable}}
        {{^viable}}<span class="badge unavailable">brak</span>{{/viable}}</h3>
      {{#first}}
      <div class="leg"><span class="leg-route">{{departure_time}} {{from}} &rarr; {{arrival_time}} {{to}}</span>
        {{#classes}}<span class="cls">kl.{{class}}</span><span class="badge {{#enough}}available{{/enough}}{{^enough}}unavailable{{/enough}}" title="{{free_seat_list}}">wolne: {{free_seats}}{{#enough}}+{{/enough}}</span>{{#price_per_person_pln}} <span class="muted">{{price_per_person_pln}} zł</span>{{/price_per_person_pln}}{{/classes}}
        <span class="muted">{{detail}}</span>{{#buy_url}} <a href="{{buy_url}}" target="_blank" rel="noopener" title="Otwórz ten odcinek w e-IC">e-IC &nearr;</a>{{/buy_url}}</div>
      {{/first}}
      {{#second}}
      <div class="leg"><span class="leg-route">{{departure_time}} {{from}} &rarr; {{arrival_time}} {{to}}</span>
        {{#classes}}<span class="cls">kl.{{class}}</span><span class="badge {{#enough}}available{{/enough}}{{^enough}}unavailable{{/enough}}" title="{{free_seat_list}}">wolne: {{free_seats}}{{#enough}}+{{/enough}}</span>{{#price_per_person_pln}} <span class="muted">{{price_per_person_pln}} zł</span>{{/price_per_person_pln}}{{/classes}}
        {{^checked}}<span class="muted">nie sprawdzano &mdash; brak miejsc na pierwszym odcinku</span>{{/checked}}
        <span class="muted">{{detail}}</span>{{#buy_url}} <a href="{{buy_url}}" target="_blank" rel="noopener" title="Otwórz ten odcinek w e-IC">e-IC &nearr;</a>{{/buy_url}}</div>
      {{/second}}
    </div>
    {{/splits}}
    <p class="muted">Sprawdzono stacji: {{checked_stops}} z {{route_stops}} &middot; {{checked_at_time}}</p>`,

    stations: `
    {{#too_short}}<p class="muted">Wpisz co najmniej 2 znaki.</p>{{/too_short}}
    {{#none_found}}<p class="muted no-stations">Żadna stacja nie pasuje do „{{query}}”.</p>{{/none_found}}
    <ul>
      {{#stations}}
      <li><button type="button" data-eva="{{eva}}" data-name="{{name}}">{{name}}</button></li>
      {{/stations}}
    </ul>`,
  };

  document.body.innerHTML = PAGE;
  var $ = function (id) { return document.getElementById(id); };

  // Default to two hours in Warsaw, starting at the nearest half hour; a tie goes
  // to the full hour (17:15 -> 17:00, 18:45 -> 19:00).
  (function () {
    var now = GetATicket.warsawWall(new Date());
    var m = now.getUTCMinutes();
    now.setUTCMinutes(m <= 15 ? 0 : m < 45 ? 30 : 60, 0, 0);
    var until = new Date(now.getTime() + 2 * 3600 * 1000);
    // The window stays within one day: late in the evening it ends at 23:59.
    if (until.getUTCDate() !== now.getUTCDate()) { until = new Date(now.getTime()); until.setUTCHours(23, 59); }
    $("date").value = now.toISOString().slice(0, 10);
    $("from-time").value = now.toISOString().slice(11, 16);
    $("to-time").value = until.toISOString().slice(11, 16);
  })();

  var AUTO_SCAN = 5;       // trains whose seat maps are read without asking: a map costs a call per wagon
  var search = 0;          // bumps on every new search; answers to older ones are dropped
  var found = null;        // {trains, results} of the search shown; a result is null until the train's seats are checked
  var selectedTrain = null;
  var splitCheck = null;   // AbortController of the split check in flight

  function render(target, template, data) { target.innerHTML = Mustache.render(TEMPLATES[template], data); }

  function message(target, className, text) {
    var box = document.createElement(className === "error" ? "span" : "p");
    box.className = className;
    box.textContent = text;
    target.replaceChildren(box);
  }

  // Deep link into the e-IC search, as its web app reads it from the URL: stations (EVA),
  // date and time of a wall-clock departure, direct trains only. Opens in a new tab, so the
  // dashboard and its results stay.
  function eicLink(from, to, departure) {
    var iso = typeof departure === "string" ? departure : departure.toISOString();
    return "https://ebilet.intercity.pl/wyszukiwanie?" +
      new URLSearchParams({ dwyj: iso.slice(0, 10), swyj: from, sprzy: to, time: iso.slice(11, 16), polbez: 1 });
  }

  function params() { return Object.fromEntries(new FormData($("search"))); }

  function markSelected() {
    document.querySelectorAll("#trains tr[data-train]").forEach(function (row) {
      row.classList.toggle("selected", row.dataset.train === selectedTrain);
    });
  }

  // Drops the results and the train detail.
  function resetResults() {
    search++;
    found = null;
    selectedTrain = null;
    if (splitCheck) splitCheck.abort();
    ["summary", "trains", "splits"].forEach(function (id) { $(id).replaceChildren(); });
  }

  function showSummary() {
    var sum = svc.summaryOf(found.trains, found.results, +params().seats);
    // Nothing checked yet is no verdict; the first seat map is already on its way.
    if (sum.total && !sum.checked) message($("summary"), "muted", "Sprawdzam miejsca…");
    else render($("summary"), "summary", sum);
  }

  // Reads the seat map of one row's train and counts it into the summary.
  function checkSeats(row) {
    var mine = search, cell = row.querySelector(".avail"), id = row.dataset.train;
    message(cell, "muted", "sprawdzam…");
    return svc.availability(id, params()).then(function (a) {
      if (mine !== search) return;
      render(cell, "avail", a);
      found.results[found.trains.findIndex(function (t) { return t.id === id; })] = a;
      showSummary();
    }, function (err) { if (mine === search) message(cell, "error", err.message); });
  }

  function load() {
    var mine = search, p = params();
    svc.connections(p).then(async function (data) {
      if (mine !== search) return;
      (data.trains || []).forEach(function (t) { t.buy_url = eicLink(p.from, p.to, t.departure); });
      render($("trains"), "trains", data);
      var rows = Array.from(document.querySelectorAll("#trains tr[data-train]"));
      var prices = await svc.prices(rows.map(function (row) { return row.dataset.train; }), p);
      if (mine !== search) return;
      // A train with nothing for a seat map to verify is settled by its price check.
      found = { trains: data.trains, results: prices.map(function (a) { return a.seats_pending ? null : a; }) };
      rows.forEach(function (row, i) { render(row.querySelector(".avail"), "avail", prices[i]); });
      showSummary();
      var auto = rows.filter(function (row, i) { return prices[i].seats_pending; }).slice(0, AUTO_SCAN);
      for (var row of auto) {
        if (mine !== search) return;
        await checkSeats(row);
      }
    }).catch(function (err) {
      if (mine !== search) return;
      $("summary").replaceChildren();
      message($("trains"), "error", err.message);
    });
  }

  $("search").addEventListener("submit", function (evt) {
    evt.preventDefault();
    resetResults();
    message($("summary"), "muted", "Sprawdzam miejsca… (do minuty)");
    message($("trains"), "muted", "Wczytuję rozkład…");
    load();
  });

  // A split check reads seat maps leg by leg, so it only ever runs for the one
  // train clicked; a click on another row replaces the check still in flight.
  function checkSplits(row) {
    if (splitCheck) splitCheck.abort();
    var check = splitCheck = new AbortController();
    selectedTrain = row.dataset.train;
    markSelected();
    message($("splits"), "muted", "Sprawdzam odcinki… (do minuty)");
    var p = params();
    svc.splits(selectedTrain, p, check.signal).then(function (report) {
      if (check.signal.aborted) return;
      // One link per ticket, also for a split without seats: seats come back as people cancel.
      (report.splits || []).forEach(function (sp) {
        sp.first.buy_url = eicLink(p.from, sp.via_eva, sp.first.ref.departure);
        sp.second.buy_url = eicLink(sp.via_eva, p.to, sp.second.ref.departure);
      });
      render($("splits"), "splits", report);
    }, function (err) { if (!check.signal.aborted) message($("splits"), "error", err.message); });
  }

  $("trains").addEventListener("click", function (evt) {
    var row = evt.target.closest("tr[data-train]");
    if (!row || evt.target.closest("a")) return; // the e-IC link is not a split check
    if (evt.target.closest(".check-seats")) checkSeats(row); else checkSplits(row);
  });
  $("trains").addEventListener("keyup", function (evt) {
    if (evt.key === "Enter" && evt.target.matches("tr[data-train]")) checkSplits(evt.target);
  });

  // A station field: typing searches, a click on a result picks. Only a pick sets the
  // EVA code, so typed text alone never passes the form's validation.
  ["from", "to"].forEach(function (field) {
    var input = $(field + "-query"), results = $(field + "-results");
    var typing = null, stationQuery = 0;
    var NOT_PICKED = "Wybierz stację z listy.";
    input.setCustomValidity(NOT_PICKED);

    input.addEventListener("input", function () {
      clearTimeout(typing);
      $(field).value = "";
      input.setCustomValidity(NOT_PICKED);
      // Results for the previous route would mislead; the user searches again with "Sprawdź".
      resetResults();
      var q = input.value, mine = ++stationQuery;
      if (!q) { results.replaceChildren(); return; }
      typing = setTimeout(function () {
        svc.stations(q).then(function (data) {
          if (mine === stationQuery) render(results, "stations", data);
        }, function (err) { if (mine === stationQuery) message(results, "error", err.message); });
      }, 300);
    });
    // Enter here must not submit the search form.
    input.addEventListener("keydown", function (evt) { if (evt.key === "Enter") evt.preventDefault(); });

    results.addEventListener("click", function (evt) {
      var button = evt.target.closest("button[data-eva]");
      if (!button) return;
      stationQuery++; // drops a search still in flight
      $(field).value = button.dataset.eva;
      input.value = button.dataset.name;
      input.setCustomValidity("");
      results.replaceChildren();
    });
  });

  $("close").addEventListener("click", function () { window.frameElement.remove(); });
})();
