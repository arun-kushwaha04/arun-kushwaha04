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

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const COMMIT_LIMIT = Number(process.env.COMMIT_LIMIT || 7);
const README_PATH = resolve(process.env.README_PATH || "README.md");
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

const BOX_WIDTH = 50;

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

function pad(str, width) {
  const s = String(str);
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function boxLine(inner, width = BOX_WIDTH) {
  return `│ ${pad(inner, width)} │`;
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
  const nowPlaying = first?.["@attr"]?.nowplaying === "true";

  return {
    status: "ok",
    nowPlaying,
    name: sanitizeMarkdown(name),
    artist: sanitizeMarkdown(artist),
  };
}

function renderMusic(track) {
  const width = BOX_WIDTH;
  const top = `┌${"─".repeat(width + 2)}┐`;
  const bot = `└${"─".repeat(width + 2)}┘`;
  const bar = "━".repeat(width);

  let title;
  let body;

  if (track.status === "unconfigured") {
    title = "♪ music";
    body = [
      "waiting for last.fm scrobbles…",
      "set LASTFM_USERNAME + LASTFM_API_KEY to enable",
    ];
  } else if (track.status === "empty") {
    title = "♪ recently played";
    body = ["no recent scrobbles"];
  } else {
    title = track.nowPlaying ? "♪ NOW PLAYING" : "♪ RECENTLY PLAYED";
    body = [`${track.name} — ${track.artist}`];
  }

  const lines = [
    top,
    boxLine(title, width),
    boxLine("", width),
    ...body.map((b) => boxLine(b, width)),
    boxLine("", width),
    boxLine(bar, width),
    bot,
  ];

  return ["```text", ...lines, "```"].join("\n");
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
  console.log(`music: ${track.status}${track.name ? ` — ${track.name}` : ""}`);
  const musicBlock = renderMusic(track);

  let next = replaceMarkedSection(
    readme,
    COMMITS_START,
    COMMITS_END,
    commitsBlock,
  );
  next = replaceMarkedSection(next, MUSIC_START, MUSIC_END, musicBlock);

  if (next === readme) {
    console.log("README unchanged — skipping write");
    return;
  }

  if (DRY_RUN) {
    console.log("--- commits ---");
    console.log(commitsBlock);
    console.log("--- music ---");
    console.log(musicBlock);
    console.log("DRY_RUN=1 — not writing README");
    return;
  }

  writeFileSync(README_PATH, next, "utf8");
  console.log(`updated ${README_PATH}`);
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
