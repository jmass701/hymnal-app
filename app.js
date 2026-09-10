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
  var sheetZoomOverlay = document.getElementById("sheetZoomOverlay");
  var sheetZoomStage = document.getElementById("sheetZoomStage");
  var sheetZoomImg = document.getElementById("sheetZoomImg");
  var sheetZoomClose = document.getElementById("sheetZoomClose");

  var HYMNS = [];
  var sortedNums = [];
  var mode = "all"; // 'all' | 'jump' | 'search'

  // The mobile (Android) build sets window.EDIT_TUNE_ENABLED = false before
  // this script loads, since it ships without voice audio or the bundled
  // Scan2Notes server -- there's nothing for Edit Tune to do there. Every
  // other build (desktop/Electron, plain browser/PWA) leaves the flag
  // unset, which defaults to enabled.
  var EDIT_TUNE_ENABLED = window.EDIT_TUNE_ENABLED !== false;

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

  // ---- Sheet music zoom viewer ----
  // A dependency-free pinch/drag/scroll zoom viewer for sheet-music images.
  // Opened by tapping any sheet-music <img>; closed via the close button,
  // tapping the dark backdrop, or Escape. Zoom/pan state always resets on
  // open, same as the tempo sliders and sheet-music-collapsed state elsewhere
  // in this file never persisting across hymns.
  var zoomScale = 1;
  var zoomX = 0;
  var zoomY = 0;
  var ZOOM_MIN = 1;
  var ZOOM_MAX = 5;

  function applyZoomTransform() {
    sheetZoomImg.style.transform =
      "translate(-50%, -50%) translate(" + zoomX + "px, " + zoomY + "px) scale(" + zoomScale + ")";
  }

  function clampZoomPan() {
    var rect = sheetZoomImg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var maxX = Math.max(0, (rect.width - window.innerWidth) / 2);
    var maxY = Math.max(0, (rect.height - window.innerHeight) / 2);
    zoomX = Math.min(maxX, Math.max(-maxX, zoomX));
    zoomY = Math.min(maxY, Math.max(-maxY, zoomY));
  }

  // Zooms so that the point at (cx, cy) -- screen coordinates relative to
  // the stage's center -- stays visually fixed under the cursor/finger.
  function zoomAt(cx, cy, newScale) {
    var oldScale = zoomScale;
    newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newScale));
    zoomX = cx - (newScale / oldScale) * (cx - zoomX);
    zoomY = cy - (newScale / oldScale) * (cy - zoomY);
    zoomScale = newScale;
    clampZoomPan();
    applyZoomTransform();
  }

  function toggleZoomAt(cx, cy) {
    if (zoomScale > 1.05) {
      zoomScale = 1;
      zoomX = 0;
      zoomY = 0;
      applyZoomTransform();
    } else {
      zoomAt(cx, cy, 2.5);
    }
  }

  function resetZoom() {
    zoomScale = 1;
    zoomX = 0;
    zoomY = 0;
    applyZoomTransform();
  }

  function openSheetZoom(src, alt) {
    sheetZoomImg.src = src;
    sheetZoomImg.alt = alt || "";
    resetZoom();
    sheetZoomOverlay.classList.remove("hidden");
  }

  function closeSheetZoom() {
    sheetZoomOverlay.classList.add("hidden");
    sheetZoomImg.src = "";
  }

  sheetZoomClose.addEventListener("click", closeSheetZoom);
  sheetZoomOverlay.addEventListener("click", function (e) {
    if (e.target === sheetZoomOverlay || e.target === sheetZoomStage) closeSheetZoom();
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !sheetZoomOverlay.classList.contains("hidden")) closeSheetZoom();
  });

  // Mouse wheel / trackpad zoom (desktop).
  sheetZoomStage.addEventListener("wheel", function (e) {
    e.preventDefault();
    var rect = sheetZoomStage.getBoundingClientRect();
    var cx = e.clientX - rect.left - rect.width / 2;
    var cy = e.clientY - rect.top - rect.height / 2;
    zoomAt(cx, cy, zoomScale * (1 - e.deltaY * 0.01));
  }, { passive: false });

  // Double-click to toggle between fit and 2.5x, centered on the click.
  sheetZoomStage.addEventListener("dblclick", function (e) {
    var rect = sheetZoomStage.getBoundingClientRect();
    toggleZoomAt(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
  });

  // Mouse drag to pan once zoomed in.
  var mouseDragging = false, mouseDragStartX = 0, mouseDragStartY = 0, mouseDragOrigX = 0, mouseDragOrigY = 0;
  sheetZoomStage.addEventListener("mousedown", function (e) {
    if (zoomScale <= 1) return;
    mouseDragging = true;
    mouseDragStartX = e.clientX;
    mouseDragStartY = e.clientY;
    mouseDragOrigX = zoomX;
    mouseDragOrigY = zoomY;
  });
  window.addEventListener("mousemove", function (e) {
    if (!mouseDragging) return;
    zoomX = mouseDragOrigX + (e.clientX - mouseDragStartX);
    zoomY = mouseDragOrigY + (e.clientY - mouseDragStartY);
    clampZoomPan();
    applyZoomTransform();
  });
  window.addEventListener("mouseup", function () { mouseDragging = false; });

  // Touch: pinch to zoom, one-finger drag to pan, double-tap to toggle zoom.
  var touchState = null;
  var lastTapTime = 0;
  var lastTapX = 0;
  var lastTapY = 0;

  function touchDist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }
  function touchMid(t0, t1, rect) {
    return {
      x: (t0.clientX + t1.clientX) / 2 - rect.left - rect.width / 2,
      y: (t0.clientY + t1.clientY) / 2 - rect.top - rect.height / 2
    };
  }

  sheetZoomStage.addEventListener("touchstart", function (e) {
    var rect = sheetZoomStage.getBoundingClientRect();
    if (e.touches.length === 2) {
      touchState = {
        mode: "pinch",
        startDist: touchDist(e.touches[0], e.touches[1]),
        startScale: zoomScale,
        mid: touchMid(e.touches[0], e.touches[1], rect),
        startX: zoomX,
        startY: zoomY
      };
      return;
    }
    if (e.touches.length === 1) {
      var t = e.touches[0];
      var now = Date.now();
      if (now - lastTapTime < 320 && Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 30) {
        toggleZoomAt(t.clientX - rect.left - rect.width / 2, t.clientY - rect.top - rect.height / 2);
        lastTapTime = 0;
        touchState = null;
        return;
      }
      lastTapTime = now;
      lastTapX = t.clientX;
      lastTapY = t.clientY;
      touchState = { mode: "drag", startX: t.clientX, startY: t.clientY, origX: zoomX, origY: zoomY };
    }
  }, { passive: true });

  sheetZoomStage.addEventListener("touchmove", function (e) {
    if (!touchState) return;
    e.preventDefault();
    if (touchState.mode === "pinch" && e.touches.length === 2) {
      var ratio = touchDist(e.touches[0], e.touches[1]) / touchState.startDist;
      zoomScale = touchState.startScale;
      zoomX = touchState.startX;
      zoomY = touchState.startY;
      zoomAt(touchState.mid.x, touchState.mid.y, touchState.startScale * ratio);
    } else if (touchState.mode === "drag" && e.touches.length === 1) {
      var t = e.touches[0];
      zoomX = touchState.origX + (t.clientX - touchState.startX);
      zoomY = touchState.origY + (t.clientY - touchState.startY);
      clampZoomPan();
      applyZoomTransform();
    }
  }, { passive: false });

  sheetZoomStage.addEventListener("touchend", function (e) {
    if (e.touches.length === 0) touchState = null;
  });

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

  function downloadFromUrl(url, filename) {
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function downloadText(text, filename) {
    var blob = new Blob([text], { type: "application/vnd.recordare.musicxml+xml" });
    var url = URL.createObjectURL(blob);
    downloadFromUrl(url, filename);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // Opens a MusicXML file in whatever program is registered to handle it
  // (e.g. MuseScore) instead of just downloading it. Only possible inside
  // the Electron desktop app, which exposes window.electronAPI via a
  // preload script -- a plain browser has no way to launch a desktop
  // program, so this falls back to a normal download there.
  function openMusicXmlExternally(text, filename) {
    if (window.electronAPI && typeof window.electronAPI.openMusicXml === "function") {
      return window.electronAPI.openMusicXml(text, filename).then(function (result) {
        if (!result || !result.ok) {
          // Couldn't launch an external editor (e.g. nothing registered
          // for this file type) -- fall back to a normal download so the
          // user still gets the file.
          downloadText(text, filename);
        }
      }).catch(function () {
        downloadText(text, filename);
      });
    }
    downloadText(text, filename);
    return Promise.resolve();
  }

  // For a MusicXML file that's already committed to the repo (served as a
  // normal static file), fetch its text and route it through the same
  // "open externally, else download" helper used for freshly-scanned XML.
  function openCommittedMusicXml(path) {
    var filename = path.split("/").pop();
    return fetch(encodeURI(path)).then(function (res) {
      if (!res.ok) throw new Error("Couldn't retrieve " + path);
      return res.text();
    }).then(function (text) {
      return openMusicXmlExternally(text, filename);
    }).catch(function () {
      // Fall back to a plain download if the fetch itself failed.
      downloadFromUrl(encodeURI(path), filename);
    });
  }

  // Local Scan2Notes server (Audiveris OMR) -- only reachable when the
  // user has it running on their own machine via start.bat. Not part of
  // the deployed static app; this is a best-effort convenience call.
  var SCAN2NOTES_BASE = "http://localhost:3000";

  function scanSheetMusicForXml(hymnNumber) {
    // Scans the ORIGINAL high-resolution sheet music PDF for this hymn
    // (looked up locally by the Scan2Notes server, by number) rather
    // than uploading the small in-app display image, which is too
    // low-resolution for Audiveris to read reliably.
    return fetch(SCAN2NOTES_BASE + "/api/scan-by-number/" + hymnNumber, { method: "POST" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            return { error: data.error || ("Scan2Notes server returned " + res.status), detail: data.detail };
          }
          return { musicxmlUrl: data.musicxmlUrl };
        });
      })
      .then(function (result) {
        if (result.error) return result;
        return fetch(SCAN2NOTES_BASE + result.musicxmlUrl).then(function (res2) {
          if (!res2.ok) throw new Error("Scan finished but the resulting MusicXML couldn't be retrieved");
          return res2.text();
        }).then(function (xmlText) {
          return { xmlText: xmlText };
        });
      })
      .catch(function (err) {
        return { error: err.message };
      });
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
          var isOrgan = src.indexOf("organ_") !== -1;
          if (isOrgan) {
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
              '<audio controls preload="none" id="audioTrack' + i + '" src="' + encodeURI(src) + '"></audio>' +
              (isOrgan ?
                '<div class="tempo-row">' +
                  '<label for="tempoSlider' + i + '">Tempo</label>' +
                  '<input type="range" id="tempoSlider' + i + '" data-audio-target="audioTrack' + i + '" min="70" max="130" step="1" value="100">' +
                  '<span class="tempo-value" id="tempoValue' + i + '">100%</span>' +
                "</div>"
                : "") +
              (EDIT_TUNE_ENABLED && isOrgan ? '<button class="edit-tune-btn" data-audio="' + encodeURI(src) + '" title="Edit tune (MusicXML)">&#9998; <span>Edit tune</span></button>' : "") +
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

    // Tempo sliders control playbackRate on their associated organ <audio>
    // element only. They are never persisted: showDetail() always rebuilds
    // this markup fresh with value="100", so re-opening a hymn (or
    // navigating to a different one) resets the tempo to normal.
    detailView.querySelectorAll(".tempo-row input[type=\"range\"]").forEach(function (slider) {
      var audioEl = document.getElementById(slider.getAttribute("data-audio-target"));
      var valueLabel = document.getElementById("tempoValue" + slider.id.replace("tempoSlider", ""));
      if (!audioEl) return;
      audioEl.playbackRate = 1;
      slider.addEventListener("input", function () {
        var pct = parseInt(slider.value, 10);
        audioEl.playbackRate = pct / 100;
        if (valueLabel) valueLabel.textContent = pct + "%";
      });
    });

    detailView.querySelectorAll(".sheet-music img").forEach(function (img) {
      img.addEventListener("click", function () {
        openSheetZoom(img.src, img.alt);
      });
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

    if (EDIT_TUNE_ENABLED) detailView.querySelectorAll(".edit-tune-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var audioSrc = decodeURI(btn.getAttribute("data-audio"));
        var base = xmlBaseForAudio(audioSrc);
        var original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = "&hellip;";

        findMusicXmlPath(base).then(function (path) {
          if (path) {
            return openCommittedMusicXml(path).then(function () {
              btn.disabled = false;
              btn.innerHTML = original;
            });
          }

          // No corrected MusicXML committed yet -- try auto-scanning this
          // hymn's ORIGINAL high-resolution sheet music (looked up by
          // hymn number on the local Scan2Notes server), not the small
          // in-app display image.
          btn.innerHTML = "Scanning\u2026";
          return scanSheetMusicForXml(h.number).then(function (result) {
            if (result && result.xmlText) {
              return openMusicXmlExternally(result.xmlText, base + ".musicxml").then(function () {
                btn.disabled = false;
                btn.innerHTML = original;
              });
            } else {
              btn.disabled = false;
              btn.innerHTML = original;
              alert(
                "Couldn't auto-scan this hymn's sheet music.\n\n" +
                (result && result.error ? result.error + "\n\n" : "") +
                "If you're using the Windows app, make sure Audiveris (and optionally Ghostscript) is installed with AUDIVERIS_HOME set, then try again. " +
                "If you're using this in a web browser instead of the Windows app, the auto-scan service only runs inside the desktop app \u2014 " +
                "scan/export manually in Audiveris/MuseScore instead and save the result as musicxml/" + base + ".xml, then push it to the repo."
              );
            }
          });
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
