(function () {
  "use strict";

  var listView = document.getElementById("listView");
  var detailView = document.getElementById("detailView");
  var searchInput = document.getElementById("search");
  var clearBtn = document.getElementById("clearBtn");
  var backBtn = document.getElementById("backBtn");
  var headerTitle = document.getElementById("headerTitle");
  var searchWrap = document.getElementById("searchWrap");
  var tabAll = document.getElementById("tabAll");
  var tabJump = document.getElementById("tabJump");

  var HYMNS = [];
  var sortedNums = [];
  var mode = "all"; // 'all' | 'jump' | 'search'

  // Sheet music visibility is intentionally NOT persisted: every time the
  // user opens a hymn (including re-opening the same one after navigating
  // away), it should start collapsed again.
  var sheetMusicHiddenNow = true;
  function getSheetMusicHidden() {
    return sheetMusicHiddenNow;
  }
  function setSheetMusicHidden(val) {
    sheetMusicHiddenNow = val;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function attribLines(h) {
    var lines = [];
    if (h.title_note) lines.push(h.title_note);
    var a = [];
    if (h.author) a.push("Author: " + h.author);
    if (h.translator) a.push("Transl: " + h.translator);
    if (a.length) lines.push(a.join(" &nbsp;&nbsp; "));
    var b = [];
    if (h.composer) b.push("Composer: " + h.composer);
    if (h.tune) b.push("Tune: " + h.tune);
    if (b.length) lines.push(b.join(" &nbsp;&nbsp; "));
    return lines;
  }

  function renderList(items, opts) {
    opts = opts || {};
    detailView.classList.remove("show");
    listView.classList.remove("hide");
    backBtn.classList.remove("show");
    headerTitle.textContent = "Hymnal";

    if (!items.length) {
      listView.innerHTML = '<div class="empty">' + (opts.emptyMsg || "No hymns found.") + "</div>";
      return;
    }
    var html = "";
    for (var i = 0; i < items.length; i++) {
      var h = items[i];
      html +=
        '<div class="hymn-row" data-num="' + h.number + '">' +
        '<div class="hymn-num">' + h.number + "</div>" +
        '<div style="flex:1"><div class="hymn-title">' + escapeHtml(h.title || "(untitled)") + "</div>" +
        (h.tune ? '<div class="hymn-meta">' + escapeHtml(h.tune) + "</div>" : "") +
        "</div></div>";
    }
    listView.innerHTML = html;
    var rows = listView.querySelectorAll(".hymn-row");
    rows.forEach(function (row) {
      row.addEventListener("click", function () {
        showDetail(parseInt(row.getAttribute("data-num"), 10));
      });
    });
  }

  function pauseAllAudio() {
    var players = detailView.querySelectorAll("audio");
    players.forEach(function (a) {
      if (!a.paused) a.pause();
    });
  }

  function xmlBaseForAudio(src) {
    var name = src.split("/").pop();
    var dot = name.lastIndexOf(".");
    return dot > -1 ? name.substring(0, dot) : name;
  }

  function findMusicXmlPath(base) {
    var exts = ["xml", "musicxml", "mxl"];
    var i = 0;
    function tryNext() {
      if (i >= exts.length) return Promise.resolve(null);
      var path = "musicxml/" + base + "." + exts[i];
      i++;
      return fetch(encodeURI(path), { method: "HEAD" }).then(function (res) {
        return res.ok ? path : tryNext();
      }).catch(function () {
        return tryNext();
      });
    }
    return tryNext();
  }

  function showDetail(num) {
    var h = HYMNS.find(function (x) { return x.number === num; });
    if (!h) return;
    pauseAllAudio();
    sheetMusicHiddenNow = true; // always start collapsed on a fresh hymn view
    listView.classList.add("hide");
    detailView.classList.add("show");
    backBtn.classList.add("show");
    headerTitle.textContent = "Hymn #" + h.number;

    var idx = sortedNums.indexOf(h.number);
    var prevNum = idx > 0 ? sortedNums[idx - 1] : null;
    var nextNum = idx >= 0 && idx < sortedNums.length - 1 ? sortedNums[idx + 1] : null;
    var navHtml =
      '<div class="hymn-nav">' +
        '<button class="nav-btn" id="prevHymnBtn"' + (prevNum === null ? " disabled" : "") + '>' +
          "&#8592; " + (prevNum !== null ? "Hymn " + prevNum : "") +
        "</button>" +
        '<button class="nav-btn" id="nextHymnBtn"' + (nextNum === null ? " disabled" : "") + '>' +
          (nextNum !== null ? "Hymn " + nextNum : "") + " &#8594;" +
        "</button>" +
      "</div>";

    var attrib = attribLines(h);

    var audioHtml = "";
    if (h.audio && h.audio.length) {
      audioHtml =
        '<div class="audio-block">' +
        h.audio.map(function (src, i) {
          var label;
          if (src.indexOf("organ_") !== -1) {
            label = "Organ";
          } else if (src.indexOf("_2.mp3") !== -1) {
            label = "Multi Voice";
          } else if (i === 0) {
            label = "Single Voice";
          } else {
            label = "Track " + (i + 1);
          }
          return (
            '<div class="audio-row">' +
              '<div class="audio-label">' + label + "</div>" +
              '<audio controls preload="none" src="' + encodeURI(src) + '"></audio>' +
              (src.indexOf("organ_") !== -1 ? '<button class="edit-tune-btn" data-audio="' + encodeURI(src) + '" title="Edit tune (MusicXML)">&#9998; <span>Edit tune</span></button>' : "") +
            "</div>"
          );
        }).join("") +
        "</div>";
    }

    var versesHtml = h.verses.map(function (v, i) {
      return (
        '<div class="verse"><div class="verse-num">' + (i + 1) + "</div>" +
        '<div class="verse-text">' + escapeHtml(v) + "</div></div>"
      );
    }).join("");

    var sheetHtml = "";
    if (h.sheetMusic && h.sheetMusic.length) {
      var hidden = getSheetMusicHidden();
      sheetHtml =
        '<div class="sheet-toggle-row">' +
          '<button class="sheet-toggle-btn" id="sheetToggleBtn">' +
            '<span id="sheetToggleIcon">' + (hidden ? "&#9654;" : "&#9660;") + "</span>" +
            '<span id="sheetToggleLabel">' + (hidden ? "Show sheet music" : "Hide sheet music") + "</span>" +
          "</button>" +
        "</div>" +
        '<div class="sheet-music' + (hidden ? " hidden" : "") + '" id="sheetMusicBlock">' +
          h.sheetMusic.map(function (src) {
            return '<img src="' + encodeURI(src) + '" alt="Sheet music for ' + escapeHtml(h.title || "hymn " + h.number) + '" loading="lazy">';
          }).join("") +
        "</div>";
    }

    detailView.innerHTML =
      navHtml +
      '<div class="detail-num">Hymn ' + h.number + "</div>" +
      '<div class="detail-title">' + escapeHtml(h.title || "(untitled)") + "</div>" +
      '<div class="detail-attrib">' + attrib.map(function(l){return "<div>"+l+"</div>";}).join("") + "</div>" +
      audioHtml +
      sheetHtml +
      versesHtml +
      navHtml;

    var prevBtns = detailView.querySelectorAll("#prevHymnBtn");
    var nextBtns = detailView.querySelectorAll("#nextHymnBtn");
    prevBtns.forEach(function (btn) {
      if (prevNum !== null) btn.addEventListener("click", function () { showDetail(prevNum); });
    });
    nextBtns.forEach(function (btn) {
      if (nextNum !== null) btn.addEventListener("click", function () { showDetail(nextNum); });
    });

    var toggleBtn = document.getElementById("sheetToggleBtn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        var hiddenNow = !getSheetMusicHidden();
        setSheetMusicHidden(hiddenNow);
        var block = document.getElementById("sheetMusicBlock");
        block.classList.toggle("hidden", hiddenNow);
        document.getElementById("sheetToggleIcon").innerHTML = hiddenNow ? "&#9654;" : "&#9660;";
        document.getElementById("sheetToggleLabel").textContent = hiddenNow ? "Show sheet music" : "Hide sheet music";
      });
    }

    detailView.querySelectorAll(".edit-tune-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var audioSrc = decodeURI(btn.getAttribute("data-audio"));
        var base = xmlBaseForAudio(audioSrc);
        var original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = "&hellip;";
        findMusicXmlPath(base).then(function (path) {
          btn.disabled = false;
          btn.innerHTML = original;
          if (path) {
            var a = document.createElement("a");
            a.href = encodeURI(path);
            a.download = path.split("/").pop();
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } else {
            alert(
              "No editable MusicXML source yet for this track (" + base + ").\n\n" +
              "Scan or export one from Audiveris/MuseScore, save it as musicxml/" + base + ".xml, " +
              "and push it to the repo to enable one-click editing here."
            );
          }
        });
      });
    });

    document.querySelector("main").scrollTop = 0;
    history.pushState({ view: "detail", num: num }, "", "#hymn-" + num);
  }

  function showListMode(newMode) {
    pauseAllAudio();
    mode = newMode;
    tabAll.classList.toggle("active", newMode === "all");
    tabJump.classList.toggle("active", newMode === "jump");
    detailView.classList.remove("show");
    listView.classList.remove("hide");
    backBtn.classList.remove("show");
    headerTitle.textContent = "Hymnal";

    if (newMode === "jump") {
      searchWrap.style.display = "none";
      var html = '<div class="sectionlabel">Jump to hymn #</div><div class="jumpgrid">';
      HYMNS.forEach(function (h) {
        html += '<button data-num="' + h.number + '">' + h.number + "</button>";
      });
      html += "</div>";
      listView.innerHTML = html;
      listView.querySelectorAll(".jumpgrid button").forEach(function (btn) {
        btn.addEventListener("click", function () {
          showDetail(parseInt(btn.getAttribute("data-num"), 10));
        });
      });
    } else {
      searchWrap.style.display = "";
      searchInput.value = "";
      clearBtn.classList.remove("show");
      renderList(HYMNS);
    }
  }

  function doSearch(q) {
    q = q.trim();
    if (!q) {
      renderList(HYMNS);
      return;
    }
    var numMatch = /^\d+$/.test(q);
    var results;
    if (numMatch) {
      var qn = parseInt(q, 10);
      results = HYMNS.filter(function (h) { return String(h.number).indexOf(q) === 0; });
      results.sort(function (a, b) {
        if (a.number === qn) return -1;
        if (b.number === qn) return 1;
        return a.number - b.number;
      });
    } else {
      var ql = q.toLowerCase();
      results = HYMNS.filter(function (h) {
        return (
          (h.title && h.title.toLowerCase().indexOf(ql) !== -1) ||
          (h.author && h.author.toLowerCase().indexOf(ql) !== -1) ||
          (h.tune && h.tune.toLowerCase().indexOf(ql) !== -1) ||
          h.verses.some(function (v) { return v.toLowerCase().indexOf(ql) !== -1; })
        );
      });
    }
    renderList(results, { emptyMsg: 'No hymns match "' + escapeHtml(q) + '".' });
  }

  searchInput.addEventListener("input", function () {
    clearBtn.classList.toggle("show", !!searchInput.value);
    doSearch(searchInput.value);
  });
  clearBtn.addEventListener("click", function () {
    searchInput.value = "";
    clearBtn.classList.remove("show");
    doSearch("");
    searchInput.focus();
  });

  backBtn.addEventListener("click", function () {
    history.back();
  });
  window.addEventListener("popstate", function (e) {
    if (e.state && e.state.view === "detail") {
      showDetail(e.state.num);
    } else {
      showListMode(mode === "jump" ? "jump" : "all");
    }
  });

  tabAll.addEventListener("click", function () { showListMode("all"); history.pushState({view:"all"},"","#"); });
  tabJump.addEventListener("click", function () { showListMode("jump"); history.pushState({view:"jump"},"","#jump"); });

  function boot() {
    try {
      HYMNS = window.HYMNS_DATA || [];
      if (!HYMNS.length) throw new Error("No hymn data found");
      sortedNums = HYMNS.map(function (h) { return h.number; }).sort(function (a, b) { return a - b; });
      var hash = window.location.hash;
      if (hash && hash.indexOf("#hymn-") === 0) {
        showDetail(parseInt(hash.replace("#hymn-", ""), 10));
      } else if (hash === "#jump") {
        showListMode("jump");
      } else {
        showListMode("all");
      }
    } catch (err) {
      listView.innerHTML = '<div class="empty">Could not load hymn data.<br>' + escapeHtml(String(err)) + "</div>";
    }
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  boot();
})();
