#!/usr/bin/env node
/**
 * Updates dynamic sections in README.md:
 *   - recent public commits  (<!-- COMMITS:START --> … <!-- COMMITS:END -->)
 *   - Last.fm now/recent play (<!-- MUSIC:START --> … <!-- MUSIC:END -->)
 *
 * Env (GitHub Actions):
 *   GITHUB_REPOSITORY_OWNER  – profile username (auto)
 *   GITHUB_TOKEN             – API auth (auto)
 *   LASTFM_USERNAME          – Last.fm username (required for music)
 *   LASTFM_API_KEY           – Last.fm API key  (required for music)
 *
 * Optional:
 *   COMMIT_LIMIT             – max commits to render (default 7)
 *   README_PATH              – path to README (default ./README.md)
 *   DRY_RUN=1                – print sections, do not write
 *
 * Music path: YouTube Music → Last.fm scrobbling → this script → README
 * Get an API key at https://www.last.fm/api/account/create (free).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_LIMIT = Number(process.env.COMMIT_LIMIT || 7);
const README_PATH = resolve(process.env.README_PATH || "README.md");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW_PLAYING_SVG = resolve(
  process.env.NOW_PLAYING_SVG || `${ROOT}/assets/now-playing.svg`,
);
const OWNER =
  process.env.GITHUB_REPOSITORY_OWNER ||
  process.env.GITHUB_ACTOR ||
  "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const LASTFM_USERNAME = process.env.LASTFM_USERNAME || "";
const LASTFM_API_KEY = process.env.LASTFM_API_KEY || "";
const DRY_RUN = process.env.DRY_RUN === "1";

const COMMITS_START = "<!-- COMMITS:START -->";
const COMMITS_END = "<!-- COMMITS:END -->";
const MUSIC_START = "<!-- MUSIC:START -->";
const MUSIC_END = "<!-- MUSIC:END -->";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function sanitizeMarkdown(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split("\n")[0]
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'");
}

function escapeAttr(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pad(str, width) {
  const s = String(str);
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function truncate(str, max) {
  const s = String(str);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function pickLastfmImage(images) {
  if (!Array.isArray(images)) return "";
  const bySize = Object.fromEntries(
    images.map((img) => [img?.size, img?.["#text"] || ""]),
  );
  return (
    bySize.extralarge ||
    bySize.large ||
    bySize.medium ||
    bySize.small ||
    ""
  );
}

async function fetchCoverDataUri(imageUrl) {
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "profile-readme-updater" },
    });
    if (!res.ok) {
      console.warn(`warn: cover fetch HTTP ${res.status}`);
      return null;
    }
    const ctype = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!ctype.startsWith("image/")) {
      console.warn(`warn: cover content-type not image: ${ctype}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32 || buf.length > 2_500_000) {
      console.warn(`warn: cover size odd (${buf.length} bytes)`);
      return null;
    }
    return `data:${ctype};base64,${buf.toString("base64")}`;
  } catch (err) {
    console.warn(`warn: cover fetch failed: ${err.message || err}`);
    return null;
  }
}

async function githubFetch(path, { accept = "application/vnd.github+json", soft = false } = {}) {
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const headers = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "profile-readme-updater",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(url, { headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    const msg = `GitHub API returned non-JSON for ${url} (HTTP ${res.status})`;
    if (soft) throw new Error(msg);
    fail(msg);
  }

  if (!res.ok) {
    const msg = `GitHub API ${res.status} for ${url}: ${body?.message || text.slice(0, 200)}`;
    if (soft) throw new Error(msg);
    fail(msg);
  }
  return body;
}

async function fetchCommitDetails(repoFullName, sha) {
  const commit = await githubFetch(`/repos/${repoFullName}/commits/${sha}`, {
    soft: true,
  });
  if (!commit?.sha || !commit?.commit?.message) {
    throw new Error(`Unexpected commit payload for ${repoFullName}@${sha}`);
  }
  return {
    sha: commit.sha,
    message: commit.commit.message,
    htmlUrl:
      commit.html_url ||
      `https://github.com/${repoFullName}/commit/${commit.sha}`,
    repo: repoFullName,
  };
}

/**
 * Recent public pushes → resolve head SHAs via the Commits API.
 * PushEvent payloads no longer embed commit summaries (GitHub change, Oct 2025).
 */
