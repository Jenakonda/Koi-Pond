(function (root) {
  'use strict';

  const KoiPond = (root.KoiPond = root.KoiPond || {});

  const LANGUAGES = Object.freeze(['en', 'uk']);

  // Strings of the control panel. Keys must exist in every language (a test checks this).
  // {name} placeholders are filled by t().
  const STRINGS = Object.freeze({
    en: {
      pageTitle: 'Koi Pond — Settings',
      brandSub: 'Pixel koi pond',
      enableTitle: 'Turn the pond on or off everywhere',
      enableAria: 'Enable the pond',
      languageAria: 'Language',
      loading: 'Loading…',
      siteOffHere: 'Turn off here',
      siteOnHere: 'Turn on here',
      siteAdd: 'Add site',
      siteRemove: 'Remove site',
      siteUnavailable: 'Unavailable',
      tabsAria: 'Settings sections',
      tabPond: 'Pond',
      tabSites: 'Sites',
      feed: 'Drop food',
      respawn: 'New school',
      fish: 'Fish',
      speed: 'Speed',
      visibility: 'Visibility',
      pixel: 'Pixel',
      pixelAria: 'Pixel size',
      pixelFine: 'Fine',
      pixelMedium: 'Medium',
      pixelLarge: 'Large',
      layer: 'Layer',
      layerAria: 'Page layer',
      layerSmart: 'Smart',
      layerBehind: 'Behind',
      layerTop: 'On top',
      cursor: 'Cursor',
      cursorAria: 'Cursor behavior',
      cursorFeed: 'Feed',
      cursorScare: 'Scare',
      cursorCalm: 'Calm',
      frames: 'Frames',
      framesAria: 'Frame rate',
      framesAuto: 'Auto',
      ripples: 'Water ripples',
      siteModeAria: 'Where the pond runs',
      siteModeBlacklist: 'Everywhere except list',
      siteModeWhitelist: 'Only on list',
      siteHintBlacklist: 'The pond runs everywhere except the listed sites.',
      siteHintWhitelist: 'The pond appears only on the listed sites.',
      sitePlaceholder: 'example.com',
      siteInputAria: 'Site address',
      siteAddButton: 'Add',
      siteListAria: 'Site list',
      siteEmptyBlacklist: 'The list is empty — the pond runs everywhere.',
      siteEmptyWhitelist: 'The list is empty — the pond runs nowhere. Add a site.',
      siteInvalid: 'Doesn’t look like a site address. Example: example.com',
      siteDuplicate: '{host} is already in the list',
      siteRemoveAria: 'Remove {host} from the list',
      hostSystemPage: 'Browser system page',
      hostCurrentPage: 'Current page',
      stateUnavailable: 'Pond unavailable here',
      stateOffEverywhere: 'Off everywhere',
      stateNotWhitelisted: 'Not on the whitelist',
      stateBlacklisted: 'Off on this site',
      stateReload: 'Reload the tab (F5) to connect',
      statePaused: 'Not enough room — pond paused',
      stateActive: 'Pond active',
      hintBehind: 'Behind: visible only on transparent areas and margins',
      hintTop: 'On top: clicks pass through the fish',
      hintFeed: 'Click a free spot on the page to feed the fish',
      hintScare: 'Move the cursor to scatter the fish',
      hintCalm: 'Calm viewing mode',
    },
    uk: {
      pageTitle: 'Koi Pond — Налаштування',
      brandSub: 'Піксельні коропи коі',
      enableTitle: 'Увімкнути або вимкнути ставок усюди',
      enableAria: 'Увімкнути ставок',
      languageAria: 'Мова',
      loading: 'Завантаження…',
      siteOffHere: 'Вимкнути тут',
      siteOnHere: 'Увімкнути тут',
      siteAdd: 'Додати сайт',
      siteRemove: 'Прибрати сайт',
      siteUnavailable: 'Недоступно',
      tabsAria: 'Розділи налаштувань',
      tabPond: 'Ставок',
      tabSites: 'Сайти',
      feed: 'Кинути корм',
      respawn: 'Нова зграйка',
      fish: 'Рибок',
      speed: 'Швидкість',
      visibility: 'Видимість',
      pixel: 'Піксель',
      pixelAria: 'Розмір пікселя',
      pixelFine: 'Дрібний',
      pixelMedium: 'Середній',
      pixelLarge: 'Великий',
      layer: 'Шар',
      layerAria: 'Шар на сторінці',
      layerSmart: 'Розумний',
      layerBehind: 'Позаду',
      layerTop: 'Поверх',
      cursor: 'Курсор',
      cursorAria: 'Реакція на курсор',
      cursorFeed: 'Годувати',
      cursorScare: 'Лякати',
      cursorCalm: 'Спокій',
      frames: 'Кадри',
      framesAria: 'Частота кадрів',
      framesAuto: 'Авто',
      ripples: 'Кола на воді',
      siteModeAria: 'Де працює ставок',
      siteModeBlacklist: 'Усюди, крім списку',
      siteModeWhitelist: 'Лише зі списку',
      siteHintBlacklist: 'Ставок працює всюди, крім сайтів зі списку.',
      siteHintWhitelist: 'Ставок з’являється лише на сайтах зі списку.',
      sitePlaceholder: 'example.com',
      siteInputAria: 'Адреса сайту',
      siteAddButton: 'Додати',
      siteListAria: 'Список сайтів',
      siteEmptyBlacklist: 'Список порожній — ставок працює всюди.',
      siteEmptyWhitelist: 'Список порожній — ставок ніде не працює. Додайте перший сайт.',
      siteInvalid: 'Не схоже на адресу сайту. Приклад: example.com',
      siteDuplicate: '{host} уже є у списку',
      siteRemoveAria: 'Прибрати {host} зі списку',
      hostSystemPage: 'Системна сторінка браузера',
      hostCurrentPage: 'Поточна сторінка',
      stateUnavailable: 'Тут ставок недоступний',
      stateOffEverywhere: 'Вимкнено всюди',
      stateNotWhitelisted: 'Немає в білому списку',
      stateBlacklisted: 'Вимкнено на цьому сайті',
      stateReload: 'Оновіть вкладку (F5), щоб підключити',
      statePaused: 'Замало місця — ставок на паузі',
      stateActive: 'Ставок активний',
      hintBehind: 'Позаду: видно лише на прозорому фоні та полях',
      hintTop: 'Поверх сторінки: кліки проходять крізь рибок',
      hintFeed: 'Клікайте по вільному місцю сторінки, щоб підгодувати рибок',
      hintScare: 'Рухайте курсором — рибки розпливатимуться',
      hintCalm: 'Спокійний режим споглядання',
    },
  });

  // 'auto' follows the browser: Ukrainian for uk-*, English for everything else
  function resolveLanguage(setting, browserLanguage) {
    if (LANGUAGES.includes(setting)) return setting;
    return typeof browserLanguage === 'string' && browserLanguage.toLowerCase().startsWith('uk') ? 'uk' : 'en';
  }

  function translate(language, key, params) {
    const table = STRINGS[language] || STRINGS.en;
    let text = table[key];
    if (text === undefined) text = STRINGS.en[key];
    if (text === undefined) return key;
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined ? String(params[name]) : m));
    }
    return text;
  }

  KoiPond.LANGUAGES = LANGUAGES;
  KoiPond.STRINGS = STRINGS;
  KoiPond.resolveLanguage = resolveLanguage;
  KoiPond.translate = translate;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LANGUAGES, STRINGS, resolveLanguage, translate };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
