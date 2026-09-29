// content.js — ISOLATED world.
// - Collects tweets from GraphQL (dedup by tweet_id), autoscrolls, exports JSON.
// - Builds a video index (tweet_id -> best mp4) and injects a download button
//   onto each video card in the timeline.
// - Panel is HIDDEN by default; toggled by the toolbar icon (via background.js)
//   or closed via its own ✕ button.

(function () {
  "use strict";

  const TAG = "__X_TWEET_SAVER__";

  // ---------- state ----------
  const store = new Map();          // tweet_id -> normalized tweet
  const videoIndex = new Map();     // tweet_id -> { url, poster, screen_name }
  let running = false;
  let stopRequested = false;
  let panelVisible = false;

  // ---------- GraphQL parsing ----------
  function walk(node, visit) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visit);
      return;
    }
    visit(node);
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        walk(node[key], visit);
      }
    }
  }

  function pickTweetResult(node) {
    if (node.__typename === "TweetWithVisibilityResults" && node.tweet) {
      return node.tweet;
    }
    if (
      (node.__typename === "Tweet" || node.rest_id) &&
      node.legacy &&
      typeof node.legacy === "object"
    ) {
      return node;
    }
    return null;
  }

  function extractUser(tweetResult) {
    try {
      const u =
        tweetResult.core &&
        tweetResult.core.user_results &&
        tweetResult.core.user_results.result;
      if (!u) return {};
      const legacy = u.legacy || {};
      return {
        user_id: u.rest_id || null,
        username: legacy.screen_name || (u.core && u.core.screen_name) || null,
        display_name: legacy.name || (u.core && u.core.name) || null
      };
    } catch (e) {
      return {};
    }
  }

  function bestMp4(mediaEntity) {
    try {
      if (!mediaEntity.video_info || !mediaEntity.video_info.variants) return null;
      const mp4s = mediaEntity.video_info.variants
        .filter((v) => v.content_type === "video/mp4" && v.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return mp4s.length ? mp4s[0].url : null;
    } catch (e) {
      return null;
    }
  }

  function normalizeTweet(tweetResult) {
    const legacy = tweetResult.legacy || {};
    const id = tweetResult.rest_id || legacy.id_str;
    if (!id) return null;

    const user = extractUser(tweetResult);

    let views = null;
    if (tweetResult.views && tweetResult.views.count != null) {
      views = Number(tweetResult.views.count);
    }

    let fullText = legacy.full_text || legacy.text || "";
    try {
      const note =
        tweetResult.note_tweet &&
        tweetResult.note_tweet.note_tweet_results &&
        tweetResult.note_tweet.note_tweet_results.result;
      if (note && note.text) fullText = note.text;
    } catch (e) {}

    let media = [];
    try {
      const ents =
        (legacy.extended_entities && legacy.extended_entities.media) ||
        (legacy.entities && legacy.entities.media) ||
        [];
      media = ents.map((m) => {
        const mp4 = bestMp4(m);
        // Index videos for the per-video download button.
        if (mp4 && (m.type === "video" || m.type === "animated_gif")) {
          videoIndex.set(id, {
            url: mp4,
            poster: m.media_url_https || m.media_url || null,
            screen_name: user.username || null,
            type: m.type
          });
        }
        return {
          type: m.type,
          url: m.media_url_https || m.media_url,
          video: mp4
        };
      });
    } catch (e) {}

    let quotedId = legacy.quoted_status_id_str || null;

    return {
      tweet_id: id,
      user_id: user.user_id || null,
      username: user.username || null,
      display_name: user.display_name || null,
      created_at: legacy.created_at || null,
      text: fullText,
      lang: legacy.lang || null,
      is_reply: !!legacy.in_reply_to_status_id_str,
      in_reply_to_status_id: legacy.in_reply_to_status_id_str || null,
      in_reply_to_screen_name: legacy.in_reply_to_screen_name || null,
      is_retweet: !!legacy.retweeted_status_result,
      is_quote: !!legacy.is_quote_status,
      quoted_status_id: quotedId,
      conversation_id: legacy.conversation_id_str || null,
      favorite_count: legacy.favorite_count ?? null,
      retweet_count: legacy.retweet_count ?? null,
      reply_count: legacy.reply_count ?? null,
      quote_count: legacy.quote_count ?? null,
      bookmark_count: legacy.bookmark_count ?? null,
      view_count: views,
      media: media,
      hashtags:
        (legacy.entities &&
          legacy.entities.hashtags &&
          legacy.entities.hashtags.map((h) => h.text)) ||
        [],
      urls:
        (legacy.entities &&
          legacy.entities.urls &&
          legacy.entities.urls.map((u) => u.expanded_url)) ||
        []
    };
  }

  function ingestPayload(jsonText) {
    let data;
    try {
      data = JSON.parse(jsonText);
    } catch (e) {
      return 0;
    }
    let added = 0;
    walk(data, (node) => {
      const tr = pickTweetResult(node);
      if (!tr) return;
      const t = normalizeTweet(tr);
      if (!t || !t.tweet_id) return;
      if (!store.has(t.tweet_id)) added++;
      store.set(t.tweet_id, t);
    });
    if (added > 0) updateCount();
    // New video data may have arrived — decorate any visible cards.
    scheduleDecorate();
    return added;
  }

  // ---------- messaging ----------
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== TAG) return;
    if (d.kind === "graphql" && d.body) ingestPayload(d.body);
  });

  // Toggle from the toolbar icon (routed via background.js).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "xts-toggle-panel") togglePanel();
  });

  // ---------- autoscroll ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pageHeight = () =>
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

  async function autoScroll(opts) {
    running = true;
    stopRequested = false;
    setStatus("Сбор...");

    let idle = 0;
    let lastCount = store.size;
    let lastHeight = 0;
    let sameHeight = 0;

    while (!stopRequested) {
      window.scrollBy(0, window.innerHeight * 0.9);
      await sleep(opts.delay);

      const h = pageHeight();
      if (h === lastHeight) sameHeight++;
      else { sameHeight = 0; lastHeight = h; }

      if (store.size === lastCount) idle++;
      else { idle = 0; lastCount = store.size; }

      setStatus(`Собрано: ${store.size} · холостых: ${idle}/${opts.maxIdle}`);

      if (idle >= opts.maxIdle && sameHeight >= 3) {
        window.scrollTo(0, pageHeight());
        await sleep(opts.delay * 1.5);
        if (store.size === lastCount) break;
        idle = 0;
        lastCount = store.size;
      }
    }

    running = false;
    setStatus(
      stopRequested
        ? `Остановлено. Собрано: ${store.size}`
        : `Готово. Собрано: ${store.size}`
    );
    updateCount();
  }

  // ---------- export ----------
  function currentProfileHandle() {
    const seg = location.pathname.split("/").filter(Boolean);
    const reserved = new Set([
      "home","explore","notifications","messages","search",
      "settings","i","compose","hashtag"
    ]);
    if (seg.length && !reserved.has(seg[0])) return seg[0];
    return "profile";
  }

  function download(filename, blobOrText, mime) {
    const blob =
      blobOrText instanceof Blob
        ? blobOrText
        : new Blob([blobOrText], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  function exportJSON() {
    const tweets = Array.from(store.values());
    tweets.sort((a, b) => {
      const da = Date.parse(a.created_at || "");
      const db = Date.parse(b.created_at || "");
      if (isNaN(da) || isNaN(db)) return 0;
      return db - da;
    });
    const handle = currentProfileHandle();
    const payload = {
      meta: {
        source: "x-tweet-saver",
        version: "1.2.0",
        profile: handle,
        url: location.href,
        exported_at: new Date().toISOString(),
        tweet_count: tweets.length
      },
      tweets
    };
    const stamp = new Date().toISOString().slice(0, 10);
    download(
      `${handle}_tweets_${stamp}.json`,
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8"
    );
  }

  // ---------- thread capture ----------
  // On a /status/<id> page X loads the whole conversation via the TweetDetail
  // GraphQL op (already intercepted). Every tweet in a conversation shares the
  // same conversation_id, so we can slice the store down to just this thread and
  // rebuild the reply tree from in_reply_to_status_id.

  function focusedTweetId() {
    const m = location.pathname.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function currentConversationId() {
    const fid = focusedTweetId();
    if (!fid) return null;
    const t = store.get(fid);
    return (t && t.conversation_id) || fid;
  }

  function threadTweets() {
    const convId = currentConversationId();
    if (!convId) return [];
    const out = [];
    store.forEach((t) => {
      if (t.conversation_id === convId || t.tweet_id === convId) out.push(t);
    });
    return out;
  }

  // Rebuild the nested reply tree. Roots are tweets whose parent isn't part of
  // the captured set (the conversation root and any loaded ancestors).
  function buildThreadTree(tweets, focusedId) {
    const byId = new Map();
    tweets.forEach((t) => byId.set(t.tweet_id, Object.assign({}, t, { replies: [] })));

    const roots = [];
    byId.forEach((node) => {
      const parentId = node.in_reply_to_status_id;
      if (parentId && byId.has(parentId)) {
        byId.get(parentId).replies.push(node);
      } else {
        roots.push(node);
      }
    });

    const ts = (t) => Date.parse((t && t.created_at) || "") || 0;
    const sortRec = (n) => {
      n.replies.sort((a, b) => ts(a) - ts(b));
      n.replies.forEach(sortRec);
    };
    roots.sort((a, b) => ts(a) - ts(b));
    roots.forEach(sortRec);

    return { roots, focused_tweet_id: focusedId };
  }

  // Buttons X uses to reveal collapsed reply branches ("Show more replies",
  // "Show probable spam", etc.). Curated so we never hit action buttons like
  // Reply/Like. Matched case-insensitively against short button labels.
  // Only unambiguous reply-branch labels. Generic ones like "show more" /
  // "discover more" / "показать" are intentionally excluded — they also appear
  // on sidebar modules and navigate away from the thread.
  const EXPAND_PHRASES = [
    "show more replies", "more replies", "show replies",
    "show additional replies", "additional replies",
    "probable spam", "show probable spam", "offensive replies",
    "больше ответов", "ещё ответы", "еще ответы",
    "показать больше ответов", "показать ответы",
    "дополнительные ответы",
    "возможный спам", "вероятный спам", "оскорбительные ответы"
  ];

  function clickExpanders() {
    let clicked = 0;
    // Stay inside the conversation column; never the right sidebar.
    const main = document.querySelector("main") || document.body;
    // Buttons only — no <a> links, since clicking a link navigates away.
    const nodes = main.querySelectorAll('[role="button"], button');
    nodes.forEach((el) => {
      if (el.dataset.xtsExpanded) return;
      // Skip "Who to follow" / "Discover more" sidebar and any link-wrapped control.
      if (el.closest('[data-testid="sidebarColumn"]')) return;
      if (el.closest("a")) return;
      const txt = (el.textContent || "").trim().toLowerCase();
      if (!txt || txt.length > 40) return;
      const tid = el.getAttribute("data-testid") || "";
      // Never click compose/action/follow controls.
      if (/reply|tweetButton|like|retweet|bookmark|unretweet|follow/i.test(tid)) return;
      if (EXPAND_PHRASES.some((p) => txt.includes(p))) {
        el.dataset.xtsExpanded = "1";
        try { el.click(); clicked++; } catch (e) {}
      }
    });
    return clicked;
  }

  // Autoscroll tuned for a thread page: scrolls from top to bottom while
  // repeatedly expanding collapsed branches, until nothing new loads.
  async function collectThread(opts) {
    if (!focusedTweetId()) {
      setStatus("Открой отдельный твит (страницу треда).");
      return;
    }
    running = true;
    stopRequested = false;
    setStatus("Сбор треда...");

    // Start at the top so ancestors above the focused tweet get captured too.
    window.scrollTo(0, 0);
    await sleep(opts.delay);

    let idle = 0;
    let lastCount = threadTweets().length;
    let lastHeight = 0;
    let sameHeight = 0;

    while (!stopRequested) {
      clickExpanders();
      window.scrollBy(0, window.innerHeight * 0.9);
      await sleep(opts.delay);

      const h = pageHeight();
      if (h === lastHeight) sameHeight++;
      else { sameHeight = 0; lastHeight = h; }

      const c = threadTweets().length;
      if (c === lastCount) idle++;
      else { idle = 0; lastCount = c; }

      setStatus(`Тред: ${c} · холостых: ${idle}/${opts.maxIdle}`);

      if (idle >= opts.maxIdle && sameHeight >= 3) {
        window.scrollTo(0, pageHeight());
        await sleep(opts.delay * 1.5);
        const extra = clickExpanders();
        await sleep(opts.delay);
        if (threadTweets().length === lastCount && extra === 0) break;
        idle = 0;
        lastCount = threadTweets().length;
      }
    }

    running = false;
    setStatus(
      stopRequested
        ? `Тред остановлен. Собрано: ${threadTweets().length}`
        : `Тред собран: ${threadTweets().length}`
    );
    updateCount();
  }

  function exportThreadJSON() {
    if (!focusedTweetId()) {
      setStatus("Открой отдельный твит (страницу треда).");
      return;
    }
    const convId = currentConversationId();
    const fid = focusedTweetId();
    const tweets = threadTweets();
    if (!tweets.length) {
      setStatus("Тред пуст — сначала «Собрать тред».");
      return;
    }

    const tree = buildThreadTree(tweets, fid);
    const rootId = tree.roots.length ? tree.roots[0].tweet_id : convId || fid;
    const rootTweet = store.get(rootId);
    const handle = (rootTweet && rootTweet.username) || currentProfileHandle();

    const flat = tweets.slice().sort((a, b) => {
      return (Date.parse(a.created_at || "") || 0) -
             (Date.parse(b.created_at || "") || 0);
    });

    const payload = {
      meta: {
        source: "x-tweet-saver",
        version: "1.2.0",
        kind: "thread",
        conversation_id: convId,
        focused_tweet_id: fid,
        root_tweet_id: rootId,
        author: handle,
        url: location.href,
        exported_at: new Date().toISOString(),
        tweet_count: tweets.length
      },
      thread: tree.roots, // nested reply branches
      tweets: flat        // flat, chronological — for convenience
    };

    const stamp = new Date().toISOString().slice(0, 10);
    download(
      `thread_${handle}_${rootId}_${stamp}.json`,
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8"
    );
  }

  // Human-readable indented rendering — makes the branch structure obvious.
  function renderThreadNode(node, depth, lines) {
    const pad = "  ".repeat(depth);
    const who = node.username ? "@" + node.username : "(unknown)";
    const stats =
      `♥${node.favorite_count ?? 0} ↺${node.retweet_count ?? 0} ` +
      `💬${node.reply_count ?? 0} 👁${node.view_count ?? 0}`;
    const body = (node.text || "").replace(/\n+/g, " ");
    const link = `https://x.com/${node.username || "i"}/status/${node.tweet_id}`;
    lines.push(`${pad}${depth ? "↳ " : "● "}${who}  ·  ${node.created_at || ""}`);
    lines.push(`${pad}   ${body}`);
    lines.push(`${pad}   ${stats}  ${link}`);
    lines.push("");
    node.replies.forEach((c) => renderThreadNode(c, depth + 1, lines));
  }

  function exportThreadText() {
    if (!focusedTweetId()) {
      setStatus("Открой отдельный твит (страницу треда).");
      return;
    }
    const fid = focusedTweetId();
    const tweets = threadTweets();
    if (!tweets.length) {
      setStatus("Тред пуст — сначала «Собрать тред».");
      return;
    }
    const tree = buildThreadTree(tweets, fid);
    const rootId = tree.roots.length ? tree.roots[0].tweet_id : fid;
    const rootTweet = store.get(rootId);
    const handle = (rootTweet && rootTweet.username) || currentProfileHandle();

    const lines = [
      `Thread by @${handle} — ${tweets.length} tweets`,
      location.href,
      `exported: ${new Date().toISOString()}`,
      "=".repeat(60),
      ""
    ];
    tree.roots.forEach((r) => renderThreadNode(r, 0, lines));

    const stamp = new Date().toISOString().slice(0, 10);
    download(
      `thread_${handle}_${rootId}_${stamp}.txt`,
      lines.join("\n"),
      "text/plain;charset=utf-8"
    );
  }

  // ---------- video download ----------
  async function downloadVideo(tweetId, btn) {
    const info = videoIndex.get(tweetId);
    if (!info || !info.url) return;
    const handle = info.screen_name || "video";
    const fname = `${handle}_${tweetId}.mp4`;
    const oldLabel = btn ? btn.textContent : null;
    try {
      if (btn) { btn.textContent = "…"; btn.style.pointerEvents = "none"; }
      // Fetch as blob so the browser saves an .mp4 instead of navigating to it.
      const resp = await fetch(info.url, { credentials: "omit" });
      const blob = await resp.blob();
      download(fname, blob, "video/mp4");
      if (btn) btn.textContent = "✓";
    } catch (e) {
      // Fallback: open the direct mp4 in a new tab if fetch is blocked by CORS.
      window.open(info.url, "_blank");
      if (btn) btn.textContent = "↗";
    } finally {
      if (btn) {
        setTimeout(() => {
          btn.textContent = oldLabel || "⬇";
          btn.style.pointerEvents = "auto";
        }, 1500);
      }
    }
  }

  // Find the tweet_id for a given DOM node by locating the nearest /status/<id> link.
  function tweetIdForNode(node) {
    const article = node.closest("article");
    if (!article) return null;
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const m = a.getAttribute("href").match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  let decorateTimer = null;
  function scheduleDecorate() {
    if (decorateTimer) return;
    decorateTimer = setTimeout(() => {
      decorateTimer = null;
      decorateVideos();
    }, 400);
  }

  function decorateVideos() {
    // X renders videos inside a container with data-testid="videoComponent"
    // or a <video> tag. We attach a button to its offset parent.
    const vids = document.querySelectorAll(
      'div[data-testid="videoComponent"], video'
    );
    vids.forEach((v) => {
      const host =
        v.closest('[data-testid="videoComponent"]') ||
        v.parentElement;
      if (!host || host.querySelector(".xts-vdl")) return;

      const tid = tweetIdForNode(host);
      if (!tid) return;
      if (!videoIndex.has(tid)) return; // no mp4 known yet

      // Ensure the host can anchor an absolutely-positioned button.
      const cs = getComputedStyle(host);
      if (cs.position === "static") host.style.position = "relative";

      const btn = document.createElement("button");
      btn.className = "xts-vdl";
      btn.title = "Скачать видео";
      btn.textContent = "⬇";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        downloadVideo(tid, btn);
      };
      host.appendChild(btn);
    });
  }

  // ---------- UI panel ----------
  let panel, countEl, statusEl, styleEl;

  function injectStyles() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.textContent = `
      #xts-panel{position:fixed;top:80px;right:16px;z-index:2147483000;
        width:238px;background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;
        border-radius:12px;padding:14px;
        font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",monospace;
        box-shadow:0 8px 30px rgba(0,0,0,.55)}
      #xts-panel .hdr{display:flex;align-items:center;justify-content:space-between;
        margin-bottom:10px}
      #xts-panel .hdr h3{margin:0;font-size:12px;color:#f97316;letter-spacing:.08em;
        text-transform:uppercase;cursor:move;user-select:none}
      #xts-close{background:transparent;border:none;color:#64748b;cursor:pointer;
        font-size:16px;line-height:1;padding:2px 4px;border-radius:6px}
      #xts-close:hover{color:#f8fafc;background:#1e293b}
      #xts-panel .row{display:flex;gap:6px;margin-top:8px}
      #xts-panel button.act{flex:1;padding:7px 8px;border:none;border-radius:7px;
        font:600 11px/1 inherit;cursor:pointer;color:#fff}
      #xts-btn-start{background:#f97316}
      #xts-btn-stop{background:#475569}
      #xts-btn-export{background:#10b981}
      #xts-btn-clear{background:#334155}
      #xts-btn-thread{background:#6366f1}
      #xts-btn-thread-json{background:#0ea5e9}
      #xts-btn-thread-txt{background:#8b5cf6}
      #xts-panel .sep{margin-top:12px;padding-top:8px;border-top:1px solid #1e293b;
        font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.1em}
      #xts-panel .count{font-size:24px;font-weight:700;color:#f8fafc}
      #xts-panel .lbl{font-size:9px;color:#64748b;text-transform:uppercase;
        letter-spacing:.1em}
      #xts-panel .status{margin-top:8px;font-size:10px;color:#94a3b8;min-height:26px}

      button.xts-vdl{position:absolute;top:8px;right:8px;z-index:60;
        width:34px;height:34px;border-radius:50%;border:none;cursor:pointer;
        background:rgba(15,23,42,.82);color:#fff;font-size:15px;line-height:1;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 8px rgba(0,0,0,.4);transition:background .15s,transform .15s}
      button.xts-vdl:hover{background:#f97316;transform:scale(1.08)}
    `;
    document.documentElement.appendChild(styleEl);
  }

  function buildPanel() {
    if (panel) return;
    injectStyles();
    panel = document.createElement("div");
    panel.id = "xts-panel";
    panel.style.display = panelVisible ? "block" : "none";
    panel.innerHTML = `
      <div class="hdr">
        <h3 class="drag">Tweet Saver</h3>
        <button id="xts-close" title="Скрыть панель">✕</button>
      </div>
      <div class="lbl">Собрано твитов</div>
      <div class="count" id="xts-count">0</div>
      <div class="row">
        <button class="act" id="xts-btn-start">Старт</button>
        <button class="act" id="xts-btn-stop">Стоп</button>
      </div>
      <div class="row">
        <button class="act" id="xts-btn-export">Скачать JSON</button>
      </div>
      <div class="sep">Тред (страница твита)</div>
      <div class="row">
        <button class="act" id="xts-btn-thread">Собрать тред</button>
      </div>
      <div class="row">
        <button class="act" id="xts-btn-thread-json">Тред → JSON</button>
        <button class="act" id="xts-btn-thread-txt">Тред → TXT</button>
      </div>
      <div class="row">
        <button class="act" id="xts-btn-clear">Очистить</button>
      </div>
      <div class="status" id="xts-status">Профиль: «Старт» → «Скачать JSON».
        Отдельный твит: «Собрать тред» → «Тред → JSON/TXT».
        Видео — кнопкой ⬇ на ролике.</div>
    `;
    document.body.appendChild(panel);

    countEl = panel.querySelector("#xts-count");
    statusEl = panel.querySelector("#xts-status");
    updateCount();

    panel.querySelector("#xts-close").onclick = hidePanel;
    panel.querySelector("#xts-btn-start").onclick = () => {
      if (!running) autoScroll({ delay: 1200, maxIdle: 5 });
    };
    panel.querySelector("#xts-btn-stop").onclick = () => { stopRequested = true; };
    panel.querySelector("#xts-btn-export").onclick = () => {
      if (store.size === 0) { setStatus("Нечего экспортировать."); return; }
      exportJSON();
    };
    panel.querySelector("#xts-btn-thread").onclick = () => {
      if (!running) collectThread({ delay: 1200, maxIdle: 8 });
    };
    panel.querySelector("#xts-btn-thread-json").onclick = () => exportThreadJSON();
    panel.querySelector("#xts-btn-thread-txt").onclick = () => exportThreadText();
    panel.querySelector("#xts-btn-clear").onclick = () => {
      store.clear();
      updateCount();
      setStatus("Хранилище очищено.");
    };

    makeDraggable(panel, panel.querySelector(".drag"));
  }

  function showPanel() {
    if (!panel) buildPanel();
    panelVisible = true;
    if (panel) panel.style.display = "block";
  }
  function hidePanel() {
    panelVisible = false;
    if (panel) panel.style.display = "none";
  }
  function togglePanel() {
    if (panelVisible) hidePanel();
    else showPanel();
  }

  function updateCount() { if (countEl) countEl.textContent = String(store.size); }
  function setStatus(s) { if (statusEl) statusEl.textContent = s; }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = ox + (e.clientX - sx) + "px";
      el.style.top = oy + (e.clientY - sy) + "px";
      el.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (dragging = false));
  }

  // ---------- init ----------
  function init() {
    injectStyles();
    // Panel exists in DOM but stays hidden until the icon is clicked.
    buildPanel();
    // Watch the timeline for new video cards to decorate.
    const mo = new MutationObserver(() => scheduleDecorate());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    scheduleDecorate();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