async function commitsFromEvents(username) {
  const events = await githubFetch(
    `/users/${encodeURIComponent(username)}/events/public?per_page=100`,
  );
  if (!Array.isArray(events)) {
    fail("Unexpected events response: expected an array");
  }

  const heads = [];
  const seen = new Set();

  for (const event of events) {
    if (event?.type !== "PushEvent") continue;
    const repo = event?.repo?.name;
    const head = event?.payload?.head;
    if (!repo || !head) continue;
    const key = `${repo}@${head}`;
    if (seen.has(key)) continue;
    seen.add(key);
    heads.push({ repo, sha: head });
    if (heads.length >= COMMIT_LIMIT * 2) break;
  }

  const commits = [];
  for (const { repo, sha } of heads) {
    if (commits.length >= COMMIT_LIMIT) break;
    try {
      const detail = await fetchCommitDetails(repo, sha);
      if (commits.some((c) => c.sha === detail.sha)) continue;
      commits.push(detail);
    } catch (err) {
      console.warn(
        `warn: skip ${repo}@${String(sha).slice(0, 7)}: ${err.message || err}`,
      );
    }
  }
  return commits;
}

/** Fallback when the events feed is empty or aged out (~90 days). */
async function commitsFromSearch(username) {
  const data = await githubFetch(
    `/search/commits?q=${encodeURIComponent(`author:${username}`)}&sort=author-date&order=desc&per_page=${COMMIT_LIMIT}`,
  );
  if (!data || !Array.isArray(data.items)) {
    fail("Unexpected commit search response");
  }

  const commits = [];
  const seen = new Set();
  for (const item of data.items) {
    const sha = item?.sha;
    const message = item?.commit?.message;
    const repo = item?.repository?.full_name;
    if (!sha || !message || !repo) continue;
    if (seen.has(sha)) continue;
    seen.add(sha);
    commits.push({
      sha,
      message,
      htmlUrl: item.html_url || `https://github.com/${repo}/commit/${sha}`,
      repo,
    });
    if (commits.length >= COMMIT_LIMIT) break;
  }
  return commits;
}

async function fetchRecentCommits(username) {
  let commits = await commitsFromEvents(username);
  if (commits.length < COMMIT_LIMIT) {
    const more = await commitsFromSearch(username);
    const seen = new Set(commits.map((c) => c.sha));
    for (const c of more) {
      if (seen.has(c.sha)) continue;
      commits.push(c);
      if (commits.length >= COMMIT_LIMIT) break;
    }
  }
  return commits.slice(0, COMMIT_LIMIT);
}

function renderCommitsBlock(commits) {
  if (!commits.length) {
    return "```text\n(no recent public commits)\n```";
  }

  // Terminal-like git log with clickable SHAs (HTML <pre> keeps monospace + links).
  const msgWidth = 44;
  const lines = commits.map((c) => {
    const short = c.sha.slice(0, 7);
    const msg = sanitizeMarkdown(c.message);
    const clipped =
      msg.length > msgWidth ? `${msg.slice(0, msgWidth - 1)}…` : msg;
    const padded = pad(clipped, msgWidth);
    const repo = c.repo || "";
    const shaLink = `<a href="${escapeAttr(c.htmlUrl)}"><code>${short}</code></a>`;
    const repoPart = repo
      ? `  <i>${sanitizeMarkdown(repo)}</i>`
      : "";
    return `${shaLink}  ${padded}${repoPart}`;
  });

  return `<pre>\n${lines.join("\n")}\n</pre>`;
}

