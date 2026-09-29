// Самоперезагрузка распакованного расширения при изменении его файлов на диске.
//
// Расширение стоит «Загрузить распакованное» из папки репозитория, а Chrome/Vivaldi сами
// не замечают правок. Раз в минуту (chrome.alarms — переживает засыпание service worker)
// сверяем хеш своих файлов; изменились (git pull / правка / новый коммит) — перезагружаемся
// и подхватываем новый код. Иконки не отслеживаются: они меняются редко.
//
// Подключение: importScripts("autoreload.js") в начале background.js + разрешение "alarms".
// Для распакованного расширения работает; для расширения из стора/CRX файлы неизменны — проверка
// просто ничего не находит.

(() => {
  const ALARM = "self-reload-check";
  const STORAGE_KEY = "selfReloadFingerprint";
  // Список файлов пакета: правьте под расширение. Сам autoreload.js тоже отслеживается.
  const WATCHED = [
    "manifest.json", "background.js", "autoreload.js", "content.js", "interceptor.js",
  ];

  // Диагностика: какую версию манифеста браузер реально запустил (обновляется при каждом
  // старте worker'а; после самоперезагрузки показывает новую версию).
  chrome.storage.local.set({ loadedVersion: chrome.runtime.getManifest().version, loadedAt: Date.now() });

  async function fingerprint() {
    const parts = [];
    for (const name of WATCHED) {
      const resp = await fetch(chrome.runtime.getURL(name), { cache: "no-store" });
      parts.push(name + "\n" + (await resp.text()));
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n\u0000\n")));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function check() {
    try {
      const current = await fingerprint();
      const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (stored === current) return;
      // Сначала запоминаем новый хеш, потом перезагружаемся: иначе после reload зациклимся.
      await chrome.storage.local.set({ [STORAGE_KEY]: current });
      if (stored) chrome.runtime.reload(); // первый запуск (stored пуст) только запоминает
    } catch (_) {
      // файл недоступен (например, mid-write при git checkout) — повторим на следующей минуте
    }
  }

  // Не пересоздаём будильник при каждом пробуждении worker'а — иначе сбросится его таймер.
  chrome.alarms.get(ALARM, (existing) => {
    if (!existing) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) check();
  });
  chrome.runtime.onInstalled.addListener(check);
  chrome.runtime.onStartup.addListener(check);
})();
