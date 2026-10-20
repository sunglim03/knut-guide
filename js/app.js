(function () {
  "use strict";

  var NA = "확인 안됨";
  var NEED = "방문 전 확인 필요";
  var CAMPUS = [36.9699969, 127.8726008]; // 한국교통대 충주캠퍼스 대학본부 (학생식당 THE HUE 지도 링크 좌표)
  var data = (window.RESTAURANTS || []).map(function (p, i) { p.id = i; return p; });

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var known = function (v) { return v && v !== NA; };
  // 엑셀에 '확인 안됨'인 값은 지어내지 않고 '방문 전 확인 필요'로 보여 준다
  var show = function (v) { return known(v) ? esc(v) : '<span class="need">⚠ ' + NEED + "</span>"; };

  $("food-count").textContent = "학교 주변 맛집 " + data.length + "곳을 지도에서 보기";

  /* ---------- 화면 전환 ---------- */
  function route() {
    var food = location.hash === "#/food";
    $("view-home").hidden = food;
    $("view-food").hidden = !food;
    if (food) initMap();
  }
  window.addEventListener("hashchange", route);

  /* ---------- 지도 ---------- */
  var map, layer, markers = {}, selected = null, filter = "all", query = "";
  var me = null, meMarker = null, meCircle = null, watchId = null, firstFix = false;
  var food = null; // 메뉴 탭에서 고른 음식 종류
  var FOODS = [["한식", "🍚"], ["중식", "🥢"], ["일식", "🍣"], ["분식", "🍢"], ["기타", "☕"]];
  var SHEETS = ["list-sheet", "detail-sheet", "menu-sheet", "roulette-sheet", "add-sheet"];
  function only(id) { // 시트는 한 번에 하나만
    SHEETS.forEach(function (s) { if (s !== id) $(s).hidden = true; });
    if (id) $(id).hidden = false;
    var tab = id === "menu-sheet" ? "menu" : id === "roulette-sheet" ? "roulette" : id === "add-sheet" ? "add" : "map";
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t.dataset.tab === tab); });
    $("btn-add").classList.toggle("on", id === "add-sheet");
  }

  // 내 위치에서 가게까지 직선거리(m)
  function distance(p) {
    if (!me || !p.pos) return null;
    return map.distance(me, [p.lat, p.lng]);
  }
  function distText(m) {
    if (m == null) return "";
    var walk = Math.max(1, Math.round(m / 67)); // 걷는 속도 약 4km/h
    return (m < 1000 ? Math.round(m / 10) * 10 + "m" : (m / 1000).toFixed(1) + "km") + (m < 3000 ? " · 걸어서 약 " + walk + "분" : "");
  }

  function spread(list) {
    // 같은 건물에 있는 가게는 핀이 겹치므로 둘레에 조금씩 벌려 놓는다
    var groups = {};
    list.forEach(function (p) {
      if (p.lat == null) return;
      var k = p.lat.toFixed(5) + "," + p.lng.toFixed(5);
      (groups[k] = groups[k] || []).push(p);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      g.forEach(function (p, i) {
        var a = (2 * Math.PI * i) / g.length, r = g.length > 1 ? 0.00007 : 0;
        p.pos = [p.lat + r * Math.sin(a), p.lng + r * Math.cos(a) * 1.25];
      });
    });
  }

  function pinIcon(p, sel) {
    var cls = "pin" + (p.student ? " student" : p.daehakro === "O" ? "" : " out") + (sel ? " sel" : "");
    var size = sel ? 36 : 30;
    return L.divIcon({
      className: "", iconSize: [size, size], iconAnchor: [size / 2 - 1, size + 2],
      html: '<div class="' + cls + '"><span>' + (p.count > 1 ? p.count : "") + "</span></div>"
    });
  }

  function initMap() {
    if (map) { setTimeout(function () { map.invalidateSize(); }, 0); return; }
    map = L.map("map", { zoomControl: false, attributionControl: true }).setView(CAMPUS, 16);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    L.marker(CAMPUS, {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", iconSize: null, html: '<div class="pin-campus">🎓 교통대</div>' })
    }).addTo(map);
    spread(data);
    layer = L.layerGroup().addTo(map);
    // 대학로 쪽을 먼저 보여 주기
    var near = data.filter(function (p) { return p.daehakro === "O" && p.pos; }).map(function (p) { return p.pos; });
    if (near.length) map.fitBounds(L.latLngBounds(near), { paddingTopLeft: [20, 110], paddingBottomRight: [20, 40], maxZoom: 17 });
    map.on("click", function (e) { if (picking) setPick(e.latlng); else closeDetail(); });
    render();
    loadApproved();
    setTimeout(maybeHint, 900);
  }

  function visible() {
    var q = query.trim().toLowerCase();
    return data.filter(function (p) {
      if (filter === "daehakro" && p.daehakro !== "O") return false;
      if (filter === "outside" && p.daehakro !== "X") return false;
      if (filter === "popular" && p.count < 2) return false;
      if (food && p.food !== food) return false;
      if (!q) return true;
      return [p.name, p.menu, p.address].some(function (v) { return known(v) && v.toLowerCase().indexOf(q) >= 0; });
    }).sort(function (a, b) {
      if (me) { // 내 위치를 켜면 가까운 순 (지도에 없는 가게는 맨 뒤)
        var da = distance(a), db = distance(b);
        if (da == null || db == null) return (da == null) - (db == null) || b.count - a.count;
        return da - db;
      }
      return b.count - a.count || a.name.localeCompare(b.name, "ko");
    });
  }

  function render() {
    var list = visible();
    layer.clearLayers();
    markers = {};
    list.forEach(function (p) {
      if (!p.pos) return;
      var m = L.marker(p.pos, { icon: pinIcon(p, selected === p.id), riseOnHover: true, title: p.name })
        .bindTooltip(esc(p.name), { direction: "top", offset: [0, -30], className: "name-tip" })
        .on("click", function (e) { L.DomEvent.stopPropagation(e); openDetail(p.id, false); });
      m.addTo(layer);
      markers[p.id] = m;
    });
    var onMap = list.filter(function (p) { return p.pos; }).length;
    $("list-count").textContent = list.length;
    $("list-summary").textContent = list.length + "곳 · " + (me ? "가까운 순" : "추천 많은 순") +(onMap < list.length ? " · 지도에 없는 곳 " + (list.length - onMap) : "");
    $("list").innerHTML = list.length ? list.map(function (p) {
      return '<li><button data-id="' + p.id + '"><span class="rank">' + p.count + '</span><span><div class="t">' + esc(p.name) +
        '</div><div class="s">' + (known(p.menu) ? esc(p.menu) + " · " : "") + (p.student ? "학생 제보" : p.daehakro === "O" ? "대학로" : p.daehakro === "X" ? "대학로 밖" : "") +
        (me && p.pos ? ' · <span class="dist">' + distText(distance(p)).split(" · ")[0] + "</span>" : "") + "</div>" +
        (p.pos ? "" : '<div class="nomap">지도 위치 정보 없음 · ' + NEED + "</div>") + "</span></button></li>";
    }).join("") : '<li class="empty">조건에 맞는 가게가 없어요.</li>';
  }

  /* ---------- 가게 정보 ---------- */
  function linkLabel(url) {
    if (/kakao/.test(url)) return "카카오맵에서 보기";
    if (/\/search\//.test(url)) return "네이버 지도에서 검색";
    return "네이버 지도에서 보기";
  }

  function openDetail(id, fly, stay) {
    var p = data[id];
    if (selected != null && markers[selected]) markers[selected].setIcon(pinIcon(data[selected], false));
    selected = id;
    if (markers[id]) {
      markers[id].setIcon(pinIcon(p, true)).setZIndexOffset(1000);
      // 정보 창에 핀이 가리지 않게: 휴대폰은 핀을 화면 위쪽에, 넓은 화면은 오른쪽에 둔다
      var z = fly ? Math.max(map.getZoom(), 17) : map.getZoom();
      var wide = window.innerWidth >= 760;
      var c = map.unproject(map.project(p.pos, z).add(wide ? [-200, 0] : [0, window.innerHeight * 0.22]), z);
      if (!stay) map.flyTo(c, z, { duration: .6 });
    }
    var tel = known(p.phone) ? p.phone.replace(/[^\d]/g, "") : "";
    $("detail").innerHTML =
      '<div class="grab"></div>' +
      '<div class="d-head"><h2>' + esc(p.name) + '</h2><button class="icon-btn" data-close="detail-sheet" aria-label="닫기">✕</button></div>' +
      '<div class="badges">' +
        '<span class="badge">👍 ' + p.count + "명 추천</span>" +
        '<span class="badge gray">' + esc(p.food) + "</span>" +
        (p.student ? '<span class="badge green">학생 제보</span>' : "") +
        (p.daehakro === "O" ? '<span class="badge">대학로</span>' : p.daehakro === "X" ? '<span class="badge gray">대학로 밖</span>' : "") +
      "</div>" +
      '<dl class="rows">' +
        '<div class="row"><dt>대표 메뉴</dt><dd>' + show(p.menu) + "</dd></div>" +
        '<div class="row"><dt>위치</dt><dd>' + show(p.address) + "</dd></div>" +
        (me && p.pos ? '<div class="row"><dt>내 위치에서</dt><dd><span class="dist">' + distText(distance(p)) + "</span> (직선거리)</dd></div>" : "") +
        '<div class="row"><dt>전화번호</dt><dd>' + show(p.phone) + "</dd></div>" +
        '<div class="row"><dt>확인한 날</dt><dd>' + show(p.checked) + "</dd></div>" +
        (p.student ? '<div class="row"><dt>한 줄 추천</dt><dd>' + show(p.reason) + "</dd></div>" : "") +
      "</dl>" +
      '<div class="actions">' +
        (known(p.link) ? '<a class="btn primary" href="' + esc(p.link) + '" target="_blank" rel="noopener">🗺 ' + linkLabel(p.link) + "</a>"
                       : '<span class="btn off">🗺 지도 링크 없음</span>') +
        (tel ? '<a class="btn" href="tel:' + tel + '">📞 전화하기</a>' : '<span class="btn off">📞 번호 없음</span>') +
      "</div>" +
      '<p class="note">' +
        (p.coordSource && p.coordSource.indexOf("같은 건물") === 0 ? "📍 핀은 같은 건물에 있는 다른 가게 위치에 찍었어요. 정확한 위치는 지도 링크로 확인하세요.<br>" : "") +
        (!p.pos ? "📍 위치 정보가 없어 지도에 표시하지 못했어요.<br>" : "") +
        (p.student ? "학생이 제보하고 관리자가 확인한 곳이에요. " : "") +
        "학생들이 직접 모은 정보예요. 영업시간·가격은 바뀔 수 있으니 방문 전에 확인하세요." +
      "</p>";
    only("detail-sheet");
  }

  function closeDetail() {
    if (!$("detail-sheet").hidden) only(null);
    if (selected != null && markers[selected]) markers[selected].setIcon(pinIcon(data[selected], false)).setZIndexOffset(0);
    selected = null;
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-close]");
    if (c) { if (c.dataset.close === "detail-sheet") closeDetail(); else only(null); return; }
    var tab = e.target.closest(".tab[data-tab]");
    if (tab) {
      var t = tab.dataset.tab;
      closeDetail();
      if (t === "menu") { renderFoodGrid(); only("menu-sheet"); }
      else if (t === "roulette") { if (!wheelItems.length) newWheel(); only("roulette-sheet"); }
      else only(null);
      return;
    }
    var fb = e.target.closest(".food-btn[data-food]");
    if (fb) { setFood(fb.dataset.food === food ? null : fb.dataset.food, true); return; }
    if (e.target.closest("#chip-food")) { setFood(null, false); return; }
    var rf = e.target.closest("#r-foods .chip");
    if (rf) {
      rFood = rf.dataset.food || null;
      document.querySelectorAll("#r-foods .chip").forEach(function (b) { b.classList.toggle("on", b === rf); });
      newWheel(); return;
    }
    var go = e.target.closest("[data-goto]");
    if (go) { var id = +go.dataset.goto; if (data[id].pos) openDetail(id, true); else { only(null); openDetail(id, false); } return; }
    if (e.target.closest("#r-again")) { spin(); return; }
    var item = e.target.closest("#list button[data-id]");
    if (item) { openDetail(+item.dataset.id, true); return; }
    var chip = e.target.closest(".chip[data-filter]");
    if (chip) {
      filter = chip.dataset.filter;
      document.querySelectorAll(".chip[data-filter]").forEach(function (b) { b.classList.toggle("on", b === chip); });
      closeDetail(); render();
    }
  });
  $("q").addEventListener("input", function (e) { query = e.target.value; closeDetail(); render(); });
  $("q").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.target.blur(); closeDetail(); only("list-sheet"); }
  });
  $("btn-list").addEventListener("click", function () { closeDetail(); only($("list-sheet").hidden ? "list-sheet" : null); });

  /* ---------- 메뉴(음식 종류)로 찾기 ---------- */
  function renderFoodGrid() {
    $("food-grid").innerHTML = FOODS.map(function (f) {
      var n = data.filter(function (p) { return p.food === f[0]; }).length;
      return '<button class="food-btn' + (food === f[0] ? " on" : "") + '" data-food="' + f[0] + '"><span class="e">' + f[1] +
        '</span><span class="n">' + f[0] + '</span><span class="c">' + n + "곳</span></button>";
    }).join("");
  }
  function setFood(f, openList) {
    food = f;
    var chip = $("chip-food");
    chip.hidden = !f;
    if (f) chip.textContent = f + " ✕";
    closeDetail();
    render();
    var pts = visible().filter(function (p) { return p.pos; }).map(function (p) { return p.pos; });
    if (f && pts.length) map.flyToBounds(L.latLngBounds(pts), { paddingTopLeft: [20, 120], paddingBottomRight: [20, 60], maxZoom: 17, duration: .6 });
    if (openList && f) only("list-sheet"); else if (!$("menu-sheet").hidden) renderFoodGrid();
  }

  /* ---------- 메뉴 룰렛 ---------- */
  var rFood = null, wheelItems = [], wheelRot = 0, spinning = false;
  var rSize = 12, MAX_SLICES = 30, rPool = [], picked = []; // picked: 룰렛에 올라간 가게 id (순서 = 칸 순서)
  var COLORS = ["#1f6feb", "#e5484d", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899", "#0ea5e9", "#f97316"];
  $("r-foods").innerHTML = [["", "전체"]].concat(FOODS).map(function (f, i) {
    return '<button class="chip' + (i === 0 ? " on" : "") + '" data-food="' + f[0] + '">' + (i === 0 ? "전체" : f[0]) + "</button>";
  }).join("");
  $("r-near").addEventListener("change", newWheel);
  $("r-popular").addEventListener("change", newWheel);
  $("r-size").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-size]");
    if (!b || spinning) return;
    rSize = +b.dataset.size;
    $("r-size").querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
    newWheel();
  });
  $("r-shuffle").addEventListener("click", function () { if (!spinning) newWheel(); });
  $("r-cands").addEventListener("click", function (e) { // 후보를 눌러 룰렛에 넣거나 빼기
    var b = e.target.closest("button[data-id]");
    if (!b || spinning) return;
    var id = +b.dataset.id, at = picked.indexOf(id);
    if (at >= 0) picked.splice(at, 1);
    else if (picked.length < MAX_SLICES) picked.push(id);
    else { toast("룰렛 칸은 최대 " + MAX_SLICES + "개까지예요."); return; }
    syncWheel();
  });

  function pool() {
    return data.filter(function (p) {
      return (!rFood || p.food === rFood) && (!$("r-near").checked || p.daehakro === "O") && (!$("r-popular").checked || p.count >= 2);
    });
  }
  function newWheel() { // 후보 중에서 고른 칸 수만큼 무작위로 룰렛에 올린다
    rPool = pool();
    var ids = rPool.map(function (p) { return p.id; });
    for (var i = ids.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    picked = ids.slice(0, rSize || MAX_SLICES);
    syncWheel();
  }
  function syncWheel() {
    wheelItems = picked.map(function (id) { return data[id]; });
    drawWheel();
    $("r-spin").disabled = !wheelItems.length;
    $("r-cand-sum").textContent = "룰렛 " + picked.length + "곳 / 후보 " + rPool.length + "곳";
    $("r-cands").innerHTML = rPool.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "ko"); }).map(function (p) {
      return '<button class="cand' + (picked.indexOf(p.id) >= 0 ? "" : " off") + '" data-id="' + p.id + '">' + esc(p.name) + "</button>";
    }).join("");
    $("r-result").innerHTML = !rPool.length
      ? '<p class="empty">조건에 맞는 가게가 없어요. 조건을 끄거나 다른 종류를 골라 보세요.</p>'
      : !wheelItems.length ? '<p class="empty">룰렛에 올라간 가게가 없어요. 아래 후보를 눌러 넣어 주세요.</p>'
      : (rSize === 0 && rPool.length > MAX_SLICES ? '<p class="note">후보가 많아서 ' + MAX_SLICES + "곳만 올렸어요.</p>" : "");
  }
  function pt(deg, r) { var a = deg * Math.PI / 180; return [r * Math.sin(a), -r * Math.cos(a)]; }
  function drawWheel() {
    var n = wheelItems.length, s = 360 / Math.max(n, 1), svg = "";
    // 칸이 많을수록 글자를 작고 짧게
    var fs = n <= 8 ? 9 : n <= 12 ? 7.5 : n <= 16 ? 6.5 : n <= 22 ? 5.5 : 4.6, maxLen = n <= 8 ? 7 : n <= 16 ? 6 : 5;
    if (!n) { $("wheel").innerHTML = '<circle r="100" fill="var(--line)"/>'; return; }
    wheelItems.forEach(function (p, i) {
      var a0 = i * s, a1 = a0 + s, p0 = pt(a0, 100), p1 = pt(a1, 100), mid = a0 + s / 2;
      var label = p.name.length > maxLen ? p.name.slice(0, maxLen) + "…" : p.name;
      svg += n === 1 ? '<circle r="100" fill="' + COLORS[0] + '"/>'
        : '<path d="M0 0L' + p0[0].toFixed(2) + " " + p0[1].toFixed(2) + "A100 100 0 " + (s > 180 ? 1 : 0) + " 1 " +
          p1[0].toFixed(2) + " " + p1[1].toFixed(2) + 'Z" fill="' + COLORS[i % COLORS.length] + '" stroke="#fff" stroke-width="1.5"/>';
      // 왼쪽 절반 칸은 글자가 거꾸로 서지 않게 반대로 돌린다
      svg += mid <= 180
        ? '<text transform="rotate(' + (mid - 90) + ') translate(26 0)" dominant-baseline="middle" style="font-size:' + fs + 'px">' + esc(label) + "</text>"
        : '<text transform="rotate(' + (mid + 90) + ') translate(-26 0)" text-anchor="end" dominant-baseline="middle" style="font-size:' + fs + 'px">' + esc(label) + "</text>";
    });
    svg += '<circle r="16" fill="#fff" stroke="var(--line)"/><text text-anchor="middle" dominant-baseline="middle" style="fill:#16181d;font-size:8px">GO</text>';
    $("wheel").innerHTML = svg;
  }
  function spin() {
    if (spinning || !wheelItems.length) return;
    spinning = true;
    $("r-spin").disabled = true;
    $("r-result").innerHTML = "";
    var n = wheelItems.length, s = 360 / n, win = Math.floor(Math.random() * n);
    var mid = win * s + s / 2 + (Math.random() - .5) * s * .6;
    // 바늘(맨 위)에 당첨 칸이 오도록: 최소 5바퀴 돌고 멈춤
    wheelRot += 360 * 5 + ((((-mid - wheelRot) % 360) + 360) % 360);
    $("wheel").style.transform = "rotate(" + wheelRot + "deg)";
    setTimeout(function () {
      spinning = false;
      $("r-spin").disabled = false;
      var p = wheelItems[win];
      $("r-result").innerHTML = '<div class="result"><div class="muted">오늘은 여기 어때요?</div><div class="big">' + esc(p.name) + "</div>" +
        '<div class="muted">' + esc(p.food) + " · 대표 메뉴 " + show(p.menu) + " · 👍 " + p.count + "명 추천</div>" +
        '<div class="actions"><button class="btn primary" data-goto="' + p.id + '">🗺 지도에서 보기</button>' +
        '<button class="btn" id="r-again">🔄 다시 돌리기</button></div></div>';
    }, 4300);
  }
  $("r-spin").addEventListener("click", spin);
  $("wheel").addEventListener("click", spin);
  $("btn-campus").addEventListener("click", function () { map.flyTo(CAMPUS, 16, { duration: .6 }); });
  $("btn-all").addEventListener("click", function () {
    var pts = visible().filter(function (p) { return p.pos; }).map(function (p) { return p.pos; });
    if (pts.length) map.flyToBounds(L.latLngBounds(pts), { padding: [60, 60], duration: .6 });
  });

  /* ---------- 학생 맛집 제보 ---------- */
  var CFG = window.APP_CONFIG || {};
  var picking = false, pickPos = null, pickMarker = null;
  var configured = function () { return !!(CFG.formAction && CFG.entries && CFG.entries.name); };

  $("btn-add").addEventListener("click", function () { hideHint(); if ($("add-sheet").hidden) openAdd(); else only(null); });
  // 처음 온 학생에게 '맛집 제보' 버튼을 한 번 알려 주는 말풍선
  var hintTimer;
  function hideHint() { $("add-hint").hidden = true; clearTimeout(hintTimer); }
  function maybeHint() {
    var seen = false;
    try { seen = localStorage.getItem("seenAddHint") === "1"; localStorage.setItem("seenAddHint", "1"); } catch (err) { /* 저장소 없음: 매번 보여 줌 */ }
    if (seen) return;
    $("add-hint").hidden = false;
    hintTimer = setTimeout(hideHint, 6000);
  }
  $("add-hint").addEventListener("click", hideHint);
  function openAdd() {
    closeDetail();
    only("add-sheet");
    if (!configured()) {
      $("add-submit").disabled = true;
      $("add-msg").textContent = "아직 제보 받을 구글폼이 연결되지 않았어요. (관리자: js/config.js 설정 필요)";
    }
  }
  function setPick(latlng) {
    pickPos = latlng;
    if (!pickMarker) {
      pickMarker = L.marker(latlng, { draggable: true, zIndexOffset: 3000,
        icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="pin-temp"></div>' }) }).addTo(map);
      pickMarker.on("dragend", function () { pickPos = pickMarker.getLatLng(); showPick(); });
    } else pickMarker.setLatLng(latlng);
    stopPicking();
    showPick();
    only("add-sheet");
  }
  function showPick() {
    $("add-pos").innerHTML = '<span class="ok">✔ 위치를 골랐어요</span> (핀을 끌어서 옮길 수 있어요)';
  }
  function stopPicking() {
    picking = false;
    $("pick-banner").hidden = true;
    $("view-food").classList.remove("picking");
  }
  $("add-pick").addEventListener("click", function () {
    picking = true;
    only(null);
    $("pick-banner").hidden = false;
    $("view-food").classList.add("picking");
    if (me) map.flyTo(me, 17, { duration: .5 });
  });
  $("pick-cancel").addEventListener("click", function () { stopPicking(); only("add-sheet"); });

  $("add-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target, msg = $("add-msg");
    if (!configured()) return;
    var v = function (n) { return (f.elements[n].value || "").trim(); };
    if (!v("name")) { msg.textContent = "가게 이름을 적어 주세요."; f.elements.name.focus(); return; }
    if (!pickPos) { msg.textContent = "지도에서 가게 위치를 찍어 주세요."; return; }
    var last = 0;
    try { last = +localStorage.getItem("lastTip") || 0; } catch (err) { /* 저장소를 못 쓰는 브라우저 */ }
    if (Date.now() - last < 60000) { msg.textContent = "제보는 1분에 한 번만 보낼 수 있어요. 잠시 후 다시 보내 주세요."; return; }

    var body = new URLSearchParams();
    ["name", "address", "link", "menu", "food", "reason"].forEach(function (k) { if (CFG.entries[k]) body.append(CFG.entries[k], v(k)); });
    body.append(CFG.entries.lat, pickPos.lat.toFixed(6));
    body.append(CFG.entries.lng, pickPos.lng.toFixed(6));
    $("add-submit").disabled = true;
    msg.textContent = "보내는 중…";
    // 구글폼은 다른 사이트에서 보낸 요청에 응답 내용을 보여 주지 않으므로(no-cors) 전송 성공 여부만 확인한다
    fetch(CFG.formAction, { method: "POST", mode: "no-cors", body: body }).then(function () {
      try { localStorage.setItem("lastTip", String(Date.now())); } catch (err) { /* 무시 */ }
      f.reset();
      pickPos = null;
      if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
      $("add-pos").textContent = "아직 위치를 고르지 않았어요";
      msg.textContent = "고마워요! 제보가 접수됐어요. 관리자가 확인하면 지도에 ‘학생 제보’로 올라가요.";
    }).catch(function () {
      msg.textContent = "보내지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";
    }).then(function () { $("add-submit").disabled = false; });
  });

  // 승인된 제보 불러오기: 구글 시트 '승인됨' 탭을 웹에 게시한 CSV
  function parseCsv(text) {
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function loadApproved() {
    if (!CFG.approvedCsv || !/^https:\/\//.test(CFG.approvedCsv)) return;
    fetch(CFG.approvedCsv + (CFG.approvedCsv.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now())
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (text) {
        var rows = parseCsv(text), head = rows.shift() || [];
        var col = function (k) { return head.indexOf(k); };
        var added = 0;
        rows.forEach(function (r) {
          var g = function (k) { var i = col(k); return i >= 0 && r[i] ? r[i].trim() : ""; };
          var lat = parseFloat(g("lat")), lng = parseFloat(g("lng"));
          if (!g("name") || !isFinite(lat) || !isFinite(lng)) return;
          var addr = g("address"), fd = g("food");
          var d = g("time").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
          if (!d && /^\d+(\.\d+)?$/.test(g("time"))) { // 시트 날짜가 숫자(1899-12-30부터 센 날 수)로 올 때
            var t = new Date(Date.UTC(1899, 11, 30) + parseFloat(g("time")) * 86400000);
            d = [0, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
          }
          data.push({
            id: data.length, student: true, name: g("name"), address: addr || NA,
            link: /^https?:\/\//.test(g("link")) ? g("link") : NA, menu: g("menu") || NA, reason: g("reason") || NA,
            food: FOODS.some(function (x) { return x[0] === fd; }) ? fd : "기타", foodBasis: "학생 제보",
            checked: d ? d[1] + "-" + ("0" + d[2]).slice(-2) + "-" + ("0" + d[3]).slice(-2) : NA,
            daehakro: !addr ? NA : /대소원면\s*대학로\s*\d/.test(addr) ? "O" : "X",
            phone: NA, count: 1, lat: lat, lng: lng
          });
          added++;
        });
        if (!added) return;
        spread(data);
        render();
        $("food-count").textContent = "학교 주변 맛집 " + data.length + "곳을 지도에서 보기";
        toast("학생 제보 맛집 " + added + "곳을 불러왔어요.");
      }).catch(function () { /* 제보를 못 불러와도 기본 맛집은 그대로 보여 준다 */ });
  }

  /* ---------- 내 위치 (GPS) ---------- */
  var toastTimer;
  function toast(msg) {
    $("toast").textContent = msg; $("toast").hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $("toast").hidden = true; }, 4000);
  }
  function stopLocate() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null; me = null;
    if (meMarker) { map.removeLayer(meMarker); map.removeLayer(meCircle); meMarker = meCircle = null; }
    $("btn-locate").classList.remove("on");
    render();
  }
  $("btn-locate").addEventListener("click", function () {
    if (watchId != null) { // 켜져 있으면 내 위치로 다시 이동, 이미 보고 있으면 끄기
      if (me && !map.getBounds().contains(me)) { map.flyTo(me, 17, { duration: .6 }); return; }
      stopLocate(); toast("내 위치 표시를 껐어요."); return;
    }
    if (!navigator.geolocation) { toast("이 브라우저는 위치 기능을 지원하지 않아요."); return; }
    if (!window.isSecureContext) { toast("위치 기능은 https 주소에서만 쓸 수 있어요."); return; }
    $("btn-locate").classList.add("on");
    toast("내 위치를 찾는 중이에요…");
    firstFix = true;
    watchId = navigator.geolocation.watchPosition(function (pos) {
      me = L.latLng(pos.coords.latitude, pos.coords.longitude);
      var acc = pos.coords.accuracy;
      if (!meMarker) {
        meCircle = L.circle(me, { radius: acc, color: "#1a73e8", weight: 1, fillOpacity: .12, interactive: false }).addTo(map);
        meMarker = L.marker(me, { interactive: false, keyboard: false, zIndexOffset: 2000,
          icon: L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: '<div class="me"></div>' }) }).addTo(map);
      } else { meMarker.setLatLng(me); meCircle.setLatLng(me).setRadius(acc); }
      if (firstFix) {
        firstFix = false;
        map.flyTo(me, 17, { duration: .6 });
        toast(acc > 300 ? "위치 정확도가 낮아요(약 " + Math.round(acc) + "m). 실제 위치와 다를 수 있어요." : "목록이 가까운 순으로 바뀌었어요.");
      }
      render();
      if (selected != null && !$("detail-sheet").hidden) openDetail(selected, false, true);
    }, function (err) {
      stopLocate();
      toast(err.code === 1 ? "위치 권한이 꺼져 있어요. 브라우저 설정에서 위치를 허용해 주세요."
                           : "위치를 찾지 못했어요. 잠시 후 다시 눌러 주세요.");
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
  });
  window.addEventListener("hashchange", function () { if (location.hash !== "#/food" && watchId != null) stopLocate(); });

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeDetail(); $("list-sheet").hidden = true; } });

  route();
})();