async function fetchLastfmTrack() {
  if (!LASTFM_USERNAME || !LASTFM_API_KEY) {
    return { status: "unconfigured" };
  }

  const url =
    `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks` +
    `&user=${encodeURIComponent(LASTFM_USERNAME)}` +
    `&api_key=${encodeURIComponent(LASTFM_API_KEY)}` +
    `&limit=1&format=json`;

  const res = await fetch(url, {
    headers: { "User-Agent": "profile-readme-updater" },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`Last.fm returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    fail(`Last.fm HTTP ${res.status}: ${body?.message || text.slice(0, 200)}`);
  }
  if (body?.error) {
    fail(`Last.fm API error ${body.error}: ${body.message || "unknown"}`);
  }

  const track = body?.recenttracks?.track;
  const first = Array.isArray(track) ? track[0] : track;
  if (!first) {
    return { status: "empty" };
  }

  const name = first.name || "Unknown track";
  const artist =
    typeof first.artist === "string"
      ? first.artist
      : first.artist?.["#text"] || "Unknown artist";
  const album =
    typeof first.album === "string"
      ? first.album
      : first.album?.["#text"] || "";
  const nowPlaying = first?.["@attr"]?.nowplaying === "true";
  const playedAt = first.date?.uts || "";
  const imageUrl = pickLastfmImage(first.image);
  const coverDataUri = await fetchCoverDataUri(imageUrl);
  const trackUrl = first.url || "";

  return {
    status: "ok",
    nowPlaying,
    name: String(name).split("\n")[0].trim(),
    artist: String(artist).split("\n")[0].trim(),
    album: String(album).split("\n")[0].trim(),
    playedAt: String(playedAt).trim(),
    coverDataUri,
    trackUrl,
    imageUrl,
  };
}

function buildNowPlayingSvg(track) {
  const mono =
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  let label = "♪ MUSIC";
  let title = "waiting for last.fm…";
  let artist = "set LASTFM_USERNAME + LASTFM_API_KEY";
  let album = "";
  let coverHref = null;

  if (track.status === "empty") {
    label = "♪ RECENTLY PLAYED";
    title = "no recent scrobbles";
    artist = "queue something on youtube music";
  } else if (track.status === "ok") {
    label = track.nowPlaying ? "♪ NOW PLAYING" : "♪ RECENTLY PLAYED";
    title = truncate(track.name || "Unknown track", 42);
    artist = truncate(track.artist || "Unknown artist", 42);
    album = truncate(track.album || "", 42);
    coverHref = track.coverDataUri;
  }

  const cover = coverHref
    ? `<image href="${coverHref}" xlink:href="${coverHref}" x="20" y="48" width="96" height="96" preserveAspectRatio="xMidYMid slice" clip-path="url(#coverClip)"/>
       <rect x="20" y="48" width="96" height="96" rx="8" fill="none" stroke="#2a4a3c" stroke-width="1.5"/>`
    : `<rect x="20" y="48" width="96" height="96" rx="8" fill="#15241e" stroke="#2a4a3c" stroke-width="1.5"/>
       <text x="68" y="102" text-anchor="middle" fill="#3dd68c" font-family="${mono}" font-size="28">♪</text>`;

  const albumLine = album
    ? `<text x="136" y="128" fill="#7aa892" font-family="${mono}" font-size="12">${escapeXml(album)}</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="520" height="168" viewBox="0 0 520 168" role="img" aria-label="${escapeXml(label)}: ${escapeXml(title)} — ${escapeXml(artist)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1210"/>
      <stop offset="100%" stop-color="#101a16"/>
    </linearGradient>
    <clipPath id="coverClip">
      <rect x="20" y="48" width="96" height="96" rx="8"/>
    </clipPath>
  </defs>
  <rect width="520" height="168" rx="12" fill="url(#bg)" stroke="#1f3d32" stroke-width="2"/>
  <rect x="0" y="0" width="520" height="32" rx="12" fill="#15241e"/>
  <rect x="0" y="20" width="520" height="12" fill="#15241e"/>
  <circle cx="18" cy="16" r="5" fill="#ff5f56"/>
  <circle cx="34" cy="16" r="5" fill="#ffbd2e"/>
  <circle cx="50" cy="16" r="5" fill="#27c93f"/>
  <text x="260" y="20" text-anchor="middle" fill="#7aa892" font-family="${mono}" font-size="11">music — last.fm</text>

  ${cover}

  <text x="136" y="64" fill="#3dd68c" font-family="${mono}" font-size="12">${escapeXml(label)}</text>
  <text x="136" y="92" fill="#e6edf3" font-family="${mono}" font-size="16" font-weight="600">${escapeXml(title)}</text>
  <text x="136" y="114" fill="#8bdcad" font-family="${mono}" font-size="13">${escapeXml(artist)}</text>
  ${albumLine}

  <rect x="136" y="146" width="360" height="4" rx="2" fill="#1f3d32"/>
  <rect x="136" y="146" width="${track.status === "ok" && track.nowPlaying ? 220 : 120}" height="4" rx="2" fill="#3dd68c"/>
</svg>
`;
}

function musicCacheKey(track) {
  const data = [
    track.status || "",
    track.nowPlaying ? "now" : "recent",
    track.name || "",
    track.artist || "",
    track.album || "",
    track.playedAt || "",
  ].join("|");
  return Buffer.from(data).toString("base64url").slice(0, 18) || "lastfm";
}

function renderMusicBlock(track) {
  // Keep the SVG external, but version the URL so GitHub/browser caches refresh on track changes.
  const version = musicCacheKey(track);
  return `<p align="left">
  <img src="./assets/now-playing.svg?v=${version}" alt="now playing" width="520" />
</p>`;
}

function writeIfChanged(path, content) {
  if (existsSync(path)) {
    const prev = readFileSync(path, "utf8");
    if (prev === content) return false;
  }
  writeFileSync(path, content, "utf8");
  return true;
}

function replaceMarkedSection(readme, start, end, content) {
  const startIdx = readme.indexOf(start);
  const endIdx = readme.indexOf(end);
  if (startIdx === -1 || endIdx === -1) {
    fail(`README markers missing: ${start} / ${end}`);
  }
  if (endIdx < startIdx) {
    fail(`README markers out of order: ${start} / ${end}`);
  }
  const before = readme.slice(0, startIdx + start.length);
  const after = readme.slice(endIdx);
  return `${before}\n${content}\n${after}`;
}

async function main() {
  if (!OWNER) {
    fail("GITHUB_REPOSITORY_OWNER (or GITHUB_ACTOR) is required");
  }

  let readme;
  try {
    readme = readFileSync(README_PATH, "utf8");
  } catch {
    fail(`cannot read ${README_PATH}`);
  }

  for (const [a, b] of [
    [COMMITS_START, COMMITS_END],
    [MUSIC_START, MUSIC_END],
  ]) {
    if (!readme.includes(a) || !readme.includes(b)) {
      fail(`README markers missing: ${a} / ${b}`);
    }
  }

  console.log(`owner: ${OWNER}`);
  const commits = await fetchRecentCommits(OWNER);
  console.log(`commits: ${commits.length}`);
  const commitsBlock = renderCommitsBlock(commits);

  const track = await fetchLastfmTrack();
  console.log(
    `music: ${track.status}${track.name ? ` — ${track.name} / ${track.artist}` : ""}${track.coverDataUri ? " (cover)" : ""}`,
  );
  const musicSvg = buildNowPlayingSvg(track);
  const musicBlock = renderMusicBlock(track);

  let next = replaceMarkedSection(
    readme,
    COMMITS_START,
    COMMITS_END,
    commitsBlock,
  );
  next = replaceMarkedSection(next, MUSIC_START, MUSIC_END, musicBlock);

  const readmeChanged = next !== readme;
  const svgChanged = DRY_RUN
    ? musicSvg !== (existsSync(NOW_PLAYING_SVG) ? readFileSync(NOW_PLAYING_SVG, "utf8") : "")
    : writeIfChanged(NOW_PLAYING_SVG, musicSvg);

  if (!readmeChanged && !svgChanged) {
    console.log("README + now-playing.svg unchanged — skipping write");
    return;
  }

  if (DRY_RUN) {
    console.log("--- commits ---");
    console.log(commitsBlock);
    console.log("--- music block ---");
    console.log(musicBlock);
    console.log(`--- svg would ${svgChanged ? "change" : "stay"} (${NOW_PLAYING_SVG}) ---`);
    console.log("DRY_RUN=1 — not writing");
    return;
  }

  if (readmeChanged) {
    writeFileSync(README_PATH, next, "utf8");
    console.log(`updated ${README_PATH}`);
  }
  if (svgChanged) {
    console.log(`updated ${NOW_PLAYING_SVG}`);
  }
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
