/**
 * Crumb Search Pages Function (middleware).
 *
 * This handles two things for the static SPA:
 *
 * 1. SPA routing. The site has two shells — index.html (in-person, served at "/") and
 *    virtual.html (served at "/virtual"). Any deep link that doesn't map to a real file
 *    must render the right shell so the widget's History router can boot and read the
 *    path. (This replaces the old site/_redirects `/* -> /index.html` and
 *    `/virtual/* -> /virtual` rewrites: on Cloudflare Pages, _redirects run BEFORE
 *    Functions, so those rules would short-circuit this middleware and prevent the
 *    per-meeting unfurl below.)
 *
 * 2. Link unfurls. Slack / iMessage / Signal / etc. fetch the raw HTML and read <meta>
 *    tags; they do not run the widget's JavaScript. So for meeting-detail deep links we
 *    fetch that one meeting from the BMLT server and inject per-meeting Open Graph /
 *    Twitter tags into the shell. Any failure falls back to the shell's default card.
 */

const DEFAULT_SERVER = 'https://aggregator.bmltenabled.org/main_server/';
const SITE_NAME = 'Crumb Search';
const ORG = 'Narcotics Anonymous';
// Meeting pages share one branded title; the meeting's own name + time lead the description.
const MEETING_TITLE = `${ORG} Meetings - ${SITE_NAME}`;
const FETCH_TIMEOUT_MS = 3000;

const WEEKDAYS = ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VENUE_VIRTUAL = 2;
const VENUE_HYBRID = 3;

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  // Which shell does this path belong to?
  const wantsVirtual = url.pathname === '/virtual' || url.pathname.startsWith('/virtual/');
  const shellPath = wantsVirtual ? '/virtual' : '/';

  const id = request.method === 'GET' ? meetingIdFromPath(url.pathname) : null;

  // Meeting deep link: serve the shell with per-meeting unfurl tags injected.
  if (id) {
    try {
      const shell = await env.ASSETS.fetch(new URL(shellPath, url.origin));
      const contentType = shell.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) return shell;

      const meeting = await fetchMeeting(env, id);
      if (!meeting) return shell; // graceful: correct shell, default card

      const meta = buildMeta(meeting, url);
      // Strip any default OG/Twitter/description tags from the shell, then append the
      // per-meeting ones, so crawlers (which use the first occurrence) see only ours.
      return new HTMLRewriter()
        .on('title', new TitleSetter(meta.title))
        .on('meta[property^="og:"]', new Remover())
        .on('meta[name^="twitter:"]', new Remover())
        .on('meta[name="description"]', new Remover())
        .on('head', new HeadInjector(meta.tags))
        .transform(shell);
    } catch {
      // fall through to normal handling below
    }
  }

  // Non-meeting request. Real files (and the shell URLs themselves) are served as-is;
  // any other path is an SPA route and renders the appropriate shell (index.html or
  // virtual.html) so the widget's History router can boot and read the path.
  const isFile = /\.[a-z0-9]+$/i.test(url.pathname);
  const isShell = url.pathname === '/' || url.pathname === '/virtual';
  if (isFile || isShell) {
    return next();
  }
  return env.ASSETS.fetch(new URL(shellPath, url.origin));
}

/** Extract the trailing numeric meeting id from a slug path (mirrors the widget's meetingIdFromPath). */
function meetingIdFromPath(pathname) {
  const match = pathname.replace(/\/+$/, '').match(/-(\d+)$/);
  return match ? match[1] : null;
}

async function fetchMeeting(env, id) {
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
  const title = MEETING_TITLE;
  const description = buildDescription(meeting);
  const pageUrl = url.href;
  const image = `${url.origin}/og-image.png`;

  const tag = (attr, key, value) => `<meta ${attr}="${escapeAttr(key)}" content="${escapeAttr(value)}">`;
  const tags =
    `\n<meta name="description" content="${escapeAttr(description)}">` +
    tag('property', 'og:type', 'website') +
    tag('property', 'og:site_name', SITE_NAME) +
    tag('property', 'og:title', title) +
    tag('property', 'og:description', description) +
    tag('property', 'og:url', pageUrl) +
    tag('property', 'og:image', image) +
    tag('property', 'og:image:width', '1200') +
    tag('property', 'og:image:height', '630') +
    tag('name', 'twitter:card', 'summary_large_image') +
    tag('name', 'twitter:title', title) +
    tag('name', 'twitter:description', description) +
    tag('name', 'twitter:image', image) +
    '\n';

  return { title, tags };
}

function buildDescription(meeting) {
  const name = (meeting.meeting_name || '').trim() || 'Meeting';
  const parts = [name];

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

class Remover {
  element(element) {
    element.remove();
  }
}
