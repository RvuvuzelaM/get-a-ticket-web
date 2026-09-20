// Read-only seat check on top of the undocumented public API behind
// ebilet.intercity.pl: it searches timetables, asks for prices and reads seat
// maps; it never reserves or buys anything. It must run in a page of
// ebilet.intercity.pl: the gateway answers only its own web app's Origin, and
// blocks data-centre IPs, so the calls have to come from the visitor's browser.
// Results are plain JSON with pre-formatted display fields, because app.js
// renders them with logic-less Mustache templates.
//
// Times are Warsaw wall-clock throughout, kept in Dates whose UTC fields hold
// the wall-clock value: upstream only speaks wall-clock, and the visitor's own
// time zone must not leak in.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GetATicket = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BASE_URL = "https://api-gateway.intercity.pl/server/public/endpoint";
  var GRM_URL = "https://api-gateway.intercity.pl/grm";
  var WEB_ORIGIN = "https://ebilet.intercity.pl";
  var DEVICE_NUMBER = 956; // the e-IC web app's "urzadzenieNr"
  var APP_VERSION = "1.5.20";
  var NORMAL_FARE_DISCOUNT = 1010; // "kodZakupowyZnizki" of a full-price adult
  var SINGLE_DOMESTIC = 1; // "biletTyp"
  var ERR_NO_TRAINS = 89; // upstream reports an empty search result as an error
  var MAX_PRICE_BATCH = 6; // more connections per price check fail with "Method incorrectly called"
  var REQUEST_TIMEOUT_MS = 20000;
  var BLOCK_STATUSES = [403, 418, 429]; // how upstream's Akamai turns a client away
  var BLOCK_COOLDOWN_MS = 2 * 60000; // doubles with every block in a row
  var MAX_BLOCK_COOLDOWN_MS = 30 * 60000;

  var MAX_SEATS = 6; // upstream sells at most 6 passengers per transaction
  var MAX_SEARCH_PAGES = 6;
  var MAX_STATION_HITS = 15;
  var MAX_SPLIT_STOPS = 5; // intermediate stops tried per split check
  var MINUTE = 60000;

  var DEFAULTS = { from: 5100065, to: 5100081, from_time: "14:00", to_time: "18:00", seats: 1 };

  // ---- wall-clock time -------------------------------------------------

  function pad(n, width) { return String(n).padStart(width || 2, "0"); }

  function wall(y, mo, d, h, mi, s) { return new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0)); }

  // The Warsaw wall clock of a real instant.
  function warsawWall(instant) {
    var parts = {};
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Warsaw", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(instant).forEach(function (p) { parts[p.type] = Number(p.value); });
    return wall(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  }

  function fmtDate(t) { return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate()); }
  function fmtClock(t) { return pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes()); }
  function fmtClockSec(t) { return fmtClock(t) + ":" + pad(t.getUTCSeconds()); }
  function fmtUpstream(t) { return fmtDate(t) + " " + fmtClockSec(t); } // "2026-09-22 08:08:00"
  function fmtCompact(t) { return fmtUpstream(t).replace(/\D/g, "").slice(0, 12); } // "202609220808"
  function fmtISO(t) { return fmtDate(t) + "T" + fmtClockSec(t); } // wall-clock, no offset

  function parseUpstream(raw) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw || "");
    return m ? wall(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]) : null;
  }

  function parseCompact(raw) {
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw || "");
    if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || +m[4] > 23 || +m[5] > 59) return null;
    return wall(+m[1], +m[2], +m[3], +m[4], +m[5]);
  }

  var MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

  // Route stops only: "Tue Sep 22 10:40:00 CEST 2026". Empty means no time.
  function parseRouteTime(raw) {
    if (!raw) return null;
    var m = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \S+ (\d{4})$/.exec(raw);
    if (!m || !MONTHS[m[1]]) throw new Error("błędny czas \"" + raw + "\"");
    return wall(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
  }

  // ---- small helpers ---------------------------------------------------

  function pln(grosze) { return Math.floor(grosze / 100) + "." + pad(grosze % 100); }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function isAbort(err, signal) { return (signal && signal.aborted) || (err && err.name === "AbortError"); }

  // One task at a time, in order.
  function serial() {
    var tail = Promise.resolve();
    return function (task) {
      var run = tail.then(task);
      tail = run.catch(function () {});
      return run;
    };
  }

  function ttlCache(ttlMs, clock) {
    var entries = new Map();
    return {
      get: function (key) {
        var e = entries.get(key);
        if (!e || clock() > e.expires) { entries.delete(key); return undefined; }
        return e.value;
      },
      set: function (key, value) { entries.set(key, { value: value, expires: clock() + ttlMs }); },
    };
  }

  function apiErrorMessage(e) {
    var opisy = (e && e.opisy) || [];
    for (var i = 0; i < opisy.length; i++) if (opisy[i].jezyk === "PL") return opisy[i].komunikat;
    return opisy.length ? opisy[0].komunikat : "nieznany błąd e-IC";
  }

  // ---- e-IC client -----------------------------------------------------

  // The browser supplies Origin, Referer, User-Agent and the Sec-* headers
  // itself; that they are genuine is the whole point of running here.
  function createClient(opts) {
    opts = opts || {};
    var fetchFn = opts.fetch || function (url, init) { return fetch(url, init); };
    var minInterval = opts.minInterval == null ? 400 : opts.minInterval;
    var slowInterval = opts.slowInterval == null ? 2000 : opts.slowInterval;
    var jitter = opts.jitter == null ? 500 : opts.jitter; // a metronome looks like a bot
    var random = opts.random || Math.random;
    // Calls allowed at full pace per window; a longer session slows down instead of stopping.
    var budget = opts.budget == null ? 100 : opts.budget;
    var budgetWindow = opts.budgetWindow == null ? 5 * MINUTE : opts.budgetWindow;
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var clock = opts.clock || Date.now;
    var queue = serial(); // serialises upstream calls so minInterval holds
    var lastCall = 0;
    var tokens = budget, lastRefill = clock();
    var blockedUntil = 0, cooldown = BLOCK_COOLDOWN_MS;

    // Gap before the next call: short while the budget lasts, long once it is spent.
    function nextGap() {
      var t = clock();
      tokens = Math.min(budget, tokens + (t - lastRefill) * budget / budgetWindow);
      lastRefill = t;
      var base = slowInterval;
      if (tokens >= 1) { tokens--; base = minInterval; }
      return base + random() * jitter;
    }

    function blockedError() {
      var err = new Error("e-IC ogranicza zapytania — spróbuj ponownie za " + Math.ceil((blockedUntil - clock()) / MINUTE) + " min");
      err.blocked = true;
      return err;
    }

    // Once upstream turns us away, more calls only deepen the block: nothing goes
    // out until the cooldown ends, calls already queued included.
    function noteStatus(res) {
      if (BLOCK_STATUSES.indexOf(res.status) === -1) {
        if (res.status === 200) cooldown = BLOCK_COOLDOWN_MS;
        return;
      }
      var retryAfter = res.headers && res.headers.get ? parseInt(res.headers.get("Retry-After"), 10) * 1000 : NaN;
      blockedUntil = clock() + Math.max(cooldown, retryAfter || 0);
      cooldown = Math.min(cooldown * 2, MAX_BLOCK_COOLDOWN_MS);
    }

    function send(url, init, label, signal) {
      return queue(async function () {
        if (signal && signal.aborted) throw new DOMException("przerwano", "AbortError");
        if (clock() < blockedUntil) throw blockedError();
        var wait = nextGap() - (clock() - lastCall);
        if (wait > 0) await sleep(wait);
        if (signal && signal.aborted) throw new DOMException("przerwano", "AbortError");
        var timeout = new AbortController();
        var timer = setTimeout(function () { timeout.abort(); }, REQUEST_TIMEOUT_MS);
        var onAbort = function () { timeout.abort(); };
        if (signal) signal.addEventListener("abort", onAbort);
        try {
          init.signal = timeout.signal;
          init.credentials = "include"; // the web app sends its Akamai cookies too
          init.headers = Object.assign({ "Accept": "application/json, text/plain, */*", "App-Version": APP_VERSION }, init.headers);
          var res = await fetchFn(url, init);
          noteStatus(res);
          if (res.status !== 200) throw new Error("e-IC " + label + ": serwer zwrócił HTTP " + res.status);
          return await res.text();
        } catch (err) {
          if (signal && signal.aborted) throw new DOMException("przerwano", "AbortError");
          if (err && err.name === "AbortError") throw new Error("e-IC " + label + ": przekroczono czas oczekiwania");
          if (err instanceof TypeError) throw new Error("e-IC " + label + ": " + err.message);
          throw err;
        } finally {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          lastCall = clock();
        }
      });
    }

    async function post(endpoint, body, signal) {
      body.urzadzenieNr = DEVICE_NUMBER;
      var text = await send(BASE_URL + "/" + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, endpoint, signal);
      try { return JSON.parse(text); } catch (e) { throw new Error("e-IC " + endpoint + ": błąd dekodowania odpowiedzi"); }
    }

    function firstError(resp, what) {
      if (resp.bledy && resp.bledy.length) throw new Error("e-IC, " + what + ": " + apiErrorMessage(resp.bledy[0]));
    }

    function seatMapPath(q) {
      return q.category + "/" + q.number;
    }

    return {
      // Direct and indirect connections departing at or after `departure`.
      // Upstream returns only a handful per call; callers page by moving departure.
      searchConnections: async function (fromEVA, toEVA, departure, signal) {
        var resp = await post("Pociagi", {
          metoda: "wyszukajPolaczenia",
          dataWyjazdu: fmtUpstream(departure), dataPrzyjazdu: fmtUpstream(departure),
          stacjaWyjazdu: fromEVA, stacjaPrzyjazdu: toEVA, stacjePrzez: [],
          polaczeniaNajszybsze: 0, liczbaPolaczen: 0, czasNaPrzesiadkeMin: 3, czasNaPrzesiadkeMax: 1440,
          liczbaPrzesiadekMax: 0, polaczeniaBezposrednie: 1,
          kategoriePociagow: [], kodyPrzewoznikow: [], rodzajeMiejsc: [], typyMiejsc: [], braille: 0,
        }, signal);
        if (resp.bledy && resp.bledy.length && resp.bledy[0].kod === ERR_NO_TRAINS) return [];
        firstError(resp, "wyszukiwanie");
        return resp.polaczenia || [];
      },

      // Stops of one train between two stations, both included. Unlike price
      // checks it wants EVA codes; internal codes yield an empty route.
      route: async function (number, departure, fromEVA, toEVA, signal) {
        var resp = await post("Pociagi", {
          metoda: "pobierzTrasePrzejazdu", jezyk: "PL", numerPociagu: number,
          dataWyjazdu: fmtUpstream(departure), stacjaWyjazdu: fromEVA, stacjaPrzyjazdu: toEVA,
        }, signal);
        firstError(resp, "trasa");
        return (resp.trasePrzejezdu && resp.trasePrzejezdu.trasaPrzejazdu) || [];
      },

      // Prices every query for `passengers` full-fare adults, batching as far
      // as upstream allows. The result maps query ID -> upstream prices.
      checkPrices: async function (queries, passengers, signal) {
        var out = new Map();
        var travellers = [];
        for (var i = 0; i < passengers; i++) travellers.push({ kodZakupowyZnizki: NORMAL_FARE_DISCOUNT });
        for (var batch of chunk(queries, MAX_PRICE_BATCH)) {
          var resp = await post("Sprzedaz", {
            metoda: "sprawdzCenyLite", wersja: APP_VERSION + "_desktop", url: WEB_ORIGIN + "/wyszukiwanie", jezyk: "PL",
            biletTyp: SINGLE_DOMESTIC, ofertyZaznaczone: [], polaczenia: batch, podrozni: travellers,
          }, signal);
          firstError(resp, "ceny");
          (resp.cenyPolaczen || []).forEach(function (cp) { out.set(cp.idPolaczenia, cp); });
        }
        return out;
      },

      stations: async function (signal) {
        var resp = await post("Aktualizacja", { metoda: "pobierzStacje", ostatniaAktualizacjaData: "2020-01-01 00:00:00.000" }, signal);
        firstError(resp, "stacje");
        return resp.stacje || [];
      },

      // Wagons of a train: the data behind the e-IC seat picker.
      composition: async function (q, signal) {
        var url = GRM_URL + "/sklad/wbnet/" + seatMapPath(q) + "/" + fmtCompact(q.departure) + "/" + q.fromEPA + "/" + fmtCompact(q.arrival) + "/" + q.toEPA;
        var text = await send(url, { method: "GET" }, "skład", signal);
        try { return JSON.parse(text); } catch (e) { throw new Error("e-IC, skład: błąd dekodowania odpowiedzi"); }
      },

      // SVG seat map of one wagon; every seat carries its status for the leg.
      // The scheme ("1355,MIXED") goes into the path verbatim, as the web app sends it.
      wagonSeatMap: function (q, wagon, scheme, signal) {
        var url = GRM_URL + "/wagon/svg/wbnet/" + seatMapPath(q) + "/" + wagon + "/" + scheme + "/" +
          fmtCompact(q.departure) + "/" + fmtCompact(q.arrival) + "/" + q.fromEPA + "/" + q.toEPA;
        return send(url, { method: "GET" }, "schemat miejsc", signal);
      },
    };
  }

  // ---- train refs ------------------------------------------------------

  var REF_PATTERN = /^([A-Z]{2,4})-(\d{1,6})-(\d{12})-(\d{1,8})-(\d{1,8})(?:-(\d{12}))?$/;

  // The string form of a ref is the public train ID.
  function refString(r) {
    var id = r.category + "-" + r.number + "-" + fmtCompact(r.departure) + "-" + r.fromCode + "-" + r.toCode;
    return r.arrival ? id + "-" + fmtCompact(r.arrival) : id;
  }

  function parseTrainRef(id) {
    var m = REF_PATTERN.exec(id);
    if (!m) throw new Error("błędny identyfikator pociągu \"" + id + "\"");
    var dep = parseCompact(m[3]);
    if (!dep) throw new Error("błędna godzina odjazdu w identyfikatorze pociągu \"" + id + "\"");
    var ref = { category: m[1], number: +m[2], departure: dep, fromCode: +m[4], toCode: +m[5], arrival: null };
    if (m[6]) {
      ref.arrival = parseCompact(m[6]);
      if (!ref.arrival) throw new Error("błędna godzina przyjazdu w identyfikatorze pociągu \"" + id + "\"");
    }
    return ref;
  }

  function segment(r) {
    return { wyjazdData: fmtUpstream(r.departure), stacjaOdKod: r.fromCode, stacjaDoKod: r.toCode, pociagNr: r.number, kategoriaPociagu: r.category };
  }

  function trainFromUpstream(t) {
    var dep = parseUpstream(t.dataWyjazdu), arr = parseUpstream(t.dataPrzyjazdu);
    if (!dep) throw new Error("pociąg " + t.nrPociagu + ": błędny odjazd \"" + t.dataWyjazdu + "\"");
    if (!arr) throw new Error("pociąg " + t.nrPociagu + ": błędny przyjazd \"" + t.dataPrzyjazdu + "\"");
    var ref = { category: String(t.kategoriaPociagu || "").toUpperCase(), number: t.nrPociagu, departure: dep, fromCode: t.stacjaWyjazdu, toCode: t.stacjaPrzyjazdu, arrival: arr };
    var minutes = Math.floor((arr - dep) / MINUTE);
    return {
      id: refString(ref), category: ref.category, number: t.nrPociagu, name: t.nazwaPociagu || "",
      departure: fmtISO(dep), arrival: fmtISO(arr), departure_time: fmtClock(dep), arrival_time: fmtClock(arr),
      duration_minutes: minutes, duration: Math.floor(minutes / 60) + " h " + pad(minutes % 60) + " min",
      ref: ref,
    };
  }

  // ---- availability ----------------------------------------------------

  // available: the seat map shows a free seat for every passenger.
  // limited: fewer free seats than passengers, or seats could not be verified.
  // no_seat_guarantee: no free seat, but a ticket without one is still sold.
  // unavailable: the class or train cannot be bought at all.
  // unknown: upstream did not answer for this train.
  var RANK = { available: 3, limited: 2, no_seat_guarantee: 1 };
  function rank(status) { return RANK[status] || 0; }

  var PLACE_TYPES = { 1: "seat", 2: "couchette", 3: "sleeper" };

  // Status repeated as booleans for the logic-less templates.
  function setStatus(target, status) {
    target.status = status;
    target.is_available = status === "available";
    target.is_limited = status === "limited";
    target.is_no_seat_guarantee = status === "no_seat_guarantee";
    target.is_unavailable = status === "unavailable";
    target.is_unknown = status === "unknown";
  }

  var STATUS_LABELS = {
    available: "miejsca w ofercie", limited: "mało miejsc", no_seat_guarantee: "bez gwarancji miejsca",
    unavailable: "wyprzedane / brak w sprzedaży",
  };

  function finishAvailability(a) {
    a.has_seats = a.status === "available";
    a.status_label = STATUS_LABELS[a.status] || "nieznany";
    setStatus(a, a.status);
  }

  function offerFrom(p, seats) {
    var message = String(p.komunikatTekst || "").trim();
    var status = "available";
    if (p.komunikatKod > 0) status = "unavailable";
    else if (message.toLowerCase().indexOf("brak gwarancji") !== -1) status = "no_seat_guarantee";
    else if (message !== "") status = "limited";

    var label = "niedostępne";
    if (status === "available") label = "miejsca w ofercie";
    else if (status === "no_seat_guarantee") label = "bez gwarancji miejsca";
    else if (message !== "") label = message;

    var offer = {
      class: p.klasa, place_type: PLACE_TYPES[p.rodzajMiejscaKod] || "typ " + p.rodzajMiejscaKod,
      label: label, message: message,
      price_total_pln: pln(p.cena), price_per_person_pln: pln(Math.floor(p.cena / seats)),
      // Seat map figures; zero unless seats_verified.
      seats_verified: false, free_seats: 0, total_seats: 0, free_seat_list: "",
      special_free_seats: 0, special_notes: "", has_special: false,
    };
    setStatus(offer, status);
    return offer;
  }

  // classify turns an upstream price check into a first verdict. A price alone
  // proves little (upstream quotes full trains too); applySeats corrects it.
  function classify(trainID, seats, prices) {
    var a = {
      train_id: trainID, seats_requested: seats, has_seats: false, seats_verified: false, has_full_class: false,
      offers: [], detail: "", checked_at: "", cached: false,
    };
    var priceError = prices && prices.bledy && prices.bledy.length ? apiErrorMessage(prices.bledy[0]) : "";
    if (!prices) { a.status = "unknown"; a.detail = "serwer e-IC nie odpowiedział w sprawie tego pociągu"; }
    else if (priceError) { a.status = "unavailable"; a.detail = priceError; }
    else if (!prices.ceny || !prices.ceny.length) { a.status = "unavailable"; a.detail = "brak ofert"; }
    else {
      a.status = "unavailable";
      prices.ceny.forEach(function (p) {
        var o = offerFrom(p, seats);
        a.offers.push(o);
        if (rank(o.status) > rank(a.status)) a.status = o.status;
      });
    }
    finishAvailability(a);
    return a;
  }

  function countSeats(o, cs, wanted) {
    cs = cs || { total: 0, free: 0, freeList: "", specialFree: 0, specialNotes: [] };
    o.seats_verified = true;
    o.free_seats = cs.free; o.total_seats = cs.total; o.free_seat_list = cs.freeList;
    o.special_free_seats = cs.specialFree; o.special_notes = cs.specialNotes.join("; ");
    o.has_special = cs.specialFree > 0;
    var standing = o.status === "no_seat_guarantee";
    if (cs.free >= wanted) { o.status = "available"; o.label = "wolne: " + cs.free; }
    else if (cs.free > 0) { o.status = "limited"; o.label = "tylko wolne: " + cs.free; }
    else if (standing) { o.status = "no_seat_guarantee"; o.label = "komplet · tylko bez miejsca"; }
    else { o.status = "unavailable"; o.label = "komplet"; }
  }

  // applySeats replaces the price-based guess of every seat offer with the real
  // count from the seat map. With no scan the offers are marked unverified.
  // It returns a copy: `a` may come from the cache.
  function applySeats(a, scan, scanErr) {
    if (a.status === "unknown" || !a.offers.length) return a;
    a = Object.assign({}, a, { offers: a.offers.map(function (o) { return Object.assign({}, o); }) });
    a.seats_verified = !scanErr;
    if (scanErr) a.detail = "schemat miejsc niedostępny: " + scanErr.message;
    a.status = "unavailable";
    a.offers.forEach(function (o) {
      if (o.place_type === PLACE_TYPES[1] && o.status !== "unavailable") {
        if (scanErr) { o.status = "limited"; o.label = "jest cena, miejsca niezweryfikowane"; }
        else {
          countSeats(o, scan[o.class], a.seats_requested);
          a.has_full_class = a.has_full_class || o.free_seats < a.seats_requested;
        }
        setStatus(o, o.status);
      }
      if (rank(o.status) > rank(a.status)) a.status = o.status;
    });
    finishAvailability(a);
    return a;
  }

  // pendingSeats is a price check shown before its seat map is read: a quote
  // proves nothing about seats, so such offers must not read as available.
  // It returns a copy: `a` may come from the cache.
  function pendingSeats(a) {
    a = Object.assign({}, a, { seats_pending: false, offers: a.offers.map(function (o) { return Object.assign({}, o); }) });
    if (a.status === "unknown") return a;
    a.offers.forEach(function (o) {
      if (o.place_type !== PLACE_TYPES[1] || o.status === "unavailable") return;
      a.seats_pending = true;
      o.label = "miejsca niesprawdzone";
      setStatus(o, "unknown");
    });
    if (a.seats_pending) { a.status = "unknown"; finishAvailability(a); }
    return a;
  }

  // ---- seat maps -------------------------------------------------------

  var SEAT_FREE = "1"; // seat map status: 1 free, 3 taken or not for sale
  var SEAT_GROUP_RE = /<g id="[^"]*-grp-[^"]*"([^>]*)>([\s\S]*?)<\/g>/g;
  var SEAT_STATUS_RE = /class="place"[^>]*\bstatus="(\d+)"/;
  var SEAT_LABEL_RE = /aria-label="([^"]*)"/;
  var SEAT_NAME_RE = /^Miejsce (\S+) klasa (\d)$/;

  // Reads the seats out of a wagon SVG. Each seat is a group whose label reads
  // "Miejsce 12 klasa 2, okno, Wolne , niewybrane , <restriction>".
  function parseSeatMap(svg, wagon) {
    var seats = [];
    for (var g of svg.matchAll(SEAT_GROUP_RE)) {
      var status = SEAT_STATUS_RE.exec(g[2]), label = SEAT_LABEL_RE.exec(g[1]);
      if (!status || !label) continue;
      var parts = label[1].split(",");
      var name = SEAT_NAME_RE.exec(parts[0].trim());
      if (!name) continue;
      var seat = { wagon: wagon, number: name[1], class: +name[2], free: status[1] === SEAT_FREE, special: "" };
      // Whatever follows the selection marker is a restriction on who may sit there.
      parts.forEach(function (part, i) {
        if (part.trim() === "niewybrane" && i + 1 < parts.length) seat.special = parts.slice(i + 1).join(",").trim();
      });
      seats.push(seat);
    }
    return seats;
  }

  function seatOrder(number) { return /^\d+$/.test(number) ? +number : 1 << 30; }

  // Seat counts by class: {total, free, freeList "wagon 1: 12, 43", specialFree, specialNotes}.
  // Restricted seats are never counted in `free`.
  function summariseSeats(seats) {
    var scan = {}, freeByWagon = {};
    seats.forEach(function (seat) {
      var cs = scan[seat.class];
      if (!cs) {
        cs = scan[seat.class] = { total: 0, free: 0, freeList: "", specialFree: 0, specialNotes: [] };
        freeByWagon[seat.class] = {};
      }
      cs.total++;
      if (!seat.free) return;
      if (seat.special !== "") {
        cs.specialFree++;
        if (cs.specialNotes.indexOf(seat.special) === -1) cs.specialNotes.push(seat.special);
        return;
      }
      cs.free++;
      (freeByWagon[seat.class][seat.wagon] = freeByWagon[seat.class][seat.wagon] || []).push(seat.number);
    });
    Object.keys(freeByWagon).forEach(function (cls) {
      var wagons = freeByWagon[cls];
      scan[cls].freeList = Object.keys(wagons).map(Number).sort(function (a, b) { return a - b; }).map(function (w) {
        return "wagon " + w + ": " + wagons[w].sort(function (a, b) { return seatOrder(a) - seatOrder(b); }).join(", ");
      }).join(" · ");
    });
    return scan;
  }

  // What every leg of one train shares: its wagons and the classes each carries.
  function layoutOf(comp, seats) {
    var classes = {};
    seats.forEach(function (seat) {
      var list = classes[seat.wagon] = classes[seat.wagon] || [];
      if (list.indexOf(seat.class) === -1) list.push(seat.class);
    });
    return { comp: comp, classes: classes };
  }

  // spread picks at most n stops, evenly along the route.
  function spread(stops, n) {
    if (stops.length <= n) return stops;
    var out = [];
    for (var i = 0; i < n; i++) out.push(stops[Math.floor((2 * i + 1) * stops.length / (2 * n))]);
    return out;
  }

  var DIACRITICS = { "ą": "a", "ć": "c", "ę": "e", "ł": "l", "ń": "n", "ó": "o", "ś": "s", "ź": "z", "ż": "z" };
  function fold(s) { return s.trim().toLowerCase().replace(/[ąćęłńóśźż]/g, function (c) { return DIACRITICS[c]; }); }

  // ---- service ---------------------------------------------------------

  function createService(opts) {
    opts = opts || {};
    var up = opts.upstream || createClient(opts);
    var now = opts.now || function () { return new Date(); }; // real instant
    var clock = function () { return now().getTime(); };
    var seatsTTL = opts.seatsTTL == null ? 110000 : opts.seatsTTL;

    var timetables = ttlCache(5 * MINUTE, clock);
    var availabilityCache = ttlCache(opts.availabilityTTL == null ? 45000 : opts.availabilityTTL, clock); // price checks only
    var seatScans = ttlCache(seatsTTL, clock);
    var stationsCache = ttlCache(12 * 60 * MINUTE, clock);
    var routes = ttlCache(60 * MINUTE, clock); // stops and wagon layout do not change during a day
    var layouts = ttlCache(60 * MINUTE, clock);
    var splitsCache = ttlCache(seatsTTL, clock);
    // One lookup of each kind at a time, so the dashboard's concurrent requests
    // share the cache instead of all going upstream.
    var searchLock = serial(), priceLock = serial(), seatLock = serial(), splitLock = serial(), stationLock = serial();

    function checkSeats(seats) {
      if (!Number.isInteger(seats) || seats < 1 || seats > MAX_SEATS) throw new Error("liczba miejsc (seats) musi być od 1 do " + MAX_SEATS);
    }

    function allStations(signal) {
      return stationLock(async function () {
        var all = stationsCache.get("all");
        if (!all) { all = await up.stations(signal); stationsCache.set("all", all); }
        return all;
      });
    }

    async function stationBy(match, signal) {
      var found = (await allStations(signal)).find(match);
      if (!found) throw new Error("nie znaleziono stacji");
      return found;
    }

    async function stationEPA(code, signal) {
      var st = (await allStations(signal)).find(function (s) { return s.kod === code && s.kodEPA; });
      if (!st) throw new Error("stacja " + code + " nie ma kodu EPA");
      return st.kodEPA;
    }

    async function seatQuery(ref, signal) {
      return {
        category: ref.category, number: ref.number, departure: ref.departure, arrival: ref.arrival,
        fromEPA: await stationEPA(ref.fromCode, signal), toEPA: await stationEPA(ref.toCode, signal),
      };
    }

    // Reads wagon seat maps one by one. `wanted`, when set, is asked before each
    // wagon with the seats read so far, and skips the wagon on false.
    async function readWagons(q, comp, wanted, signal) {
      var seats = [];
      for (var wagon of comp.wagony || []) {
        // Wagons without a scheme (restaurant car) have no seats to sell.
        var scheme = (comp.wagonySchemat || {})[String(wagon)];
        if (scheme == null || (wanted && !wanted(wagon, seats))) continue;
        var svg;
        try { svg = await up.wagonSeatMap(q, wagon, scheme, signal); } catch (err) {
          if (isAbort(err, signal)) throw err;
          throw new Error("wagon " + wagon + ": " + err.message);
        }
        seats = seats.concat(parseSeatMap(svg, wagon));
      }
      return seats;
    }

    // Seat map of every wagon of a train: one upstream call per wagon, so
    // results are cached per train.
    function scanSeats(ref, signal) {
      return seatLock(async function () {
        var key = refString(ref), cached = seatScans.get(key);
        if (cached) return cached;
        if (!ref.arrival) throw new Error("identyfikator pociągu nie zawiera godziny przyjazdu");
        var q = await seatQuery(ref, signal);
        var comp = await up.composition(q, signal);
        if (!comp.wagony || !comp.wagony.length) throw new Error("brak schematu miejsc dla tego pociągu");
        var seats = await readWagons(q, comp, null, signal);
        if (!seats.length) throw new Error("schemat miejsc nie zawiera żadnych miejsc");
        var scan = summariseSeats(seats);
        seatScans.set(key, scan);
        layouts.set(key, layoutOf(comp, seats));
        return scan;
      });
    }

    function checkPrices(refs, seats, signal) {
      return priceLock(async function () {
        var out = new Array(refs.length), queries = [], pending = new Map(); // query ID -> index in refs
        refs.forEach(function (ref, i) {
          var cached = availabilityCache.get(refString(ref) + "|" + seats);
          if (cached) { out[i] = Object.assign({}, cached, { cached: true }); return; }
          var id = queries.length + 1;
          queries.push({ idPolaczenia: id, odcinki: [segment(ref)] });
          pending.set(id, i);
        });
        if (!queries.length) return out;

        var prices = await up.checkPrices(queries, seats, signal);
        var checkedAt = fmtISO(warsawWall(now()));
        pending.forEach(function (i, id) {
          var a = classify(refString(refs[i]), seats, prices.get(id));
          a.checked_at = checkedAt;
          if (prices.has(id)) availabilityCache.set(refString(refs[i]) + "|" + seats, a);
          out[i] = a;
        });
        return out;
      });
    }

    // Checks every given train for `seats` passengers: one batched price check,
    // then the seat map of each train. A seat map that cannot be read downgrades
    // that train to "not verified" instead of failing the request.
    async function availability(refs, seats, signal) {
      checkSeats(seats);
      var out = await checkPrices(refs, seats, signal);
      for (var i = 0; i < out.length; i++) {
        if (out[i].status === "unknown" || !out[i].offers.length) continue;
        var scan = null, scanErr = null;
        try { scan = await scanSeats(refs[i], signal); } catch (err) {
          if (isAbort(err, signal)) throw err;
          scanErr = err;
        }
        out[i] = applySeats(out[i], scan, scanErr);
      }
      return out;
    }

    // Direct trains departing inside the window, earliest first.
    function connections(w, signal) {
      return searchLock(async function () {
        var key = [w.from, w.to, w.start.getTime(), w.end.getTime()].join("|");
        var cached = timetables.get(key);
        if (cached) return cached;

        var seen = {}, trains = [], cursor = w.start;
        for (var page = 0; page < MAX_SEARCH_PAGES; page++) {
          var conns = await up.searchConnections(w.from, w.to, cursor, signal);
          var latest = cursor;
          conns.forEach(function (c) {
            if (!c.pociagi || c.pociagi.length !== 1) return; // direct trains only
            var t = trainFromUpstream(c.pociagi[0]);
            if (t.ref.departure > latest) latest = t.ref.departure;
            if (t.ref.departure < w.start || t.ref.departure > w.end || seen[t.id]) return;
            seen[t.id] = true;
            trains.push(t);
          });
          // Done when upstream ran past the window or stopped making progress.
          if (latest > w.end || !(latest > cursor)) break;
          cursor = new Date(latest.getTime() + MINUTE);
        }
        trains.sort(function (a, b) { return a.ref.departure - b.ref.departure; });
        timetables.set(key, trains);
        return trains;
      });
    }

    // Dashboard headline for one window. Counts are per class: a clean class 1
    // says nothing about class 2.
    async function summarise(w, seats, signal) {
      checkSeats(seats);
      var trains = await connections(w, signal);
      return summaryOf(trains, await availability(trains.map(function (t) { return t.ref; }), seats, signal), seats);
    }

    // Summary of `trains` from the availability of each; a train not checked
    // yet has no result and is left out of the counts.
    function summaryOf(trains, results, seats) {
      var nowWall = warsawWall(now());
      var checked = results.filter(Boolean).length;
      var sum = {
        seats_requested: seats, total: trains.length, checked: checked, all_checked: checked === trains.length,
        unknown: 0, classes: [], any_with_seats: false, verdict: "",
        checked_at: fmtISO(nowWall), checked_at_time: fmtClockSec(nowWall),
      };

      // Best offer of every class on every train; a class a train does not
      // offer at all stays unavailable.
      var best = [], classes = {}, freeSeats = {};
      results.forEach(function (a, i) {
        if (!a) return;
        if (a.status === "unknown") { sum.unknown++; return; }
        best[i] = {};
        a.offers.forEach(function (o) {
          classes[o.class] = true;
          freeSeats[o.class] = (freeSeats[o.class] || 0) + o.free_seats;
          if (!(o.class in best[i]) || rank(o.status) > rank(best[i][o.class])) best[i][o.class] = o.status;
        });
      });
      Object.keys(classes).map(Number).sort(function (a, b) { return b - a; }).forEach(function (cls) { // class 2 first
        var cs = { class: cls, with_seats: 0, limited: 0, no_seat_guarantee: 0, unavailable: 0, any_with_seats: false, trains_with_seats: [], free_seats: freeSeats[cls] || 0 };
        best.forEach(function (byClass, i) {
          if (!byClass) return;
          var status = byClass[cls];
          if (status === "available") {
            cs.with_seats++;
            var t = trains[i];
            cs.trains_with_seats.push([t.departure_time, t.category, t.number, t.name].join(" ").trim());
          } else if (status === "limited") cs.limited++;
          else if (status === "no_seat_guarantee") cs.no_seat_guarantee++;
          else cs.unavailable++;
        });
        cs.any_with_seats = cs.with_seats > 0;
        sum.any_with_seats = sum.any_with_seats || cs.any_with_seats;
        sum.classes.push(cs);
      });

      if (sum.total === 0) sum.verdict = "Brak bezpośrednich pociągów w tym przedziale.";
      else if (checked === 0) sum.verdict = "Nie sprawdzono jeszcze żadnego z " + sum.total + " pociągów.";
      else if (sum.any_with_seats) {
        sum.verdict = "Pociągi z min. " + seats + " wolnymi miejscami — " + sum.classes.map(function (cs) {
          return "klasa " + cs.class + ": " + cs.with_seats + " z " + checked;
        }).join(", ") + "." + (sum.all_checked ? "" : " Sprawdzono " + checked + " z " + sum.total + " pociągów.");
      } else if (!sum.all_checked) {
        sum.verdict = "Żaden ze sprawdzonych pociągów (" + checked + " z " + sum.total + ") nie ma teraz wolnych miejsc dla " + seats + " os.";
      } else sum.verdict = "Żaden pociąg w tym przedziale nie ma teraz wolnych miejsc dla " + seats + " os.";
      return sum;
    }

    // Stops of a train between the ref's two stations.
    async function route(ref, signal) {
      var key = refString(ref), cached = routes.get(key);
      if (cached) return cached;
      var from, to;
      try { from = await stationBy(function (s) { return s.kod === ref.fromCode && s.kodEVA; }, signal); } catch (err) {
        if (isAbort(err, signal)) throw err;
        throw new Error("stacja początkowa " + ref.fromCode + ": " + err.message);
      }
      try { to = await stationBy(function (s) { return s.kod === ref.toCode && s.kodEVA; }, signal); } catch (err) {
        if (isAbort(err, signal)) throw err;
        throw new Error("stacja docelowa " + ref.toCode + ": " + err.message);
      }
      var raw = await up.route(ref.number, ref.departure, from.kodEVA, to.kodEVA, signal);
      if (raw.length < 2) throw new Error("serwer e-IC nie zwrócił trasy tego pociągu");
      var stops = raw.map(function (r) {
        // Upstream also dates the origin's arrival and the destination's
        // departure; those belong to the train's wider run and are kept as sent.
        var arr, dep;
        try { arr = parseRouteTime(r.dataPrzyjazdu); dep = parseRouteTime(r.dataWyjazdu); } catch (err) {
          throw new Error("przystanek " + r.nazwaStacji + ": " + err.message);
        }
        return {
          name: r.nazwaStacji, eva: r.stacja,
          arrival: arr ? fmtISO(arr) : "", departure: dep ? fmtISO(dep) : "",
          arrival_time: arr ? fmtClock(arr) : "", departure_time: dep ? fmtClock(dep) : "",
          platform: r.peron || "", track: r.tor || "", can_board: !!r.dozwoloneWsiadanie, can_alight: !!r.dozwoloneWysiadanie,
          arrivalAt: arr, departureAt: dep,
        };
      });
      routes.set(key, stops);
      return stops;
    }

    function newLeg(from, to, departureTime, arrivalTime, ref) {
      // checked is false when the other leg already ruled the split out.
      return { from: from, to: to, departure_time: departureTime, arrival_time: arrivalTime, checked: false, has_seats: false, classes: [], detail: "", ref: ref };
    }

    // Counts free seats of the given classes on one leg. An unreadable seat map
    // marks the leg as having no seats; only a cancelled request fails.
    async function scanLeg(leg, layout, full, seats, signal) {
      leg.checked = true;
      var found;
      try {
        var q = await seatQuery(leg.ref, signal);
        // A wagon is worth a call only while one of its classes is still short.
        found = await readWagons(q, layout.comp, function (wagon, soFar) {
          var scan = summariseSeats(soFar);
          return (layout.classes[wagon] || []).some(function (cls) { return full[cls] && (!scan[cls] || scan[cls].free < seats); });
        }, signal);
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        leg.detail = "schemat miejsc niedostępny: " + err.message;
        return;
      }
      var scan = summariseSeats(found);
      Object.keys(full).map(Number).sort(function (a, b) { return b - a; }).forEach(function (cls) {
        var cs = scan[cls] || { free: 0, freeList: "" };
        // The count stops growing once there are enough seats: read free_seats as "at least".
        var lc = { class: cls, free_seats: cs.free, enough: cs.free >= seats, free_seat_list: cs.freeList, price_per_person_pln: "", grosze: 0 };
        leg.has_seats = leg.has_seats || lc.enough;
        leg.classes.push(lc);
      });
    }

    function setLegPrices(leg, prices, seats) {
      ((prices && prices.ceny) || []).forEach(function (p) {
        if (p.rodzajMiejscaKod !== 1 || p.komunikatKod > 0) return;
        leg.classes.forEach(function (lc) {
          if (lc.class !== p.klasa) return;
          lc.grosze = Math.floor(p.cena / seats);
          lc.price_per_person_pln = pln(lc.grosze);
        });
      });
    }

    // Lowest per-person price among classes with enough seats, or 0.
    function cheapest(leg) {
      return leg.classes.reduce(function (best, c) {
        return c.enough && c.grosze && (!best || c.grosze < best) ? c.grosze : best;
      }, 0);
    }

    // Prices both legs of every viable split. Prices are a nicety: a leg
    // upstream will not quote keeps its seats and simply shows no price.
    async function priceSplits(splits, seats, signal) {
      var queries = [], legs = new Map();
      splits.forEach(function (sp) {
        if (!sp.viable) return;
        [sp.first, sp.second].forEach(function (leg) {
          var id = queries.length + 1;
          queries.push({ idPolaczenia: id, odcinki: [segment(leg.ref)] });
          legs.set(id, leg);
        });
      });
      for (var batch of chunk(queries, MAX_PRICE_BATCH)) {
        var prices;
        try { prices = await up.checkPrices(batch, seats, signal); } catch (err) {
          if (isAbort(err, signal)) throw err;
          // Upstream sometimes answers a mixed batch with HTTP 500; its queries
          // usually pass one by one.
          prices = new Map();
          for (var q of batch) {
            try { prices.set(q.idPolaczenia, (await up.checkPrices([q], seats, signal)).get(q.idPolaczenia)); } catch (e) {
              if (isAbort(e, signal)) throw e;
            }
          }
        }
        prices.forEach(function (p, id) { setLegPrices(legs.get(id), p, seats); });
      }
      splits.forEach(function (sp) {
        var first = cheapest(sp.first), second = cheapest(sp.second);
        if (sp.viable && first && second) { sp.grosze = first + second; sp.total_per_person_pln = pln(sp.grosze); }
      });
    }

    // Looks for seats on two halves of one train whose whole route is full:
    // origin -> stop and stop -> destination, for up to MAX_SPLIT_STOPS stops.
    //
    // It is the costliest call of the service, so it spends upstream calls
    // carefully: only classes that are full on the whole route are looked at,
    // only wagons carrying them are read, a leg stops reading once it has enough
    // seats, the second leg is skipped when the first has none, and only viable
    // splits are priced. Run it for one train at a time, on demand.
    function splits(ref, seats, signal) {
      checkSeats(seats);
      return splitLock(async function () {
        var key = refString(ref) + "|" + seats, cached = splitsCache.get(key);
        if (cached) return Object.assign({}, cached, { cached: true });

        var nowWall = warsawWall(now());
        var rep = {
          train_id: refString(ref), train: ref.category + " " + ref.number + " · " + fmtClock(ref.departure),
          seats_requested: seats, classes: [], checked_stops: 0, route_stops: 0, has_viable: false, splits: [], detail: "",
          checked_at: fmtISO(nowWall), checked_at_time: fmtClockSec(nowWall), cached: false,
        };

        var scan = await scanSeats(ref, signal);
        var layout = layouts.get(refString(ref));
        if (!layout) throw new Error("nieznany układ wagonów tego pociągu");
        var full = {};
        Object.keys(scan).map(Number).sort(function (a, b) { return b - a; }).forEach(function (cls) { // class 2 first, as everywhere
          if (scan[cls].free < seats) { full[cls] = true; rep.classes.push(cls); }
        });
        if (!rep.classes.length) {
          rep.detail = "każda klasa ma jeszcze dość miejsc na całej trasie";
          splitsCache.set(key, rep);
          return rep;
        }

        var stops = await route(ref, signal);
        var candidates = stops.slice(1, -1).filter(function (s) { return s.can_alight && s.can_board && s.arrivalAt && s.departureAt; });
        rep.route_stops = candidates.length;
        var chosen = spread(candidates, MAX_SPLIT_STOPS);
        rep.checked_stops = chosen.length;
        if (!chosen.length) {
          rep.detail = "ten pociąg nie ma stacji pośredniej, na której można się przesiąść";
          splitsCache.set(key, rep);
          return rep;
        }

        var all = await allStations(signal);
        var origin = stops[0], destination = stops[stops.length - 1];
        for (var stop of chosen) {
          var via = all.find(function (s) { return s.kodEVA === stop.eva && s.kodEPA && s.kod; });
          var viaCode = via ? via.kod : 0;
          var sp = {
            via: stop.name, via_eva: stop.eva, arrival_time: stop.arrival_time, departure_time: stop.departure_time,
            viable: false, // both legs have a free seat for every passenger
            first: newLeg(origin.name, stop.name, fmtClock(ref.departure), stop.arrival_time,
              { category: ref.category, number: ref.number, departure: ref.departure, arrival: stop.arrivalAt, fromCode: ref.fromCode, toCode: viaCode }),
            second: newLeg(stop.name, destination.name, stop.departure_time, fmtClock(ref.arrival),
              { category: ref.category, number: ref.number, departure: stop.departureAt, arrival: ref.arrival, fromCode: viaCode, toCode: ref.toCode }),
            total_per_person_pln: "", grosze: 0,
          };
          rep.splits.push(sp);
          if (!via) { sp.first.detail = "stacji nie ma w słowniku e-IC"; continue; }
          await scanLeg(sp.first, layout, full, seats, signal);
          // Without a seat to the stop there is nothing to continue from.
          if (sp.first.has_seats) await scanLeg(sp.second, layout, full, seats, signal);
          sp.viable = sp.first.has_seats && sp.second.has_seats;
          rep.has_viable = rep.has_viable || sp.viable;
        }

        await priceSplits(rep.splits, seats, signal);
        rep.splits.sort(function (a, b) {
          if (a.viable !== b.viable) return a.viable ? -1 : 1;
          var less = function (x, y) { return x.grosze !== 0 && (y.grosze === 0 || x.grosze < y.grosze); };
          return less(a, b) ? -1 : less(b, a) ? 1 : 0;
        });
        splitsCache.set(key, rep);
        return rep;
      });
    }

    // Stations whose name contains q (case-insensitive, Polish diacritics
    // optional). Names starting with q come first.
    async function searchStations(q, signal) {
      var needle = fold(q), prefix = [], rest = [];
      (await allStations(signal)).forEach(function (st) {
        if (!st.kodEVA) return;
        var name = fold(st.nazwa);
        if (name.indexOf(needle) === 0) prefix.push({ name: st.nazwa, eva: st.kodEVA });
        else if (name.indexOf(needle) !== -1) rest.push({ name: st.nazwa, eva: st.kodEVA });
      });
      return prefix.concat(rest).slice(0, MAX_STATION_HITS);
    }

    // ---- public API: form parameters in, template-ready JSON out -------

    function intParam(params, name) {
      var raw = params[name];
      if (raw == null || raw === "") return DEFAULTS[name];
      if (!/^\d+$/.test(String(raw)) || +raw <= 0) throw new Error(name + " musi być dodatnią liczbą całkowitą");
      return +raw;
    }

    function clockParam(params, name) {
      var m = /^(\d{1,2}):(\d{2})$/.exec(params[name] || DEFAULTS[name]);
      if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(name + " musi mieć format GG:MM");
      return (+m[1] * 60 + +m[2]) * MINUTE;
    }

    // Today, or tomorrow once today's window end has passed.
    function defaultDate(endClock) {
      var nowWall = warsawWall(now());
      var day = wall(nowWall.getUTCFullYear(), nowWall.getUTCMonth() + 1, nowWall.getUTCDate());
      return nowWall.getTime() > day.getTime() + endClock ? new Date(day.getTime() + 24 * 60 * MINUTE) : day;
    }

    function parseWindow(params) {
      var from = intParam(params, "from"), to = intParam(params, "to");
      if (from === to) throw new Error("stacje from i to muszą być różne");
      var startClock = clockParam(params, "from_time"), endClock = clockParam(params, "to_time");
      if (endClock < startClock) throw new Error("to_time nie może być wcześniej niż from_time");
      var day;
      if (params.date) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.date);
        if (!m) throw new Error("date musi mieć format RRRR-MM-DD");
        day = wall(+m[1], +m[2], +m[3]);
      } else day = defaultDate(endClock);
      return { from: from, to: to, start: new Date(day.getTime() + startClock), end: new Date(day.getTime() + endClock) };
    }

    return {
      stations: async function (q, signal) {
        q = String(q || "").trim();
        if (Array.from(q).length < 2) return { query: q, stations: [], too_short: true };
        var hits = await searchStations(q, signal);
        return { query: q, stations: hits, none_found: hits.length === 0 };
      },
      connections: async function (params, signal) {
        var w = parseWindow(params), trains = await connections(w, signal);
        return {
          from_eva: w.from, to_eva: w.to, date: fmtDate(w.start), from_time: fmtClock(w.start), to_time: fmtClock(w.end),
          count: trains.length, has_trains: trains.length > 0, trains: trains,
        };
      },
      availability: async function (id, params, signal) {
        return (await availability([parseTrainRef(id)], intParam(params || {}, "seats"), signal))[0];
      },
      // Price checks alone, batched: what a row shows until its seat map is read.
      prices: async function (ids, params, signal) {
        var seats = intParam(params || {}, "seats");
        checkSeats(seats);
        return (await checkPrices(ids.map(parseTrainRef), seats, signal)).map(pendingSeats);
      },
      summaryOf: summaryOf,
      route: async function (id, signal) {
        var ref = parseTrainRef(id), stops = await route(ref, signal);
        return { train_id: refString(ref), count: stops.length, stops: stops };
      },
      splits: function (id, params, signal) { return splits(parseTrainRef(id), intParam(params || {}, "seats"), signal); },
      summary: function (params, signal) { return summarise(parseWindow(params), intParam(params, "seats"), signal); },
    };
  }

  return {
    createService: createService, createClient: createClient,
    // exported for tests
    parseSeatMap: parseSeatMap, summariseSeats: summariseSeats, parseTrainRef: parseTrainRef, refString: refString,
    parseRouteTime: parseRouteTime, spread: spread, warsawWall: warsawWall, wall: wall,
  };
});
