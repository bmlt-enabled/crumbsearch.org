/**
 * Crumb Search edge worker.
 *
 * The site is otherwise a static SPA (see wrangler.jsonc `assets` + site/_redirects).
 * This worker exists for ONE reason: link unfurls. Slack / iMessage / Signal / etc.
 * fetch the raw HTML and read <meta> tags; they do not run the widget's JavaScript, so
 * a shared deep link to a specific meeting would otherwise unfurl with the generic
 * homepage title. For meeting-detail paths we fetch that one meeting from the BMLT
 * server and inject per-meeting Open Graph / Twitter tags into the served HTML.
 *
 * Everything else (routing, _redirects, clean URLs, static files) is left to the
 * static-assets pipeline via env.ASSETS.fetch(). Any error here falls back to it, so
 * the worst case is simply the pre-existing behavior with no custom unfurl.
 */

const DEFAULT_SERVER = 'https://aggregator.bmltenabled.org/main_server/';
const SITE_NAME = 'Crumb Search';
const ORG = 'Narcotics Anonymous';
const FETCH_TIMEOUT_MS = 3000;

const WEEKDAYS = ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VENUE_VIRTUAL = 2;
const VENUE_HYBRID = 3;

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch {
      // Never let the unfurl logic take the site down.
      return env.ASSETS.fetch(request);
    }
  }
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const id = meetingIdFromPath(url.pathname);

  // Only meeting-detail GETs get special treatment; everything else is normal.
  if (request.method !== 'GET' || !id) {
    return env.ASSETS.fetch(request);
  }

  // Serve the same HTML shell the SPA would get for this path, so the widget still
  // boots and selects the meeting client-side once JS runs.
  const basePath = url.pathname.startsWith('/virtual/') ? '/virtual' : '/';
  const assetResponse = await env.ASSETS.fetch(new Request(new URL(basePath, url.origin), request));

  const contentType = assetResponse.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return assetResponse;
  }

  const meeting = await fetchMeeting(env, id, ctx);
  if (!meeting) {
    return assetResponse; // graceful: generic unfurl, widget still works
  }

  const meta = buildMeta(meeting, url);
  return new HTMLRewriter()
    .on('title', new TitleSetter(meta.title))
    .on('head', new HeadInjector(meta.tags))
    .transform(assetResponse);
}

/** Extract the trailing numeric meeting id from a slug path (mirrors the widget's meetingIdFromPath). */
function meetingIdFromPath(pathname) {
  const match = pathname.replace(/\/+$/, '').match(/-(\d+)$/);
  return match ? match[1] : null;
}

async function fetchMeeting(env, id, ctx) {
  const server = (env && env.BMLT_SERVER) || DEFAULT_SERVER;
  const base = server.endsWith('/') ? server : server + '/';
  const fields = 'meeting_name,weekday_tinyint,start_time,duration_time,location_municipality,location_province,venue_type,time_zone';
  const endpoint = `${base}client_interface/json/?switcher=GetSearchResults&meeting_ids[]=${encodeURIComponent(id)}&data_field_key=${fields}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      signal: controller.signal,
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildMeta(meeting, url) {
  const name = (meeting.meeting_name || '').trim() || 'Meeting';
  const title = `${name} · ${SITE_NAME}`;
  const description = buildDescription(meeting);
  const pageUrl = url.href;
  const image = `${url.origin}/favicon.svg`;

  const tag = (attr, key, value) => `<meta ${attr}="${escapeAttr(key)}" content="${escapeAttr(value)}">`;
  const tags =
    `\n<meta name="description" content="${escapeAttr(description)}">` +
    tag('property', 'og:type', 'website') +
    tag('property', 'og:site_name', SITE_NAME) +
    tag('property', 'og:title', title) +
    tag('property', 'og:description', description) +
    tag('property', 'og:url', pageUrl) +
    tag('property', 'og:image', image) +
    tag('name', 'twitter:card', 'summary') +
    tag('name', 'twitter:title', title) +
    tag('name', 'twitter:description', description) +
    '\n';

  return { title, tags };
}

function buildDescription(meeting) {
  const parts = [`${ORG} meeting`];

  const day = WEEKDAYS[Number(meeting.weekday_tinyint)] || '';
  const time = formatTime(meeting.start_time);
  if (day && time) {
    const abbr = tzAbbr(meeting.time_zone);
    parts.push(`${day}s at ${time}${abbr ? ' ' + abbr : ''}`);
  }

  const venue = Number(meeting.venue_type);
  const city = (meeting.location_municipality || '').trim();
  const state = (meeting.location_province || '').trim();
  const place = [city, state].filter(Boolean).join(', ');
  if (venue === VENUE_VIRTUAL) {
    parts.push('Online');
  } else if (venue === VENUE_HYBRID) {
    parts.push(place ? `Online & in ${place}` : 'Online & in person');
  } else if (place) {
    parts.push(place);
  }

  return parts.join(' · ');
}

/** "18:00:00" -> "6:00 PM" */
function formatTime(start) {
  if (!start) return '';
  const [h, m] = start.split(':');
  let hour = Number(h);
  const minute = m ?? '00';
  if (Number.isNaN(hour)) return '';
  const period = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}

/** Friendly time-zone abbreviation (e.g. "EST", "MDT") for an IANA zone, or '' if unknown. */
function tzAbbr(timeZone) {
  if (!timeZone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short'
    }).formatToParts(new Date());
    const found = parts.find((p) => p.type === 'timeZoneName');
    return found ? found.value : '';
  } catch {
    return '';
  }
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

class TitleSetter {
  constructor(value) {
    this.value = value;
  }
  element(element) {
    element.setInnerContent(this.value);
  }
}

class HeadInjector {
  constructor(html) {
    this.html = html;
  }
  element(element) {
    element.append(this.html, { html: true });
  }
}
